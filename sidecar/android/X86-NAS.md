# x86_64 NAS 跑 Android 侧车：完整操作手册

> 适用前提：NAS 是 Intel / AMD（你的是 **Pentium Gold 8505**）。
>
> 目标：让加固 spider 跑在 NAS 的容器里，浏览器这边照常播 m3u8。

## 〇、先分清两条路线（这是最容易走错的地方）

「在 NAS 的 Docker 里跑 Android」有两种完全不同的实现，门槛也不同：

| | **路线 A：redroid** | **路线 B：QEMU 虚拟机** |
|---|---|---|
| 本质 | **容器化** Android，共享宿主内核 | **虚拟机**里的 Android，自带内核 |
| 硬门槛 | 宿主内核有 `binder_linux` | 宿主有 `/dev/kvm`（BIOS 开 VT-x） |
| binder 从哪来 | 宿主内核提供 → **没有就死** | guest 的 Android 内核提供 → **与宿主无关** |
| 内存 | 2~3 GB | 4 GB |
| 镜像大小 | ~1 GB | 数 GB |
| 启动时间 | 30 秒 ~ 1 分钟 | 2~5 分钟（KVM 加速） |
| 需要 privileged | 是 | 是 |
| 群晖 DSM / 威联通 QTS | ❌ 内核不给 binder | ✅ 通常可行（VMM 就是 KVM） |
| 编排文件 | `docker-compose.redroid{,-x86}.yml` | `docker-compose.qemu-android.yml` |

**关键点**：路线 B 不是路线 A 的降级版，它绕开了 A 的死结。
群晖、威联通、飞牛 fnOS 的官方内核普遍不编译 binder 模块（要重编内核 + 绕过模块签名，
投入产出比极低），所以那些机器上 redroid 注定跑不起来 —— 但只要 BIOS 开了 VT-x，
路线 B 照样能跑。

先跑预检，它会直接告诉你该走哪条：

```bash
sudo bash sidecar/android/preflight.sh
```

退出码 0 表示至少一条路可行，输出末尾会打印具体命令。

## 一、路线 A 的可行性速查

| NAS 系统 | binder 内核驱动 | 结论 |
|---|---|---|
| Debian / Ubuntu / Unraid / PVE | 装上 `linux-modules-extra-$(uname -r)` 后 `modprobe binder_linux` 通常可用 | ✅ 往下看第二节 |
| TrueNAS SCALE | 同上，官方内核带 android drivers | ✅ 可试 |
| 群晖 DSM | 内核裁剪 + 模块签名校验，自编模块要绕过校验 | ❌ 改走路线 B |
| 威联通 QTS | 同上，且内核版本更老 | ❌ 改走路线 B |
| 飞牛 fnOS | 与群晖类似，社区有换内核的方案但不稳 | ❌ 改走路线 B |

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
ADB_PORT=15555 bash sidecar/android/install-apk.sh 127.0.0.1 novatv123

# 4. 确认到底有没有走翻译 —— 这一步不能省
adb -s 127.0.0.1:15555 shell dumpsys package novatv.host | grep -i -E "primaryCpuAbi|secondaryCpuAbi"

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

## 六、路线 B：把 Android 装进 KVM 虚拟机

**什么时候走这条**：预检提示 `无 binder 但有 KVM`，也就是群晖 / 威联通 / 飞牛
这类官方内核不给 binder 的机器。这是它们唯一可行的容器化方案。

### 6.1 前置只有一个：`/dev/kvm`

```bash
ls -l /dev/kvm                       # 存在即可
grep -c -E 'vmx|svm' /proc/cpuinfo   # ≥1 说明 CPU 虚拟化开着
lsmod | grep -E 'kvm_intel|kvm_amd'  # 模块已加载
```

三样缺任何一样都进 BIOS 打开 Intel VT-x / AMD-V 再回来。
群晖装了 Virtual Machine Manager 就说明 KVM 可用 —— 它本身就是 KVM。

**但 `ls -l /dev/kvm` 有输出只是第一步**，注意它的权限位：

```
crw-rw---- 1 root kvm 10, 232 ...
```

`660` + `root:kvm` 意味着**只有 root 和 kvm 组成员能打开这个设备**。
容器里跑模拟器的是非 root 用户（`androidusr`），`--device /dev/kvm` 只是把
「属主 root、权限 660」原样搬进容器，并不会放宽它。结果就是
`permission denied /dev/kvm` —— 而这个报错极易被误读成「KVM 没开」。

解法是把宿主的 kvm 组 gid 映射进容器：

```bash
stat -c '%g' /dev/kvm     # 先查实际 gid（Debian/Ubuntu 常见 108，Arch 78，有的 NAS 是 1000+）
```

然后把 compose 里注释掉的 `group_add` 打开并填这个数字。

### 6.2 起容器

```bash
docker compose -f sidecar/android/docker-compose.qemu-android.yml up -d
docker logs -f novatv-android-emu     # 等到 boot completed，首次 2~5 分钟
```

它跑的是 Google 官方 Android Emulator（`budtmo/docker-android`），Android 11 + x86_64 AVD。

### 6.3 端口：一律用 15555，不是 5555

```bash
ADB_PORT=15555 bash sidecar/android/install-apk.sh 127.0.0.1 novatv123
```

两个原因，都是坑：

1. 宿主自己的 adb server 默认监听 5555。映射写 `5555:5555` 会让 adb 把**宿主自己**
   认成一个永远 offline 的 `emulator-5554`，之后所有命令都指向这个幽灵设备。
2. 虚拟机里的 Android 在 QEMU NAT 后面，IP 是 `10.0.2.15`，**宿主路由不到**。
   所以脚本会自动做 `adb forward tcp:8899 tcp:8899`，把宿主 localhost 直接捅进 guest，
   不用配任何 hostfwd。验证时也用 `curl http://127.0.0.1:8899/health`。

### 6.4 这条路唯一的不确定点：ARM 翻译

和路线 A 一样，加固包的 `.so` 只有 ARM 版，x86_64 的 Android 必须内置
`libndk_translation` 才装得上：

```bash
adb -s 127.0.0.1:15555 shell dumpsys package novatv.host | grep -i abi
```

| 输出 | 含义 | 动作 |
|---|---|---|
| `primaryCpuAbi=arm64-v8a` | 翻译层在工作 | ✅ 正常 |
| `primaryCpuAbi=x86_64` | 装成了 x86 变体，但 APK 无 x86 库 | 换 Play Store 版 system image |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | AVD 不带 ARM 翻译 | 同上；这是本路线最常见的失败 |

Google APIs / Play Store 的 x86_64 镜像（API 30+）通常带翻译层，纯 AOSP 镜像不带。

### 6.5 路线 A / B 怎么选

- **预检说 binder 有** → 走 A。省 2 GB 内存、启动快 5 倍，没有理由用 B。
- **binder 无、KVM 有** → 只能走 B，别在 A 上浪费时间。
- **两者都有** → 先试 A；A 卡在 `INSTALL_FAILED_NO_MATCHING_ABIS` 再换 B，
  两条路的翻译层版本不同，互为备份。

### 6.6 本路线的失败特征

| 现象 | 原因 | 处理 |
|---|---|---|
| 容器起不来，日志报 `permission denied /dev/kvm` | 没给 `--device /dev/kvm`，**或给了但容器内非 root 用户读不了 660 的节点** | 检查 devices 段；再按 6.1 查 gid 打开 `group_add` |
| 日志报 `KVM is not found` / `no acceleration` | 同上，实际退回了 TCG | 同上，别急着以为 BIOS 没开 |
| 启动超过 15 分钟还没 boot | 实际走了 TCG 软件模拟（KVM 没生效） | 回 6.1 确认 VT-x、kvm 模块与组权限 |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | AVD 无 ARM 翻译 | 换 Play Store 镜像，或回路线 A |
| 装上了但 `/health` 的 `initErrors` 有 dlopen 失败 | 翻译层跑不动 native 校验码 | 与 A 路线同因，换镜像再试一次 |
| 内存 OOM，宿主被拖垮 | 4 GB 上限不够 | 调到 6 GB，或减少并发调用 |

## 七、止损线：什么情况下该停手

容器路线（A 和 B 都算）的不确定性只有一处：「加固壳反模拟器」。这是壳的设计目标，
不是配置能绕过的。**给自己定个时限**：preflight 通过后投入 **1~2 小时**，
如果 A 卡在 `INSTALL_FAILED_NO_MATCHING_ABIS` 且换镜像无效，或两条路都卡在
`initErrors` / 搜索必崩，就不要再调参数了，直接切真机：

```bash
# 任何一台 Android 7+ 的旧手机 / TV 盒子，插电放着
bash sidecar/android/install-apk.sh <手机IP> novatv123
```

真机的成功率是 100%（架构原生、无模拟器特征），容器是「可能成」。这不是能力差距，是壳的
检测逻辑决定的。所以值得先试容器（零硬件成本），但要设硬止损点。

## 八、架构分工（与成败无关，都该这么布）

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

## 九、当前状态

- `docker-compose.redroid-x86.yml`、`docker-compose.qemu-android.yml`、`preflight.sh`、
  `install-apk.sh` **已在本机静态验证**，但容器本身**未在真实 8505 NAS 上跑过**
  （开发机无 Docker），所以才有预检脚本。
- redroid 的镜像 tag 与 `command` 参数取自 redroid-doc 与 `erstt/redroid` 官方说明；
  QEMU 路线的镜像与参数取自 `budtmo/docker-android` 官方文档。
- `.so` 抽取已实测：`node scripts/extract-spider-libs.mjs` 按 ELF `e_machine` 落到
  `jniLibs/armeabi-v7a` 与 `jniLibs/arm64-v8a`，APK 产物 145 KB 含两个库。
- 两个编排的 adb 端口统一映射到宿主 **15555**（避开宿主 adb server 的 5555），
  并同时映射 **8899** 给主服务访问。
