# Android 侧车：让「加固 spider」在网页端也能播

## 为什么非要 Android

实测两份真实配置的 spider 包，结构完全同源：

| 配置 | classes.dex | 加密字节码 | 解密库 |
|---|---|---|---|
| `饭太硬.cc/tv` | 36,972 B | `assets/ftyshinidie.guard` 1,329,913 B | `ftyguard_v7/v8.so` |
| `wangerxiao.json` | 61,500 B | `assets/wexshinidie.guard` 888,742 B | `wexguard_v7/v8.so` |

dex 只有几十 KB（一个加载壳），真实业务代码全在 guard 里，运行时由 **arm 的 .so** 解密后交给 ART。
JVM 跑不了 dex、Node/QuickJS 更跑不了，dex2jar 出来是空壳。

**结论**：这层逻辑只能跑在真正的 Android Runtime 里。

## 但「网页端播放」照样成立

关键是把两件事拆开：

```
浏览器（只负责解码播放 m3u8/mp4，不碰任何 spider）
   │  /api/search /api/play /api/proxy
   ▼
NovaTV（NAS 上的容器）
   │  POST /spider {site, method, params}      ← 就是普通 HTTP
   ▼
Host APK（手机 / TV 盒子 / redroid 里的 ART）
   │  DexClassLoader → guard 解密 → 真实 spider
   ▼
返回 {"ok":true,"data":"{...json...}"}
```

浏览器永远拿不到也不需要字节码：它只收到标准化 JSON 和一个 `/api/proxy?url=...` 的播放地址。
所以「加固源不能网页播」是个伪命题 —— 缺的不是播放能力，而是**一个把 spider 翻译成 HTTP 的执行体**。

## 三种部署形态

| 形态 | 适合 | 代价 |
|---|---|---|
| **A. 旧手机（推荐）** | 家里有闲置 Android 7+ 手机/平板/TV 盒子 | 手机要常插电、关省电限制 |
| **B. 真机 + adb** | 手机和 NAS 不同网段，或只想临时跑 | 必须连着电脑/NAS 的 adb |
| **C. redroid 容器** | 不想用手机，NAS 是 x86_64 自建 Linux | 加固包只有 ARM 的 `.so`，必须走 Native Bridge |

> **NAS 是 Intel / AMD（x86_64）？** 看 [`X86-NAS.md`](X86-NAS.md) —— 那是唯一的容器路线手册，
> 含 30 秒可行性判定、五步操作、`/health` 判据、失败对照表，以及**明确的止损线**。
>
> 设备和容器都准备好之后，安装与启动统一用一键脚本（与架构无关）：
>
> ```bash
> bash install-apk.sh 127.0.0.1 novatv123   # redroid 容器直连
> bash install-apk.sh 192.168.1.50 novatv123 # 手机 / TV 盒子
> ```

### 形态 A：手机直连（不用电脑，推荐）

```bash
# 1) 手机装 APK（见 host-apk/README.md），打开 App，填个口令，点「启动侧车」
#    屏幕会直接显示：SPIDER_ANDROID_URL=http://192.168.x.x:8899  SPIDER_TOKEN=xxx

# 2) NAS 上改 .env
SPIDER_ANDROID_URL=http://192.168.x.x:8899
SPIDER_TOKEN=你刚才填的口令

# 3) 重启容器
docker compose up -d

# 4) 自检（NAS 上执行）
curl "http://192.168.x.x:8899/health?token=xxx"
```

之后打开网页搜索即可。**首次搜索时手机端会自动下载 spider 包**（约 1 MB，按配置里的 MD5 校验），
不需要 adb push、不需要手动准备 jar。

### 形态 B：真机 + adb

```bash
adb install -r app-debug.apk
adb shell am start-foreground-service -n novatv.host/.HostService \
    --es token 你的口令 --ez lan false
adb forward tcp:8898 tcp:8899
# NAS 上（容器里要用 host.docker.internal 或 --network host）
SPIDER_ANDROID_URL=http://127.0.0.1:8898
```

### 形态 C：redroid 容器

**先跑预检，别跳过**——这一步决定后面所有事情是否有意义：

```bash
sudo bash sidecar/android/preflight.sh
```

它会检查 binder 内核驱动、ashmem/memfd、KVM、binfmt、Docker 特权，并直接给结论。

预检通过后按宿主架构选编排：

```bash
# 宿主准备（每次重启都要做，建议写进开机脚本）
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe binfmt_misc
mkdir -p /dev/binderfs && sudo mount -t binder binder /dev/binderfs

# x86_64（Intel / AMD）→ 用自带 Native Bridge 的镜像，不要额外注册 binfmt arm64
docker compose -f sidecar/android/docker-compose.redroid-x86.yml up -d
bash sidecar/android/install-apk.sh 127.0.0.1 novatv123

# ARM64 → 通用编排
docker compose -f sidecar/android/docker-compose.redroid.yml up -d
bash sidecar/android/install-apk.sh <容器IP> novatv123
```

关于 x86_64 宿主，必须把预期说清楚：

| 宿主架构 | 能否原生跑 | 实际表现 |
|---|---|---|
| ARM64 | ✅ 同架构 | 正常，一次 spider 调用 0.3~1.5 s |
| x86_64 + Native Bridge | ⚠️ 靠 libndk / libhoudini 翻译 | 接近原生（ART 冷启动十几秒），但加固壳可能拒绝 |
| x86_64 + qemu-user | ⚠️ 全栈模拟 | ART 冷启动 5~15 分钟，单次调用数十秒，仅兜底 |

原因很硬：加固包里的 `ftyguard_v7.so` / `ftyguard_v8.so` 只有 **ELF32 ARM / ELF64 AArch64**，
没有 x86 版本（`node scripts/extract-spider-libs.mjs` 会读 ELF header 打印出来）。
x86 宿主要么让镜像自带翻译层就地翻译，要么让容器以 arm64 运行逐条翻译。

**x86_64 的完整操作、判据与止损线见 [`X86-NAS.md`](X86-NAS.md)**——那份文档包含
「30 秒可行性判定 / 五步操作 / `/health` 的唯一判据 / 失败特征对照 / 何时该停手」。

> 加固壳还可能校验 ABI、模拟器特征、签名。**redroid 的成功率天然低于真机**，
> 遇到壳直接退出属于预期内，不是配置错了。

### 构建 APK

三条路，任选：

```bash
# A. GitHub Actions（推荐，不用装 Android SDK）
#    手动触发 workflow「android-apk」，填 spider_url 即可；
#    CI 会先抽 .so 再构建，产物在 Artifacts

# B. 本地有 Android SDK + JDK 17
node scripts/extract-spider-libs.mjs --config "http://www.饭太硬.cc/tv"
cd sidecar/android/host-apk && gradle wrapper --gradle-version 8.9 && ./gradlew assembleDebug

# C. Android Studio 打开 host-apk 目录，Build → Build APK(s)
```

## 协议（与 JVM 侧车一致，主服务不区分）

```http
GET /health[?token=]
→ {"ok":true,"service":"novatv-android-sidecar","android":"13","abi":"arm64-v8a",
   "jar":"/data/.../spider.jar","jarExists":true,"loaded":["csp_XxxGuard#..."],"tokenRequired":true}

POST /load   {"url":"http://.../spider.jpg","md5":"c3bb107b..."}
→ {"ok":true,"jar":"/data/.../spider.jar","bytes":959300,"md5":"c3bb107b..."}

POST /spider {"site":{"key":"...","api":"csp_WexDoubanGuard","ext":"",
                      "spiderUrl":"http://.../spider.jpg","spiderMd5":"..."},
              "method":"search","params":{"wd":"庆余年"}}
→ {"ok":true,"data":"{\"list\":[{\"vod_id\":\"...\",\"vod_name\":\"...\"}]}","tookMs":812}
```

`spiderUrl` / `spiderMd5` 由主服务自动从配置的 `spider` 字段里解析后带上（`server/adapters/spider.js`），
所以手机端不需要知道配置长什么样。

## 最容易踩的四个坑

1. **.so 不会被自动解压**
   `DexClassLoader` 只加载 dex；加固壳在运行时用 `System.loadLibrary("ftyguard_v8")` 找
   `libftyguard_v8.so`，搜索路径是 APK 的 `lib/<abi>/`，**不是** jar 里的 `assets/`。
   所以打包前必须把 `.so` 抽出来放进 jniLibs —— 用脚本做，别手抄：

   ```bash
   node scripts/extract-spider-libs.mjs --config "http://www.饭太硬.cc/tv"
   # ✓ assets/ftyguard_v7.so → armeabi-v7a/libftyguard_v7.so
   # ✓ assets/ftyguard_v8.so → arm64-v8a/libftyguard_v8.so
   ```

   脚本读 ELF header 的 `e_machine` 判 ABI（文件名里的 v7/v8 是厂商自定义后缀，不可靠），
   并会拒绝把包内不存在的 ABI 写进 jniLibs。换配置换包时重跑一次即可。

   另外 `targetSdk` 必须是 **23**：加固壳有时用 `System.load(绝对路径)` 加载，
   而 Android 7(API 24) 起 linker namespace 会拒绝从 app 可写目录 dlopen，
   只有 `targetSdk <= 23` 才走宽松策略。这一条改错，前面全白做。

2. **x86 上没有 arm 转译** → `dlopen` 失败。换真机，或按 `X86-NAS.md` 用自带 Native Bridge 的镜像。

3. **Android 8+ 前台服务 5 秒内必须挂通知**，否则被系统杀。`HostService` 已经处理。

4. **省电限制**：手机厂商的省电策略会在息屏后杀掉后台。需要在系统设置里给 App 加白名单，
   并保持充电。这是形态 A 唯一的稳定性风险。

## 已知限制

- 加固包混淆很强，部分 spider 会校验签名/包名/模拟器，容器里可能直接退出；**真机成功率明显高于 redroid**。
- 每个请求要跨一次网络，延迟比进程内 JS 运行时高一个量级（0.3~3 s），建议在网页端加结果缓存。
- 侧车是「高权限执行别人代码」的地方：**必须设 token**，手机只在内网暴露，不要把 8899 映射到公网。
- APK 工程在本机**未实际编译**（环境无 Android SDK/Gradle），首次构建由
  `.github/workflows/android.yml` 完成。若 CI 报错，多半是 AGP(`8.5.2`) 与 Gradle(`8.9`) 版本不匹配。
- 本文档里的 `preflight.sh`、`extract-spider-libs.mjs` 已在本机实测通过；
  redroid 容器本身依赖宿主内核 binder，**未在真实 NAS 上验证过**，所以才有预检脚本。
