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

## 五、结论排序

| 事 | 价值 | 成本 |
|---|---|---|
| 在安卓设备（真机 / redroid）上装已构建的 APK，跑通 36 个加固源（上限） | 高 | 取决于设备 |
| 逐个站点验证 CMS 采集接口（dm84 已关、libvio 404，属个案） | 低（实测多数已关） | 每站几分钟 |
| 给 NovaTV 加 Python 爬虫运行时（照 FongMi 的 `base.spider` 契约） | 中（要自己写站点） | 天级 |
| 让 FreeBox 或 CatVodSpider-PC 跑加固包 | **零**（代码层面就不支持） | — |
| 在 JVM 上跑现成 `.class` 站点爬虫 | **零**（没有公开成品） | — |
