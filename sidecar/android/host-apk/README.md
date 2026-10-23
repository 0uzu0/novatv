# Host APK：把加固 spider 跑在 Android 上，暴露成 HTTP

## 工程结构（已补齐，可直接打开）

```
host-apk/
├─ settings.gradle
├─ build.gradle                     # AGP 8.5.2
├─ app/build.gradle                 # minSdk 21 / targetSdk 23 / 只编 arm
└─ app/src/main/
   ├─ AndroidManifest.xml           # 前台服务 + 明文 HTTP + 通知权限
   ├─ jniLibs/                      # ← 加固包的 .so 放这里（脚本生成）
   │  ├─ arm64-v8a/libftyguard_v8.so
   │  └─ armeabi-v7a/libftyguard_v7.so
   └─ java/novatv/host/
      ├─ MainActivity.java          # 一个按钮：启动侧车并显示 IP/口令
      └─ HostService.java           # ServerSocket + DexClassLoader + /health /load /spider
```

没有第三方依赖：HTTP 用 `ServerSocket` 手写，JSON 用 Android 内置 `org.json`。

> **targetSdk 为什么是 23 而不是 34**
> 加固壳加载 `.so` 有两条路径：`System.loadLibrary("ftyguard_v8")` 和 `System.load(绝对路径)`。
> 后者在 Android 7(API 24) 起会被 linker namespace 拒绝（app 可写目录不在许可列表），
> 只有 `targetSdk <= 23` 才退回宽松策略。压到 23 是这类场景的通行做法，
> 对只做 HTTP 服务的侧车没有副作用。redroid 是 Android 13，最低可装 targetSdk 就是 23。

## 编包

**方式 A：GitHub Actions（推荐，无需本地 Android SDK）**

手动触发 `.github/workflows/android.yml`，填 `spider_url`（加固包直链），
CI 会先用 `scripts/extract-spider-libs.mjs` 把 `.so` 抽进 jniLibs，再 `gradle assembleDebug`。
产物在 Artifacts → `novatv-host-apk`。

**方式 B：本地有 JDK 17 + Android SDK 34**

```bash
# 1) 先抽 .so（不抽的话 APK 装上也会 UnsatisfiedLinkError）
node scripts/extract-spider-libs.mjs --config "http://www.饭太硬.cc/tv"

# 2) 构建
cd sidecar/android/host-apk
gradle wrapper --gradle-version 8.9   # 第一次需要，生成 gradlew
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**方式 C：Android Studio** 打开 `host-apk` 目录，Build → Build APK(s)。

> 诚实说明：本机没有 Android SDK / Gradle，这份工程**未在本地实际编译过**。
> CI 流水线是它第一次真正构建。若报错，优先看 AGP(`8.5.2`) 与 Gradle(`8.9`) 是否匹配，
> 以及 `namespace` 与 manifest 是否冲突（AGP 8 已禁止 manifest 里写 package）。

## 用起来

1. 打开 App，填一个口令（强烈建议填），点「启动侧车」。
2. 屏幕会显示：

   ```
   SPIDER_ANDROID_URL=http://192.168.1.23:8899
   SPIDER_TOKEN=你的口令
   ```

3. 把这两行填进 NAS 上的 `.env`，`docker compose up -d`。
4. 网页端搜索时，手机端会**自动下载配置里的 spider 包**（按 MD5 校验）。
5. 想确认状态：`curl "http://192.168.1.23:8899/health?token=你的口令"`。

## 为什么第一次搜索会慢几秒

首次调用会下载 ~1 MB 的 spider 包并做 MD5 校验，然后 `DexClassLoader` 加载，
guard 的 `.so` 解密字节码也需要几百毫秒。之后有内存缓存，单次搜索通常 0.3~1.5 s。

## 手工换包

```bash
# 让手机自己下（推荐）
curl -X POST "http://192.168.1.23:8899/load?token=xxx" \
  -d '{"url":"http://oss4liview.moji.com/.../xxx.jpg","md5":"c3bb107b..."}'

# 或者 adb 推（路径固定）
adb push spider.jar /data/data/novatv.host/files/spider/spider.jar   # 需 root
# 非 root 用 App 的私有目录之外的方式不推荐，直接走 /load
```

## 排障

| 现象 | 原因 |
|---|---|
| `/health` 401 | token 没带或不对（`?token=` 或 `X-Nova-Token` 头） |
| `hint: native 库没加载` | jniLibs 没放 `.so`，或设备 ABI 与包内库不匹配（x86 上必现） |
| `自动拉取 spider 包失败` | 手机连不上那个 OSS 域名，或 MD5 与配置不符 |
| 搜索一直超时 | 手机进了省电模式被冻结，去系统设置里加白名单并插电 |
| 装不上 `NO_MATCHING_ABIS` | 设备/模拟器是 x86，而 APK 只带 arm 库 —— 换 ARM 设备或 ARM redroid |
| 装上但闪退 | 壳校验签名/包名/模拟器；redroid 上常见，换真机 |
