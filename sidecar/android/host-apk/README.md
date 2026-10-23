# Host APK 构建说明

这个 APK 只做一件事：在 Android 里加载 spider jar，并把它暴露成 HTTP 服务。

## 目录

```
app/src/main/AndroidManifest.xml
app/src/main/java/novatv/host/HostService.java
build.gradle（需自行补齐，见下）
```

## 最小 gradle 配置

`app/build.gradle`：

```gradle
plugins { id 'com.android.application' }
android {
    namespace 'novatv.host'
    compileSdk 34
    defaultConfig {
        applicationId "novatv.host"
        minSdk 21
        targetSdk 34
        versionCode 1
        versionName "1.0"
        ndk { abiFilters 'arm64-v8a', 'armeabi-v7a' }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}
```

项目根 `build.gradle` / `settings.gradle` 用 Android Studio 新建空工程后替换即可，不需要任何第三方依赖
（HTTP 服务用 `ServerSocket` 手写，JSON 用 Android 内置 `org.json`）。

## 编包

```bash
./gradlew assembleDebug
# 产物 app/build/outputs/apk/debug/app-debug.apk
```

## 需要注意

1. **不要**改成 `android:debuggable` 之外的加固，guard 可能检测包名；
   如果 spider 校验包名，把 `applicationId` 改成 TVBox 的包名试试（`com.github.tvbox.osc`）。
2. `HostService` 里用 `DexClassLoader` 加载的是 dex 而不是 class，jar 无需转换。
3. guard 的 `.so` 要放进 `jniLibs/`（见上级 README 的 ABI 章节），否则 `System.loadLibrary` 会失败。
4. 服务只监听 `127.0.0.1`，通过 `adb forward` 暴露给宿主机，不要直接绑 0.0.0.0。
