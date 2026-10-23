# x86_64 NAS 跑 Android 侧车：完整操作手册

> 适用前提：NAS 是 Intel / AMD（你的是 **Pentium Gold 8505**），系统是**自建 Linux**
> （Debian / Ubuntu / Unraid / TrueNAS SCALE / PVE）。群晖 DSM、威联通 QTS 见第一节。
>
> 目标：让加固 spider 跑在 NAS 的容器里，浏览器这边照常播 m3u8。

## 一、先花 30 秒确认这件事能不能做

NAS 的系统类型直接决定成败，先对号入座：

| NAS 系统 | binder 内核驱动 | 结论 |
|---|---|---|
| Debian / Ubuntu / Unraid / PVE | 装上 `linux-modules-extra-$(uname -r)` 后 `modprobe binder_linux` 通常可用 | ✅ 往下看第二节 |
| TrueNAS SCALE | 同上，官方内核带 android drivers | ✅ 可试 |
| 群晖 DSM | 内核裁剪 + 模块签名校验，自编模块要绕过校验 | ❌ 不建议，投入产出比极低 |
| 威联通 QTS | 同上，且内核版本更老 | ❌ 不建议 |

一条命令出结论：

```bash
sudo bash sidecar/android/preflight.sh
```

它检查 binder、ashmem/memfd、binfmt、KVM、Docker 特权，末尾直接打印下一步该敲哪条命令。
**退出码 0 才继续**，非 0 说明这台机器跑不了 redroid，直接跳到第五节。

## 二、为什么 x86 上要多一层翻译

加固包的 native 库是 ARM 的：

```
assets/ftyguard_v7.so   ELF32 ARMv7     81,520 B
assets/ftyguard_v8.so   ELF64 AArch64  102,440 B
```

包里**没有** x86 版本。8505 的算力不是问题——侧车不渲染画面、不跑 GPU，只让 ART 执行
爬虫逻辑，720p5fps 的 redroid 对它是轻负载。真正的门槛只有两个：

1. **宿主内核有没有 `binder_linux`**（redroid 的硬依赖，绕不过）
2. **ARM 指令靠谁翻译**

翻译层有三种，能力不同：

| 方案 | 覆盖 ABI | 怎么来 |
|---|---|---|
| `libndk_translation` | arm64-v8a | ChromeOS ARC 的产物，已打包进 `erstt/redroid:*_ndk_*` |
| `libhoudini` | arm64-v8a + armeabi-v7a | Intel 专有，`erstt/redroid:*_houdini_*`，Intel 平台兼容性最好 |
| qemu-user（binfmt） | 全部 | 全系统模拟，ART 在 TCG 下极易崩，仅兜底 |

我们的 APK 同时带 `arm64-v8a` 与 `armeabi-v7a`，64 位进程优先取 arm64-v8a，
所以先试 NDK，失败换 Houdini。

## 三、五步跑起来

```bash
# 1. 宿主准备（每次重启都要做，建议写进 /etc/rc.local 或系统服务）
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe binfmt_misc
mkdir -p /dev/binderfs && sudo mount -t binder binder /dev/binderfs

# 2. 起容器（镜像已按 Intel 平台选好，见 compose 注释里的三级降级顺序）
docker compose -f sidecar/android/docker-compose.redroid-x86.yml up -d
docker logs -f novatv-redroid-x86        # 看到 adbd listening 就是起来了

# 3. 装 APK 并启动侧车（脚本与架构无关，直连容器 adbd）
bash sidecar/android/install-apk.sh 127.0.0.1 novatv123

# 4. 确认到底有没有走翻译 —— 这一步不能省
adb shell dumpsys package novatv.host | grep -i -E "primaryCpuAbi|secondaryCpuAbi"

# 5. NAS 端接上
#    .env 里加 SPIDER_ANDROID_URL=http://<侧车IP>:8899 与 SPIDER_TOKEN=novatv123
docker compose up -d
```

第 4 步的三种输出，含义完全不同：

| 输出 | 含义 | 动作 |
|---|---|---|
| `primaryCpuAbi=arm64-v8a` | 系统把它当 ARM 应用，走翻译层 | ✅ 正常，继续 |
| `primaryCpuAbi=x86_64` | 装成了 x86 变体，但 APK 里没有 x86 的 .so | 检查 APK 是否被改过 |
| 装的时候就报 `INSTALL_FAILED_NO_MATCHING_ABIS` | 镜像不带翻译层 | 换 `erstt/redroid:*_houdini_*` |
| 输出 `null` + 进程起不来 | 翻译层加载了但没跑通 | 看 `adb logcat \| grep -i -E "ndk\|houdini"` |

## 四、成功与否只看一个接口

容器能起来、APK 能装上，都不代表路走通了。**唯一判据是 `/health`**：

```bash
curl -s "http://127.0.0.1:8899/health?token=novatv123"
```

重点看两个字段：

```jsonc
{
  "libs": ["libftyguard_v7.so", "libftyguard_v8.so"],  // 空数组 = .so 没打进 APK
  "initErrors": {}                                      // 有 key = 加固壳解密失败
}
```

- `libs` 为空 → APK 打包问题，与 x86 无关，重新 `node scripts/extract-spider-libs.mjs` 再构建
- `initErrors` 里有 `dlopen` / `UnsatisfiedLinkError` → **翻译层跑不动加固壳的 native 校验**，
  这是架构问题，换 Houdini 镜像再试一次
- 两个都正常 → 再放一次真实搜索，能出 JSON 列表就真的通了

## 五、失败特征对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 容器启动即退出 | 缺 binder / 缺 binfmt_misc | `dmesg -T \| tail -30` 看具体缺失项 |
| `modprobe: FATAL: Module binder_linux not found` | 内核没编 android drivers | `apt install linux-modules-extra-$(uname -r)`；仍无则此机不可行 |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | 镜像无翻译层 | 换 `*_ndk_*` / `*_houdini_*` tag |
| 装上了但站点报 `ClassNotFound` | APK 未带宿主基类 | 用 `dist/novatv-host.apk`（已含 `com.github.catvod.crawler.Spider`） |
| `/health` 的 `initErrors` 有 `dlopen` 失败 | 翻译层跑不动 native 校验码 | 换 Houdini；仍失败说明这条路对该壳不通 |
| 搜索超时 / 进程反复崩溃 | 加固壳检测到模拟器特征 | 无解，只能换真机 |
| ART 冷启动极慢（分钟级） | 走了 qemu binfmt 而非 Native Bridge | 去掉 binfmt 的 arm64 注册，只用镜像自带翻译层 |

## 六、止损线：什么情况下该停手

容器这条路的不确定性集中在「加固壳反模拟器」上——这是壳的设计目标，不是配置能绕过的。
**给自己定个时限**：preflight 通过后投入 **1~2 小时**，如果卡在 `initErrors` 或搜索必崩，
就不要再调参数了，直接切真机：

```bash
# 任何一台 Android 7+ 的旧手机 / TV 盒子，插电放着
bash sidecar/android/install-apk.sh <手机IP> novatv123
```

真机的成功率是 100%（架构原生、无模拟器特征），容器是「可能成」。这不是能力差距，是壳的
检测逻辑决定的。所以值得先试容器（零硬件成本），但要设硬止损点。

## 七、架构分工（与成败无关，都该这么布）

主服务永远放在 8505 上，Android 侧车只是「dex 执行器」：

```
浏览器 ──► NAS(8505, :8890)  搜索聚合 / 详情 / m3u8 改写 / 分片代理 / 缓存
             │
             └─ HTTP ──► Android 侧车(:8899)  只做 dex 执行，返回 JSON
                         （redroid 容器 / 旧手机 / TV 盒子，可换）
```

理由：

- 聚合、转码、代理是**带宽和 IO 密集**的，8505 上跑正合适
- 侧车一次调用只传几 KB JSON，局域网往返 1~3 ms，不是瓶颈
- 两者用 HTTP 协议解耦（`SPIDER_ANDROID_URL` 一改就换设备），将来容器不行换手机零成本

## 八、当前状态

- `docker-compose.redroid-x86.yml`、`preflight.sh`、`install-apk.sh` **已在本机静态验证**，
  但 redroid 容器本身**未在真实 8505 NAS 上跑过**（开发机无 Docker），所以才有预检脚本。
- 镜像 tag 与 `command` 参数取自 redroid-doc 与 `erstt/redroid` 官方说明。
- `.so` 抽取已实测：`node scripts/extract-spider-libs.mjs` 按 ELF `e_machine` 落到
  `jniLibs/armeabi-v7a` 与 `jniLibs/arm64-v8a`，APK 产物 145 KB 含两个库。
