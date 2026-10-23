# Android 侧车：让「加固 spider jar」在服务端跑起来

## 为什么必须用 Android

饭太硬这类配置的 `spider` 是 Android 加固产物，本仓库实测其结构：

| 文件 | 大小 | 说明 |
|---|---|---|
| `classes.dex` | **36,972 B** | 只有一个壳/加载器，不含业务逻辑 |
| `assets/ftyshinidie.guard` | **1,329,913 B** | 加密后的真实字节码 |
| `assets/ftyguard_v7.so` | 81,520 B | armeabi-v7a 解密器 |
| `assets/ftyguard_v8.so` | 102,440 B | arm64-v8a 解密器 |

dex 只有 37KB 而 guard 有 1.3MB —— 真实逻辑在运行时才由 native 层解密并交给 ART。
**JVM（dex2jar）、Node、QuickJS 都拿不到字节码**，这不是"实现难度"问题，而是运行时缺失。
所以只有一条路：让 jar 跑在真正的 Android Runtime 里，HTTP 暴露出来给主服务。

## 整体结构

```
主服务 (node :8890)
   │  POST /spider {site, method, params}
   ▼
adb forward tcp:8898 → 设备内 127.0.0.1:8899
   │
   ▼
HostService.apk（本目录 host-apk）
   │  DexClassLoader 加载 spider.jar（classes.dex）
   │  com.github.catvod.spider.XxxGuard
   ▼
ART 执行 → guard .so 解密字节码 → 真正的 spider 逻辑
```

## 部署步骤（redroid 容器）

```bash
# 1) 起 Android 容器（ARM 宿主机；x86 宿主见下方"ABI"章节）
docker compose up -d
adb connect 127.0.0.1:5555

# 2) 编 APK（需 Android SDK / gradle；见 host-apk/README.md）
cd host-apk && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 3) 把 spider 包推进设备（路径必须是 app 的 external files）
adb push ../spider.jar /sdcard/Android/data/novatv.host/files/spider.jar

# 4) 起服务并做端口映射
adb shell am start-foreground-service -n novatv.host/.HostService
adb forward tcp:8898 tcp:8899
curl http://127.0.0.1:8898/health     # {"ok":true,"android":"13","abi":"arm64-v8a"}

# 5) 主服务接上侧车
SPIDER_ANDROID_URL=http://127.0.0.1:8898 node server/index.js
```

`/api/runtime` 里 `android-spider` 变为 `available: true`，46 个 `csp_*` 源自动可搜可播。

## ABI 与 native 库（最容易踩的坑）

1. `ft yguard_v7/v8.so` 是 **arm** 库。x86 宿主机上的 redroid 默认没有 arm 转译，
   会 `dlopen` 失败。三条路：
   - 换 ARM 机器（Apple Silicon、ARM 云服务器）—— 最简单
   - 用带 arm 转译的镜像（libndk / libhoudini），成功率看镜像
   - **直接写真机 / 云手机**（电视盒子、旧手机都行），生产环境最稳
2. jar 里的 `.so` 不会被 `DexClassLoader` 自动解压。guard 通常 `System.loadLibrary("ftyguard")`，
   只会去 APK 的 `nativeLibraryDir` 找。所以打包前把 so 塞进 jniLibs：

```bash
unzip -o spider.jar 'assets/*.so' -d /tmp/so
mkdir -p host-apk/app/src/main/jniLibs/arm64-v8a host-apk/app/src/main/jniLibs/armeabi-v7a
cp /tmp/so/assets/ftyguard_v8.so host-apk/app/src/main/jniLibs/arm64-v8a/libftyguard_v8.so
cp /tmp/so/assets/ftyguard_v7.so host-apk/app/src/main/jniLibs/armeabi-v7a/libftyguard_v7.so
# 再 assembleDebug
```

## 真机替代方案（更省事）

```bash
adb devices
adb install -r app-debug.apk
adb push spider.jar /sdcard/Android/data/novatv.host/files/spider.jar
adb shell am start-foreground-service -n novatv.host/.HostService
adb forward tcp:8898 tcp:8899
```

老款 Android 7+ 手机即可，成本比云机低，稳定性比转译容器高。

## 协议（与 JVM 侧车完全一致）

```
POST /spider
{"site":{"key":"点我切源","api":"csp_DouDouGuard","ext":"","spiderJar":"/sdcard/..."},
 "method":"search","params":{"wd":"庆余年"}}

→ {"ok":true,"data":"{\"list\":[{\"vod_id\":\"...\",\"vod_name\":\"...\"}]}"}
```

主服务的 `server/adapters/spider.js` 自动归一化，两边侧车可互换。

## 已知限制

- 加固包混淆很强，部分 spider 会校验签名/包名/模拟器，容器里可能直接退出；
  真机成功率明显高于 redroid。失败会在 `/api/play` 里带 `errorClass` 与设备日志。
- 每个请求都要跨 adb/网络一次，延迟比进程内 JS 运行时高一个量级，建议加缓存。
- 侧车是"高权限执行别人代码"的地方，务必只监听 127.0.0.1 并做进程隔离。
