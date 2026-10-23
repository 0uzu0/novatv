# N1 盒子接入指南（从零到浏览器能看）

斐讯 N1（S905D，Amlogic，Cortex-A53 **arm64**）是最合适的加固源侧车：
原生 ART、自带 `arm64-v8a`、功耗 3W、可以 7×24 插电。

> 关键前提：N1 必须是 **Android 系统**（官方原厂 / webpad / webpad 改版都可以，Android 7.1.2 / API 25）。
> 刷成 Armbian / OpenWrt / CoreELEC 的不行 —— 那不是 Android，没有 ART。

---

## 0. 为什么必须是 N1 这类安卓设备

加固包（饭太硬 47 个、wangerxiao 69 个）的真实结构：

| 文件 | 大小 | 作用 |
|---|---|---|
| `classes.dex` | 36,972 B | 只有 76 个壳类（`*Guard` / `Init` / `DexNative` / `Proxy`） |
| `assets/ftyguard_v7.so` | 81,520 B | ELF32 ARM，解密器 |
| `assets/ftyguard_v8.so` | 102,440 B | ELF64 AArch64，解密器 |
| `assets/ftyshinidie.guard` | 1,329,913 B | 真正的业务字节码（加密） |

真实站点代码在 guard 里，**只有 ARM native 层能解密**，解出来才交给 ART。
在 x86_64 的 NAS 上跑 redroid 会在 `adb install` 就报 `INSTALL_FAILED_NO_MATCHING_ABIS`
（包内没有 x86 so），所以 N1 是正解。

---

## 1. 装 APK

APK 已构建好：`dist/novatv-host.apk`（145 KB，含两个 `.so` + 宿主基类）。

### 方式 A：N1 已开 ADB（推荐）

```bash
# N1 上：设置 → 关于 → 版本号连点 7 次 → 开发者选项 → 打开「USB 调试」/「网络 ADB 调试」
# 记下 N1 的 IP，假设 192.168.1.50
adb connect 192.168.1.50:5555
adb install -r dist/novatv-host.apk
```

### 方式 B：U 盘

把 `dist/novatv-host.apk` 拷到 U 盘，插 N1，用自带的「文件管理器 / 应用安装器」打开安装。
（N1 需允许「未知来源」）

---

## 2. 启动侧车服务

```bash
# 口令自己定，后面 NAS 端要用同一个
adb shell am startservice -n novatv.host/.HostService --es token novatv123 --ez lan true
```

> **为什么是 `startservice` 而不是 `start-foreground-service`**：N1 是 Android 7.1（API 25），
> `am start-foreground-service` 是 API 26 才有的命令，在 API 25 上会直接报错退出。
> 服务内部自己会调 `startForeground`，两种方式最终效果一样。

也可以直接在 N1 桌面上点开「NovaTV Spider Host」图标，按界面提示启动。

### 验证

```bash
curl "http://192.168.1.50:8899/health?token=novatv123"
```

期望返回：

```json
{
  "ok": true,
  "android": "7.1.2",
  "sdk": 25,
  "abi": "arm64-v8a",
  "model": "Amlogic p230",
  "libs": ["libftyguard_v8.so", "libftyguard_v7.so"],
  "jarExists": false,
  "initErrors": {},
  "loaded": []
}
```

- `libs` 里能看到两个 `libftyguard_*.so` → native 库打进 APK 了
- `abi` 是 `arm64-v8a` → 与包内 `ftyguard_v8.so` 匹配

---

## 3. NAS 端指过去

在 NAS 的 `docker-compose.yml`（或 `.env`）里加：

```yaml
environment:
  SPIDER_ANDROID_URL: "http://192.168.1.50:8899"
  SPIDER_TOKEN: "novatv123"
```

然后 `docker compose up -d`。主服务的 `server/adapters/spider.js` 会自动把
`csp_*Guard` 这 47 个源路由到 N1，普通源仍走本地。

验证：

```bash
curl -s "http://NAS_IP:8890/api/sources" | grep -o '"supported":true' | wc -l
```

---

## 4. 首次调用会自动拉 spider 包

不用手动 push。主服务第一次请求加固源时，会把配置里的 `spider` 地址和 MD5
一起发给 N1，N1 自己下载到 `/data/data/novatv.host/files/spider/spider.jar`，
之后走本地缓存。

也可以手动触发：

```bash
curl -X POST "http://192.168.1.50:8899/load?token=novatv123" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://<配置里的 spider 地址>","md5":"<配置里的 md5>"}'
```

---

## 5. 排障表

| 现象 | 原因 | 处理 |
|---|---|---|
| `curl /health` 连不上 | 服务没起 / 不是 `lan=true` / 防火墙 | 重新 `startservice ... --ez lan true`；确认同一网段 |
| 401 | token 不一致 | `?token=` 或 `X-Nova-Token` 头要和启动时一致 |
| `libs` 为空数组 | `.so` 没打进 APK | `node scripts/extract-spider-libs.mjs --config "<配置地址>"` 后重新构建 |
| `initErrors` 里出现 `DexNative` | 加固壳解密失败 | 确认设备是 arm；确认两个 `.so` 都在 `lib/<abi>/` |
| `UnsatisfiedLinkError: dlopen` | ABI 不匹配 | N1 必须是 Android 而非 Armbian；`abi` 应为 arm64-v8a |
| 搜索一直超时 | N1 进入休眠 | 设置里关掉休眠，N1 保持插电 |
| 装不上 | 系统不是 Android | 刷回 Android 固件 |

---

## 6. 现在的确定性与不确定性

**已实测（本机）**：

- APK 构建成功，两个 `.so` 与宿主基类都在包里（`unzip -l` 可查）
- `com.github.catvod.crawler.Spider` 基类已编入（加固包的父类，jar 里没有）
- `Init` / `DexNative` / `Proxy` 确认在包内定义（不是仅引用）
- 加固协议与 TVBox 的 `JarLoader` + `ProtectedInitJar` 一一对应

**未实测（需要 N1 真机）**：

- `DexNative.getLoader()` 在你的 N1 上能否成功解密（依赖加固壳对运行环境的校验）
- 部分源可能有模拟器/改包检测，N1 是真机，成功率高于容器

装好后把 `/health` 的返回贴给我，我按 `initErrors` / `logs` 定位下一步。
