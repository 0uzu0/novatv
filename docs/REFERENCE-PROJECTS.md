# 参照项目调研：它们能帮我们什么、不能帮什么

调研对象：

- `FongMi/CatVodSpider` —— FongMi 官方的爬虫工程（2026-10-19 刚重构）
- `kknifer7/FreeBox` —— JavaFX 桌面版 TVBox 客户端
- `kknifer7/CatVodSpider-PC` —— 桌面版的爬虫**模板**（FreeBox 的配套）

一句话结论：**三个项目都是「客户端」，没有一个是「服务端解密器」**，都不能把饭太硬 /
wangerxiao 的加固包变成可执行代码。但它们提供了两样有实际价值的东西：真实的 CatVod
API 定义，以及 PC 端 JVM 宿主的接口契约。

---

## 一、FongMi/CatVodSpider（重构后）

### 结构

```
app/libs/catvod-api.jar      129,607 B   43 个 .class —— 真实的 API 实现（不是 stub）
app/libs/quickjs-api.jar     333,010 B   QuickJS 的 Java API
app/src/main/java/...        只有 AList / Demo / Local / MQiTV / Market / Proxy / Push /
                            Samba / WebDAV —— 站点爬虫已全部移除
examples/python/spider.py     40,055 B   Python 爬虫完整范例
examples/javascript/spider.js 40,973 B   QuickJS 爬虫完整范例
docs/development.md           19,367 B   接口说明
jar/custom_spider.jar        142,513 B   构建产物 = classes.dex（325,220 B）
```

### 值得借鉴的三点

**1. `catvod-api.jar` 是真实实现，可直接校准我们的宿主桩**

我用 `javap` 扒了它的 43 个类，`com.github.catvod.crawler.Spider` 的真实签名是：

```java
public abstract class Spider {
  public String siteKey;
  public Net net;               // 实例字段，由宿主注入
  public Local local;
  public static Dns safeDns();
  public Activity getActivity();
  public String getProxyUrl();
  public String getProxyUrl(Map<String,String>);
  public void init(Context);  public void init(Context, String);
  public String homeContent(boolean);
  public String homeVideoContent();
  public String categoryContent(String, String, boolean, HashMap);
  public String detailContent(List);
  public String searchContent(String, boolean);
  public String searchContent(String, boolean, String);
  public String playerContent(String, String, List);
  public String liveContent(String);
  public boolean manualVideoCheck();  public boolean isVideoFormat(String);
  public Object[] proxy(Map);
  public String action(String);
  public void destroy();
}
```

jar 内另有完整实现：`Net`（okhttp3 封装，含 Cookie/Session/缓存）、`Download`（50KB）、
`Crypto`（含 RSA）、`Json`、`Archive`、`Local`、`Prefers`、`Task`、`UriUtil`。
外部依赖只有 **okhttp3 + android.\*（16 个类）+ org.json**。

**2. Python / QuickJS 爬虫的宿主契约**

```python
from base.spider import Spider as BaseSpider     # 宿主提供 base 模块
```

配置侧 `api` 直接写文件路径，`type: 3`：

```json
{ "key": "PythonDemo", "type": 3, "api": "./python/spider.py", "ext": {...} }
```

即：**一个站点规则可以是一个 .py 或 .js 文件**，不需要 jar、不需要 Android。
这条对我们的意义是——如果要给 NovaTV 加"轻量爬虫运行时"，Python 是比 Java 更薄的实现路径
（宿主只需暴露 `req/http`、`getCache/setCache`、`joinUrl` 这类函数）。但要清楚：这只能
**自己写站点**，不能把加固包里的站点变出来。

**3. 官方 jar 的构建是 dex**

`build.gradle` 用 Android application 插件 + R8，产物 `classes.dex`。
这也解释了下一条的关键矛盾。

---

## 二、kknifer7/FreeBox（JavaFX 桌面客户端）

### 架构

- 纯 JVM：JDK 17 + JavaFX 21 + GraalJS（`org.graalvm.polyglot`）
- HTTP 服务端：`FreeBoxHttpServerHolder` + `ProxyHandler` / `ProxyTsHandler` /
  `M3u8TsProxyHandler` / `BadM3u8TsProxyHandler` / `ProxyCacheHandler` / `ProxyCkHandler`
- WebSocket 服务端：`KebSocketServer`（TVBox 协议下发）
- 播放器：VLC / MPV 外挂
- 特色功能：**资源审计**（`SourceAuditExecutor`，批量体检 home/category/search/detail/play）

### 关键代码：它明确拒绝 dex jar

`SpiderJarLoader.isJarAvailable()`：

```java
if (name.endsWith(".dex") || name.contains("classes.dex")) {
    log.warn("{} is not available", name);
    return false;
}
```

这一句决定了它的能力边界：

| jar 类型 | FreeBox | 原因 |
|---|---|---|
| 饭太硬加固包（dex + guard + arm .so） | ❌ | 含 dex，直接判不可用 |
| FongMi `custom_spider.jar`（dex 325KB） | ❌ | 同上 |
| PC 模板编译的 `.class` jar | ✅ | `URLClassLoader` 加载 |
| `.js` 爬虫 | ✅ | GraalJS |

也就是说：**FreeBox 不能作为我们跑加固源的替代方案**。它连官方 Java 爬虫 jar 都跑不了。

### 它的 JVM 宿主接口（与 Android 版不同，值得记录）

注意包名和签名都变了 —— 基类是 `com.github.catvod.crawler.spider.Spider`（多一层 `spider`），
初始化是 `init(String ext)`，**没有 Context**：

```
init() / init(String ext)
homeContent(boolean filter)
homeVideoContent()
categoryContent(String tid, String pg, boolean filter, HashMap)
detailContent(List ids)
searchContent(String key, boolean quick) / (String, boolean, String pg)
playerContent(String flag, String id, List vipFlags)
manualVideoCheck() / isVideoFormat(String)
proxyLocal(Map) -> Object[]
client() -> OkHttpClient
destroy()
```

加载流程：`URLClassLoader(urls) → loadClass("com.github.catvod.spider." + api.replace("csp_","."))
→ newInstance() → 反射调 init(ext)`，另外反射 `com.github.catvod.spider.Proxy.proxy(Map)` 处理
`do=proxy` 请求。这套流程和我们 `sidecar/jvm` 的做法一致，可以互相印证。

---

## 三、kknifer7/CatVodSpider-PC

README 原话：**"内部不包含任何站点爬虫代码，也不会接受站点爬虫相关的 PR"**。
它只是一个"纯 Java 项目"的空模板（参考 `Greatwallcorner/CatVodSpider`），供人 fork 后自己写。

所以「JVM 上直接跑现成站点爬虫」这条路上，**没有公开可用的成品**。

---

## 四、对我们当前工作的直接结论

### 1. 我们的 APK 基类是兼容的（不用返工）

我扫了饭太硬加固包 dex 的全部字符串，它引用的 API 符号只有：

```
com/github/catvod/crawler/Spider;     ← 父类
searchContent / homeContent / categoryContent / playerContent / detailContent
proxy / proxyInvoke
```

**没有** `getProxyUrl`、`net`、`local`、`siteKey`、`OkHttp`、`catvod/net` 的任何引用。

这说明该包是按**老版 TVBox API** 编译的，我们手写的
`app/src/main/java/com/github/catvod/crawler/Spider.java` 方法集已经覆盖，不需要为了
对齐 FongMi 的新 API 而加 `net`/`local`/`getProxyUrl`（加了反而要引入 okhttp + Net 实现）。

### 2. 包里到底有多少能跑：36 个，不是 46 个

我用 `class_defs` 精确统计，并与项目缓存的配置做了集合运算：

| 项 | 数量 |
|---|---|
| 配置里的源条目（全部 `type:3`） | 49 |
| 去重后的 api 值 | 38 |
| 其中 `csp_*Guard` | 37 |
| 包内定义的 `*Guard` 类 | 46（含 1 个 `BaseSpiderGuard` 基类壳） |
| **真实站点实现** | **45** |
| **配置与包的交集（能加载）** | **36** |
| 配置有、包里没有 | 1 个：`XPath`（必 `ClassNotFound`，是配置本身的错） |
| 包里有、配置没引用 | 9 个：`Aliso` `Anime1` `AppYsV2` `KaFei` `Sir88` `WebDAV` `YCyz` `Youtube` `Zbz` |

所以准确的说法是：

- 之前说「46 个源不可播」是按**配置条目**算的（49 条里有 3 条是 JS 源，46 条走 jar）；
- 但按**站点实现**算，APK 跑通后能开的现实上限是 **36 个**，另有 9 个可以手工加进配置；
- `csp_XPathGuard` 这条无论 APK 是否正常都会失败 —— 包里根本没有这个类。

### 3. 一个被实测否掉的设想（记录以免重犯）

我原本推测：这 46 个里 Dm84、Libvio、NewCz、Nmyswv、AppYsV2、AppTT 这类名字与已知
苹果CMS 站重合，可能可以直接用 `type: 1` 接 `api.php/provide/vod`，绕过 spider。

**实测不成立**：

| 探测 | 结果 |
|---|---|
| `dm84.tv/api.php/provide/vod/at/json/?ac=list` | HTTP 200，正文就一个词 **`closed`** |
| `www.dm84.tv/...`、`dm84.tv/api.php/provide/vod/?ac=list` | 连接失败（000） |
| `www.libvio.vip/api.php/provide/vod/?ac=list` | 404（返回的是站点 404 页） |
| `www.libvio.me/...` | 404 |

`closed` 这个响应本身说明接口曾经存在、站点主动关掉了公开采集。所以：

- 「从加固包里挑 CMS 站直连」**不能作为默认路线**，只能逐个站点现场验证；
- 判断依据必须是「接口返回合法 JSON 列表」，而不是「站点看起来像苹果CMS」。

这条记在这里，是因为它把「快速开十几个源」这个诱人的选项降级成了「个案尝试」。

---

## 五、结论排序（原始判断，已被第六节部分修正）

| 事 | 价值 | 成本 |
|---|---|---|
| 在安卓设备（真机 / redroid）上装已构建的 APK，跑通 36 个加固源（上限） | 高 | 取决于设备 |
| 逐个站点验证 CMS 采集接口（dm84 已关、libvio 404，属个案） | 低（实测多数已关） | 每站几分钟 |
| 给 NovaTV 加 Python 爬虫运行时（照 FongMi 的 `base.spider` 契约） | 中（要自己写站点） | 天级 |
| 让 FreeBox 或 CatVodSpider-PC 跑加固包 | **零**（代码层面就不支持） | — |
| 用 CatVodSpider 的历史快照编译同名站点，在 JVM 侧车上跑 | **中**（实测 7 编 3 跑） | 已落地，见下节 |

---

## 六、落地结果：开源同名实现替换加固源（2026-10）

上一节写「在 JVM 上跑现成 `.class` 站点爬虫价值为零」，是因为当时只想到「找现成 jar」。
真正的可行路径是**用源码自己编**：FongMi/CatVodSpider 的历史快照里有 44 个站点的完整
Java 源码，配置里的 `csp_XxxGuard` 只要类名能对上，就能编出一个纯 JVM 可跑的版本。

### 为什么必须用历史快照

仓库现在已经被清空（只剩 README 与空模板），源码要回到 `91cb48b`（2024-01）才拿得到：

```bash
git -C tools/openspider/refs/CatVodSpider archive 91cb48b -- app/src/main/java
```

`scripts/oss-spider.mjs` 已经把这步自动化了（`ensureRepo()` 会自己 clone + unshallow）。

### 实测数字

| 环节 | 数字 |
|---|---|
| 开源站点（快照内） | 44 |
| 配置里 `csp_*Guard` | 37 |
| 类名能对上（可替换） | **7**：Bili、Dm84、FirstAid、Kanqiu、Push、Wogg、XPath |
| 编得过 | **7**（补 zxing / nanohttpd / JsoupXpath + sardine、BuildConfig 桩之后） |
| 冒烟跑得起来 | **3**：Dm84、Kanqiu、FirstAid |

### 剩下 4 个为什么不行（实测，非推测）

| 站点 | 卡点 |
|---|---|
| Bili | `homeContent` 里直接 `new FrameLayout.LayoutParams(...)` 建登录二维码弹窗，纯 UI 代码 |
| Push | `NoClassDefFoundError: android/view/ViewGroup$LayoutParams`，同一条登录/配置弹窗链 |
| Wogg | 同上（玩偶的配置弹窗） |
| XPath | 规则来自 `ext`，而配置里这条源 `ext` 为空，`Rule` 没初始化 → NPE |

所以判定标准只能是**跑一次 `home` 看返回**，不能靠「编译通过」。

### 工程上的三个坑（都已修在脚本里）

1. **`-sourcepath` 会把依赖链全编一遍**。`Proxy.java` 引用 `WebDAV.java` 引用
   `sardine-android`（jitpack 坐标，Maven Central 没有），于是 Bili/Wogg/Push 一起挂。
   解法：`tools/openspider/stubs-src` 里放编译期桩（Sardine / DavResource / OkHttpSardine），
   只进编译 classpath，不进 jar。
2. **侧车的 `Spider` 基类不能挂到编译 classpath**。它会盖掉源码树自带的 `Spider`
   （签名不同：有没有 `throws Exception`），导致 7 个站点全员编译失败。
   桩只补 `BuildConfig` 这种独立小类。
3. **jar 不能原地覆盖**。侧车 `URLClassLoader` 打开后 Windows 不释放句柄，改一次就要停一次服务。
   解法：jar 名字带内容指纹 `oss-spiders-<hash>.jar`，新包是新路径，旧包继续被跑着的侧车用着。

### 替换是怎么生效的

`server/config/oss-spiders.js` 读 `sidecar/jvm/build/oss-spiders.json`，**只认 `verified` 列表**：

```
csp_Dm84Guard  →  oss-spiders-113d7cac.jar#com.github.catvod.spider.Dm84
                  （runtime 改成 jar-spider，spiderJar 指向真实路径）
```

没通过冒烟的一律不替换，配置里那些源仍显示「需要 Android」——**不假装能播**。

### 现在的实际收益

| 源 | 之前 | 现在 |
|---|---|---|
| Dm84 | `supported:false`（要 Android） | 服务端可跑，分类/详情/播放全通 |
| 看球（Kanqiu） | 同上 | 服务端可跑（直播为主） |
| Aid（FirstAid） | 同上 | 服务端可跑，**直链 mp4**，浏览器直接放 |

Dm84 的播放地址是 `hhjx.hhplayer.com/?url=...` 这类**解析型**地址，配置里 `parses` 为空，
所以到「取直链」这步会提示需要解析接口——这是另一件事，与 spider 替换无关。
FirstAid 返回的是 `vod.youlai.cn/.../*.mp4` 直链，`/api/proxy` 实测 206 + `ftypisom`，
是当前唯一「加固源 → 浏览器直接能看」的完整闭环。

### 怎么重跑

```bash
node scripts/oss-spider.mjs --list      # 看快照里有哪些站点、配置能对上哪些
node scripts/oss-spider.mjs --verify    # 编译 + 打包 + 对着 :8899 冒烟，写 manifest
# 主服务重启后自动生效；核对：GET /api/sources 看 api 是否变成 oss-spiders-xxx.jar#...
```
