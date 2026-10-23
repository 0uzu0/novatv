# x86_64 NAS 跑 Android 侧车：能不能、怎么试

> 结论先说：**能试，但这是三条路里成功率最低的一条**。原因是架构，不是性能——
> Intel 8505 的算力远强于 N1，但加固包的 native 库只有 ARM 版本，x86 上必须
> 靠翻译层，而加固壳恰好最怕翻译层。

## 一、先厘清一件事：刷 eMMC 不会带来 Android

「在 NAS 上装安卓模拟器，然后刷进 eMMC」这个动作本身不成立：

- eMMC 是 **N1 的**存储，NAS 的系统镜像刷不到 N1 的 eMMC 上（除非把 NAS 拆了，
  那是两块完全不同的板子）。
- 如果你的 Armbian 已经刷进 N1 的 eMMC，那原厂 Android 7.1.2 已被覆盖，
  要回安卓只有两条：刷回官方固件，或让 Android 跑在容器/虚拟机里。

所以真正的问题是：**Android 跑在哪台机器上**。两台候选：

| 宿主 | 架构 | 与包内 .so 的关系 | 结论 |
|---|---|---|---|
| N1（S905D） | aarch64 | `ftyguard_v8.so` 是 ELF64 **AArch64** → 同架构 | 原生执行，最快最稳 |
| NAS（Intel 8505） | x86_64 | 包里**没有** x86 版本 → 必须翻译 | 能跑，但加固壳风险高 |

## 二、Intel 8505 的具体判断

Pentium Gold 8505 是 Alder Lake-N（1 大核 + 4 小核，6 线程），支持 VT-x。
对这件事的意义：

- **性能完全不是瓶颈**。侧车不需要画面、不需要 GPU，只跑 ART 执行 spider 逻辑。
  720p30 的 redroid 在 8505 上属于轻负载，甚至可以同时跑两三个容器。
- **瓶颈只有两个**，且都与 CPU 强弱无关：
  1. 宿主内核有没有 `binder_linux`（redroid 的硬依赖）
  2. ARM 指令靠什么翻译（libndk / libhoudini / qemu）

### 瓶颈 1：binder

| NAS 系统 | 情况 |
|---|---|
| Debian / Ubuntu / Unraid / TrueNAS SCALE | 装上 `linux-modules-extra-$(uname -r)` 后 `modprobe binder_linux` 通常可用 |
| 群晖 DSM / 威联通 QTS | 内核裁剪且签名校验，基本无解，不建议尝试 |

### 瓶颈 2：翻译层

x86 上有三种 Native Bridge：

| 方案 | 覆盖 ABI | 说明 |
|---|---|---|
| `libndk_translation`（Google） | arm64-v8a | 从 ChromeOS ARC / AVD 抽出，已打包进 `erstt/redroid:*_ndk_*` |
| `libhoudini`（Intel 专有） | arm64-v8a + armeabi-v7a | Intel 平台支持最好，`erstt/redroid:*_houdini_*` |
| qemu-user（binfmt） | 全部 | 最通用、最慢，全系统 arm64 镜像也能跑，但 ART 在 TCG 下极易崩 |

我们的 APK 同时带 `arm64-v8a` 与 `armeabi-v7a`，64 位进程会优先取 `arm64-v8a`，
所以先试 NDK 翻译就够了；失败再换 Houdini。

## 三、三条路线打分（针对你的实际设备）

| | A · NAS x86 + 翻译层 | B · N1 原生 redroid | C · 旧手机 / 电视盒子 |
|---|---|---|---|
| 性能 | 最强（8505） | 弱（S905D，2G 内存） | 中 |
| 架构匹配 | 需翻译 | 原生 | 原生 |
| 内核门槛 | 需 binder | **Armbian 官方 meson64 内核不带 binder**，要自己编模块 | 无 |
| 加固壳成功率 | 中低（反模拟器 + 翻译层兼容性） | 中（反模拟器检测会伤部分源） | **最高** |
| 折腾程度 | 中 | 高（编内核模块） | 低 |

**B 这条要特别提醒**：Armbian 的 `linux-image-current-meson64` 默认没有编译
`CONFIG_ANDROID_BINDER_IPC`，`modprobe binder_linux` 会报
`Module binder_linux not found in directory /lib/modules/6.1.x-meson64`。
官方论坛（Armbian forum, 2023-08）有同样的报告，解决办法只有换内核或自行编译模块。
所以在 N1 上跑 redroid 之前，**一定先跑 `preflight.sh`**，报 binder 不可用就别投入时间。

## 四、A 路线怎么试（约 30 分钟）

```bash
# 0. 先确认宿主条件（10 秒出结论）
sudo bash sidecar/android/preflight.sh

# 1. 起容器
docker compose -f sidecar/android/docker-compose.redroid-x86.yml up -d
docker logs -f novatv-redroid-x86        # 看到 adb 起来了就 ok

# 2. 装 APK 并启动服务（脚本与架构无关，直接复用）
bash sidecar/android/n1-setup.sh NAS_IP novatv123
```

装完最关键的一步是确认**到底有没有走翻译**：

```bash
adb shell dumpsys package novatv.host | grep -i -E "primaryCpuAbi|secondaryCpuAbi"
```

- 期望输出 `primaryCpuAbi=arm64-v8a` → 说明系统把它当 ARM 应用，走的是翻译层 ✅
- 输出 `x86_64` 或安装阶段就报 `INSTALL_FAILED_NO_MATCHING_ABIS` → 镜像不带翻译层，换 tag
- 输出 `null` 且进程起不来 → 见下节

## 五、失败特征对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 容器启动即退出 | 缺 binder / 缺 binfmt_misc | `dmesg -T \| tail -30` 看具体缺失项 |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | 镜像无翻译层 | 换 `erstt/redroid:*_ndk_*` 或 `*_houdini_*` |
| 装上了但 `ClassNotFound` | APK 未带宿主基类 | 用 `dist/novatv-host.apk`（已含 `com.github.catvod.crawler.Spider`） |
| `/health` 的 `initErrors` 有 `dlopen` 失败 | 翻译层跑不动加固壳的 native 校验 | 换 Houdini 镜像；仍失败则说明这条路对该壳不通 |
| 搜索超时 / 进程崩溃 | 加固壳检测到模拟器 | 无解，只能换真机 |

## 六、建议的顺序

1. **先看 N1 的 Armbian 是不是装在 U 盘/TF 卡**。是 → 拔卡断电重开就是原厂 Android，
   十分钟完事，比下面所有方案都好。
2. 若在 eMMC：**先跑 `preflight.sh`**。N1 报 binder 可用 → 走 B（原生，最稳）。
3. N1 报 binder 不可用，或你更想用 8505 的算力 → 走 A，按本文第四节试，
   **以 `/health` 返回为准**，不要凭容器能不能起来判断成功。
4. A、B 都不通 → C（一台旧手机插电放着，成功率 100%）。

## 七、架构分工建议（与选哪条路无关）

不管 Android 跑在哪，**主服务都应该放在 8505 上**：

```
浏览器 ──► NAS(8505, :8890)  搜索聚合 / 详情 / m3u8 改写 / 分片代理 / 缓存
              │
              └─ HTTP ──► Android 侧车(:8899)  只做 dex 执行
                          （N1 或旧手机或 NAS 容器）
```

这样 46 个加固源的解码压力在侧车，而聚合、转码、代理这些耗带宽和 CPU 的活在 8505 上，
两台各发挥长处。侧车只传 JSON，局域网一次往返 1~3ms，不构成瓶颈。
