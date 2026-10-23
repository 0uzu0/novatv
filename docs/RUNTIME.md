# 运行时方案：46 个 jar 源 + 3 个 JS 源，到底怎么跑起来

> 一句话结论：**JS 源可以（也已经）在服务端跑起来；加固 jar 包必须交给真正的 Android。
> 剩下的 90% 工作不是"跑 jar"，而是"发现跑不动的源，用等价内容把它替掉"。**

---

## 一、先把问题定性：这不是"没实现"，是"运行时缺失"

实测饭太硬配置里的 spider 包（`https://xiuxiu-pro-new.meitudata.com/posters/23a0210a87314011a88b149d6f04722e.jpg`，
HTTP 200 / 1,449,796 B / MD5 `654fb7dc…` 与配置声明一致）：

| 成员 | 解压后大小 | 含义 |
|---|---|---|
| `classes.dex` | **36,972 B** | 只有加载器壳，没有任何业务类 |
| `assets/ftyshinidie.guard` | **1,329,913 B** | 加密后的真实字节码 |
| `assets/ftyguard_v7.so` | 81,520 B | armeabi-v7a 解密器 |
| `assets/ftyguard_v8.so` | 102,440 B | arm64-v8a 解密器 |

判定链条很清楚：

```
37KB 的 dex 装不下 46 个站点的解析逻辑
  → 真实代码在 1.3MB 的 guard 里，静态加密
  → 解密动作由 arm .so 在运行时完成（JNI），解密结果直接喂给 ART
  → JVM 只能执行 class，不能执行"运行时才生成的 dex"
  → Node / QuickJS 更不用说：那不是 JS，是 dex 字节码
```

所以 `dex2jar` 出来的是空壳，`quickjs` 加载的是语法错误。**唯一能跑的就是 Android Runtime。**

## 二、四条路，按性价比排序

| # | 方案 | 覆盖 | 成本 | 结论 |
|---|---|---|---|---|
| A | **内置 JS 运行时**（Node 复刻 TVBox QuickJS 宿主） | 3/3 JS 源，且适用于全生态 drpy/hipy 源 | 零（已实现，纯 Node 内置模块） | ✅ 已落地 |
| B | **JVM 侧车**（java 加载普通 jar） | 未加固 jar（dex2jar 或原生 class） | 一个 JDK + 150 行 Java | ✅ 已落地并验证 |
| C | **Android 侧车**（redroid/真机 + Host APK） | 加固包（即这 46 个源） | 一台 Android 设备或 ARM 容器 | ✅ 协议/代码已备，需设备 |
| D | **内容层替代**（多配置聚合，用 CMS 源补同内容） | 覆盖面最大 | 零成本，改配置即可 | ✅ 已落地（`CONFIG_URLS`） |

关键认知：**A/B/C 是在"执行别人的客户端代码"，D 是"绕开它"。**
线上真正稳的是 D 打底 + A 做长尾 + C 兜住必须用 jar 的少量源。B 只在拿到未加固 jar 时有用。

## 三、A：内置 JS 运行时（已实现，`server/runtimes/js-rt/`）

TVBox 的 js 源不是"一段脚本"，而是一张 **ES Module 图**，加一套宿主 API：

```
drpy2.min.js
 ├─ import cheerio from "assets://js/lib/cheerio.min.js"
 ├─ import "assets://js/lib/crypto-js.js"
 ├─ import "./node-rsa.js"  "./pako.min.js"  "./模板.js"  "./gbk.js"  "./json5.js"  "./jinja.js"
 └─ export default { init, home, category, detail, search, play, ... }   ← 就是 CatVod 接口
```

运行时做了四件事，缺一不可：

1. **ESM → CJS 的同步装载**：不依赖 `--experimental-vm-modules`，装载期把 `import/export` 改写掉，
   同步 `require` 映射已在内存里的模块（import 图先深度优先拉取）。
   正则必须限定"语句边界"，否则会误伤 `"parseImport: expected import"` 这类字符串常量 —— 这个坑踩过一次。
2. **`assets://` 解析**：TVBox 的 `assets://js/lib/x.js` 在内置 assets 里，开源仓根目录一般有同名副本，
   按 `rest / assets/rest / js/lib/tail / lib/tail / tail` 依次探测并落盘缓存。
3. **宿主 API 复刻**：`req / pdfh / pdfa / pd / joinUrl / getProxy / local / log / md5`。
   其中 `req` **必须是同步的** —— drpy2 里写的是
   `let res = req(url, obj); let html = res.content;`
   （QuickJS 里是 JNI 直调，天生阻塞）。Node 的 fetch 是异步的，塞不进这个调用栈，
   所以底层用 `child_process` 同步 curl（顺带解决 GBK 解码、Cookie、重定向、Range）。
   `pdfh/pdfa` 用同一个 cheerio bundle 实现，选择器语义（`a&&href`、`:eq(n)`、`&&Text`）与 jsoup 版对齐。
   `local` 是 KV 对象（`local.get/set`），不是函数 —— 写成函数会让搜索直接报 `local.get is not a function`。
4. **V8/QuickJS 语义差异自动修复**：drpy 规则里的代码是字符串，由引擎内部 `eval`。
   规则常写 `var d = []`，而 V8 规定"直接 eval 的 var 与所在函数作用域的 let 同名"是 SyntaxError，
   QuickJS 不报。捕获 `Identifier 'x' has already been declared` 后把规则里该标识符重命名再重试。

### 实测（本机，真接口）

| 动作 | 结果 |
|---|---|
| 引擎装载 + `init(规则)` 冷启动 | **8.7 s**（9 个模块 960 KB），热启动 ~0 ms |
| 虎牙源 `search("英雄联盟")` | **2.9 s / 24 条真实房间**，带封面、主播名 |
| 虎牙源 `detail` | 1 条线路、1 集（`https://m.huya.com/189201`） |
| 虎牙源 `play` | 引擎返回 `parse:1`（网页地址），**服务端轻量嗅探** 2.7 s 拿到真 m3u8 |
| 斗鱼源 `search` | 20 条；`detail` 报规则自身的 `vod_url.indexOf` 错误（规则质量问题，非运行时） |

`parse:1` 是 TVBox 交给 WebView 嗅探的情况。服务端不启动浏览器，只做"抓页面 + 找直链"：
把 `\u002F` 反转义后匹配 `.m3u8/.flv/.mp4`，命中就直连，不命中就如实返回
`needParse + sniffed.reason`，绝不猜。

> 边界：本机网络下 `tx.hls.huya.com` 的 m3u8 直连返回 **403**（token 与 IP/区域绑定），
> 播放链路的"取流"这一步在本机不可验证，但"取址 + 代理改写 + 分片透传"已验证（测试流 14 分片 206）。

## 四、B：JVM 侧车（已实现并验证，`sidecar/jvm/`）

适用于**未加固** jar：dex 已转 class，或本来就是普通 jar。

```
node scripts/jvm-sidecar.mjs        # javac 编译 + 打 demo jar + 起 8899
```

侧车用 `URLClassLoader` 加载 jar，反射调用 CatVod 接口；宿主要提供
`com.github.catvod.crawler.Spider`、`android.content.Context` 等占位类（本仓库已含）。
`csp_XxxGuard` 按 TVBox 约定解析成 `com.github.catvod.spider.XxxGuard`。

实测（真编译的真 jar，非模拟）：

| 动作 | 结果 |
|---|---|
| `GET /health` | `{"ok":true,"java":"21.0.9","loaded":["com.github.catvod.spider.DemoSpider"]}` |
| `/api/search?wd=演示&sites=jvm-demo` | **10 ms / 2 条**，`runtime: jar-spider` |
| `/api/detail` → `/api/play` | 1 线路 1 集 → HLS |
| `/api/proxy` | 200，清单改写 **14 个分片** |

平台里 `jvm-demo` 是这条链路的活样例；把它换成你的普通 jar + `NOVA_SPIDER_JAR` 即可。

## 五、C：Android 侧车（加固包的唯一解，`sidecar/android/`）

结构：`主服务 → adb forward → 设备内 HostService.apk → DexClassLoader → ART → guard 解密`。
协议与 JVM 侧车完全一致（`POST /spider {site,method,params} → {ok,data}`），
所以 `server/adapters/spider.js` 无需区分。

已备好：

- `sidecar/android/preflight.sh`：宿主可行性预检（binder/ashmem/KVM/binfmt/privileged），10 秒给结论
- `sidecar/android/docker-compose.redroid.yml`：redroid 容器（含 `platform: linux/arm64` 与 binderfs 挂载）
- `sidecar/android/host-apk/`：`HostService.java`（手写 HTTP + DexClassLoader + 反射调用）、Manifest、gradle 工程
- `scripts/extract-spider-libs.mjs`：从加固包抽 `.so` → `jniLibs/<abi>/`（按 ELF header 判 ABI，不靠文件名）
- `.github/workflows/android.yml`：CI 自动构建 APK（先抽 `.so` 再 `assembleDebug`），产物走 Artifacts
- `sidecar/android/README.md`：完整 runbook（三种部署形态 + 排障表）

四个必须知道的坑：

1. **ABI**：`ftyguard_v7/v8.so` 实测是 `ELF32 ARM` / `ELF64 AArch64`，**包里没有 x86 版本**。
   x86_64 宿主只能让容器以 arm64 运行（`platform: linux/arm64` + `binfmt`）+ QEMU 逐条翻译：
   ART 冷启动 5~15 分钟，单次调用数十秒。ARM 机器 / 真机 / 云手机才是稳的。
2. **`.so` 不会被自动解压**：`DexClassLoader` 不处理 jar 里的 `assets/*.so`，而 guard 走的是
   `System.loadLibrary("ftyguard_v8")`（只认 APK 的 `lib/<abi>/`）。打包前必须用
   `scripts/extract-spider-libs.mjs` 抽出来放进 `jniLibs/`。
3. **`targetSdk` 必须是 23**：壳有时用 `System.load(绝对路径)`，Android 7(API 24) 起 linker namespace
   会拒绝从 app 可写目录 dlopen，只有 `targetSdk <= 23` 走宽松策略。写错这一步，前面全白做。
4. **反调试/反模拟器**：加固包普遍校验包名、签名、模拟器特征。容器成功率明显低于真机；
   失败时 `/api/play` 会带 `errorClass` 与设备日志，不吞错。

成本估算：一台 Android 7+ 旧手机即可，比云机便宜且更稳；一个侧车可服务整份配置的 46 个源。

## 六、D：内容层替代（最容易被忽略，但性价比最高）

46 个源跑不动，不代表这些**内容**看不到。同一部剧在生态里通常有几十个 CMS 采集源。
所以平台支持多配置聚合：

```bash
CONFIG_URLS="http://other-config-1/tv,http://other-config-2/tv" node server/index.js
```

`server/config/loader.js` 会用同一套"藏图解码器"解析每个配置，合并站点（key 冲突自动加 `@host` 后缀），
`/api/sources` 里能看到每个站点来自哪个配置。这样即使 46 个 jar 全部不可用，
平台依然能搜到、播到——因为补进来的是纯 HTTP 的 `type=0/1` 源。

## 七、平台里怎么"看得见"这套机制

- `GET /api/runtime` → 四类运行时的能力矩阵（是否可用、引擎、启用方式、已知限制、侧车健康度）
- `GET /api/diag` → 配置解码细节 + spider 包"验尸"结论（`android-hardened`）
- `/api/sources` → 每个源的 `runtime / runtimeReason / supported`（`supported` 是**实时**判定的：
  jar 源只有在"包里是普通 jar 且 JVM 侧车在线"或"Android 侧车在线"时才为 true）
- 不可用源的 `/api/detail` `/api/play` 返回 `501 + SPIDER_RUNTIME_MISSING`，并带 `fix` 字段告诉你怎么补

## 八、结论

1. **3 个 JS 源**：不用 QuickJS，Node 就够了，本仓库已跑通（含 drpy2 的同步语义、模块图、`assets://`）。
2. **46 个 jar 源**：加固包只能交给 Android；JVM 路线只对未加固 jar 有效。
   侧车协议已经统一，接上设备即用，代码不用改。
3. **真正的工程解**：D 打底（CMS 聚合）+ A 覆盖长尾（JS 源）+ C 兜底（必须用 jar 的少量源）。
   把"跑不动的源"做成可见、可诊断、可降级，而不是假装它能跑。
4. 合规边界不变：平台只提供协议与运行时能力，不内置、不分发任何片源。
