# N1 跑 Armbian 时怎么接加固源

## 先说结论：你可能不用刷机

之前否决 redroid，是因为**那台 NAS 是 x86_64**，而加固包只带 ARM 的 `.so`。
N1 不一样：**S905D = Cortex-A53 = aarch64**，与包内 `ftyguard_v8.so`（ELF64 AArch64）同架构。
所以「保留 Armbian + 在容器里跑 Android」这条路在 N1 上是成立的，
前提只有一个：**内核得有 binder 驱动**。

---

## 第 0 步：先确认 Armbian 装在哪（30 秒，决定后面走哪条路）

| Armbian 装在哪 | 原厂 Android 还在吗 | 最省事的做法 |
|---|---|---|
| **U 盘 / TF 卡** | ✅ 还在 eMMC 里，完好 | **拔掉 U 盘/TF 卡，开机即是原厂 Android 7.1.2**，直接装 APK，10 分钟完事 |
| **eMMC（内部存储）** | ❌ 已被覆盖 | 走下面的「路线 A：redroid」，或「路线 B：刷回 Android」 |

判断方法：把插在 N1 上的 U 盘/TF 卡拔掉，断电重开，看是不是进了斐讯原厂桌面（黑色豹头 LOGO → 安卓桌面）。
进去了就是第 1 行的情况，**后面的内容都不用看了**，直接：

```bash
# 在原厂系统里：设置 → 关于媒体盒 → 版本号连点 7 次 → 开发者选项 → ADB 调试
bash sidecar/android/n1-setup.sh <N1的IP> novatv123
```

---

## 路线 A：保留 Armbian，用 redroid（推荐，不动系统）

### A1. 跑预检（唯一能给出确定答案的一步）

把 `sidecar/android/` 整个目录拷到 N1 上，然后：

```bash
sudo bash preflight.sh
```

重点看【1】binder 那一节：

- 出现 `✓ binderfs 已挂载` / `✓ /dev/binder 存在` / `✓ 内核内置/可加载 binder`
  → **可以走 A，继续 A2**
- 出现 `✗ binder 不可用 → redroid 起不来`
  → A 路线此路不通，跳到「路线 B」或「路线 C」

> Armbian 的 Amlogic 内核有的版本自带 `binder_linux` 模块，有的没有。
> 有的话 `modprobe binder_linux` 一句话就能起来；没有的话得自己编内核模块，不建议折腾。
> 预检脚本会自动尝试 `modprobe`，所以这一步的结论是可信的。

### A2. 起 redroid

```bash
# 每次重启宿主都要重新挂 binder（建议写进 /etc/rc.local）
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo mkdir -p /dev/binderfs
sudo mount -t binder binder /dev/binderfs

# N1 专用编排文件（720p / 1.2G 内存上限 / Android 11）
sudo docker compose -f docker-compose.redroid-n1.yml up -d
```

**注意用的是 `docker-compose.redroid-n1.yml`，不是通用那个。** 通用版限 3G 内存，
N1 总共只有 2G，直接起会 OOM 被内核杀掉。

### A3. 装 APK 并启动

```bash
adb connect <N1的IP>:5555
bash n1-setup.sh <N1的IP> novatv123 8899
```

`n1-setup.sh` 会自己判断 SDK 版本选对启动命令（redroid 11 是 API 30，用
`am start-foreground-service`），装完直接拉 `/health` 告诉你 native 库和加固壳的状态。

### A 路线的代价

- Armbian 照常用，数据不动
- 额外吃 1~1.2G 内存，N1 只剩 ~600MB 给 Armbian，别在 N1 上再跑重活
- redroid 里是「近似真机」环境：加固壳若做模拟器检测，仍可能失败（真机成功率更高）

---

## 路线 B：刷回 Android

代价：**Armbian 会没掉**，N1 变回电视盒子。如果你在 N1 上跑了 NAS / 下载 / 别的服务，不要选这条。

### B1. 软路径（不用拆机、不用双公头线，成功率看运气）

思路是让 eMMC 的 boot 分区失效，设备就会掉回 Amlogic 的线刷/恢复模式板端等待。

```bash
# SSH 进 Armbian
df -h | grep mmcblk        # 找到 boot 分区，通常是 /dev/mmcblk1p1
sudo umount /dev/mmcblk1p1
sudo mkfs.ext4 /dev/mmcblk1p1     # 抹掉 boot 分区
sudo reboot
```

重启后机器停在「豹头 S905D」或 Android Recovery 画面，这时：
电脑装 `USB_Burning_Tool`（推荐 v2.1.2 / v2.1.6.8），导入 N1 的 Android 7.1.2 线刷包，
**取消勾选「擦除 flash」和「擦除 bootloader」**（这两项勾上容易把设备刷死），点开始，
用双公头 USB 线连电脑与 N1，通电，等走到 100%。

### B2. 硬路径（拆机短接，稳）

1. 双公头 USB 线（30~50cm）+ N1 拆机，或用「晶晨短接神器」插 HDMI
2. `USB_Burning_Tool` 打开 → 文件 → 导入烧录包 → 开始
3. 保持短接 → USB 插电脑 → 通电开机
4. 进度 100% 后断电，拔线，接显示器开机

> 两个坑：
> - 工具安装目录的 `license/` 里必须有 `SECURE_BOOT_SET`，没有会报错
> - 部分 N1 需要**先刷 T1 的包**（烧到 22% 会失败），再刷 N1 的包 —— 这是正常流程不是坏了
> - 固件在网盘里流传（当贝固件大全 / 斐讯盒子N1目录），链接经常失效，自己找最新的

### B3. 刷完

```bash
bash sidecar/android/n1-setup.sh <N1的IP> novatv123
```

---

## 路线 C：换一台旧安卓手机（最省事，10 分钟）

如果 A 路线 binder 不行、B 路线又不想丢 Armbian ——
**任何一台 Android 7+ 的旧手机 / 电视盒子都比折腾 N1 划算**：

- 原生 ART，加固源成功率 100%（比 redroid 高，没有模拟器检测风险）
- 插电放着，功耗比 N1 还低
- 装 APK 用 `n1-setup.sh`，同一个脚本，只换 IP

---

## 三条路线对比

| | A · redroid | B · 刷回 Android | C · 旧手机 |
|---|---|---|---|
| 保住 Armbian | ✅ | ❌ | ✅ |
| 需要硬件 | 双公头线（仅刷机时） | 双公头线 + 可能拆机 | 一台闲置手机 |
| 耗时 | 30 分钟（binder 可用时） | 1~2 小时，有变砖风险 | 10 分钟 |
| 加固源成功率 | 中（模拟器检测会影响部分源） | 高 | 最高 |
| 内存开销 | 1~1.2G | 无 | 无 |

---

## 现在就能做的一件事

不管走哪条路，**先把预检结果拿到**：

```bash
sudo bash preflight.sh
```

把输出发我，我直接告诉你走 A 还是 B，以及如果走 A 要补哪个内核模块。
在这之前讨论「能不能成」都是猜的。
