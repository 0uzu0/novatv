# NovaTV · 双项目综合分析

> 参考对象：**DecoTV**（界面/产品形态） + **TVBoxOS**（播放链路/数据协议）
> 目标：把"客户端壳 + 配置接口"的播放模式，翻译成一套**前后端分离、可在浏览器直接播**的聚合视频平台。

---

## 一、两个项目的定位差异

| 维度 | DecoTV | TVBoxOS |
|---|---|---|
| 形态 | Web 应用（Next.js 16 / React 19 / Tailwind 4） | Android TV 客户端（Java + Kotlin，含 quickjs / pyramid 模块） |
| 内容来源 | 自建 CMS 源池 + 豆瓣/TMDB 元数据 + 网盘/影库 | 用户导入的 TVBox 配置 JSON（sites / lives / parses） |
| 播放位置 | 浏览器（ArtPlayer + hls.js） | 本机播放器（IJK / EXO），或系统播放器 |
| 扩展方式 | 环境变量 / 后台配置 | spider jar（`csp_*`）/ JS spider（drpy）/ type 0|1 采集接口 |
| 关键难点 | 跨域、防盗链、混合内容、多源聚合 | spider 运行时、解析（parse）、嗅探（sniff）、加固包 |

结论：**DecoTV 提供的是"产品与工程范式"，TVBox 提供的是"数据与协议范式"**。NovaTV 取两者的交集——TVBox 的数据协议 + DecoTV 的 Web 形态。

---

## 二、DecoTV 的界面设计拆解

### 1. 信息架构

```
首页（Hero 推荐 + 分类片单 + 继续观看）
 ├─ 搜索（一次输入 → 全源并发结果）
 ├─ 详情（海报 / 元数据 / 线路切换 / 剧集网格）
 ├─ 播放（全屏播放器 + 选集抽屉）
 ├─ 直播（多源 m3u + 频道分组）
 └─ 设置 / 我的（收藏、历史、影库）
```

### 2. 布局与视觉（NovaTV 已复刻的部分）

| DecoTV 的做法 | NovaTV 的实现 |
|---|---|
| 桌面左侧固定图标坞（icon rail），移动端底部 Tab | `.rail`（78px）+ `.tabbar`（≤900px 断点切换） |
| 顶部玻璃拟态搜索条 + 胶囊按钮 | `.topbar` + `backdrop-filter: saturate(160%) blur(22px)` |
| 影视详情用"大背景图 + 左侧渐变遮罩"压暗 | `.hero::after` 双层线性渐变（横 + 纵） |
| 海报墙 2:3 卡片，hover 放大 + 播放蒙层 | `.card` + `.card-play`，`--ease` 缓动 |
| 强调色渐变（品牌色 + 辅助色） | `--accent #7c5cff` → `--accent-2 #39d3ff` |
| 骨架屏、空状态、Toast | `.skel` shimmer / `.empty` / `.toast` |
| 深色为默认、可切换 | `data-theme` + CSS 变量双主题 |
| 多源搜索按源分组、可切换 | `/api/search` 返回 `groups[]`，前端出源级 Tab |
| 无后端时降级 localStorage | 收藏 `novatv:favs`、续播 `novatv:history` |

### 3. 值得抄的两个工程决策

- **全量代理层**：DecoTV 用 `CMS 全量代理` 解决 CORS 与 Mixed Content。NovaTV 的 `/api/proxy` 做同样的事，并额外把 m3u8 里的分片、`#EXT-X-KEY` 的 `URI=` 全部改写成代理地址——否则跨域播放列表即使能下载，分片依然会 403/CORS。
- **播放器抽象**：DecoTV 用 ArtPlayer 承载 UI、hls.js 承载解码。NovaTV 自建轻量播放器外壳（进度、倍速、选集、快捷键）+ 三引擎（hls.js / mpegts.js / 原生 video），避免引入体积较大的播放器框架，同时保留换肤能力。

---

## 三、TVBox 的播放原理拆解

### 1. 配置契约（`config.json`）

```jsonc
{
  "spider": "https://.../spider.jar;md5;xxxx",   // spider 包（可 MD5 校验）
  "sites":  [ { "key","name","type","api","ext","searchable","style","playerType" } ],
  "parses": [ { "name","type","url","ext" } ],   // 解析接口，type 0=嗅探 1=解析
  "lives":  [ { "name","type","url","ua","epg","logo" } ],
  "hosts":  [ "a.com=b.com" ],                   // DNS 级替换，绕开被墙/被劫持的图床
  "rules":  [ { "hosts","regex" } ],             // m3u8 广告切片正则清洗
  "flags":  ["..."]                              // 站点/解析启用开关
}
```

### 2. 站点类型（type）与运行时

| type | 含义 | 谁来执行 | 返回 |
|---|---|---|---|
| 0 | XML 采集接口（苹果CMS RSS） | 壳内 HTTP + XML 解析 | `<video>` 列表 |
| 1 | JSON 采集接口（苹果CMS JSON） | 壳内 HTTP + JSON 解析 | `list[]` |
| 3 | **jar spider**（`csp_XXX`） | `DexClassLoader` 加载 jar 里的 `classes.dex`，实例化 spider 类 | `homeContent` / `categoryContent` / `detailContent` / `searchContent` / `playerContent` |
| 4 | 远程 spider | HTTP 调用外部服务 | 同上 |

### 3. 一次播放的完整生命周期

```
读取配置 → 解析 sites → 选中站点
   ↓
spider.init(context, ext)                    // 每个源一次性初始化，带 ext（用户自定义参数）
   ↓
searchContent(wd) / categoryContent(tid,pg)  // 列表：vod_id / vod_name / vod_pic / vod_remarks
   ↓
detailContent([vod_id])                      // 详情：play_from + play_url（多线路 $$$ 分隔，剧集 # 分隔）
   ↓
playerContent(flag, id, vipFlags)            // 关键一步，返回：
   { parse: 0|1, url, header, playUrl, jx, ... }
   ↓
parse=0 → 直接把 url 交给播放器（HLS/MP4/FLV）
parse=1 → 走 parses 里的解析接口（WebView 嗅探或 JSON 解析），拿到真实直链
   ↓
IJK / EXO 渲染；lives 走 m3u/txt 播放列表；rules 负责剔除切片广告
```

### 4. 几个"看起来多余但很关键"的设计

- **spider 跑在独立进程**：jar 里可能有内存泄漏、native 崩溃，独立进程可以单杀重启，避免整个 App 挂掉。
- **多运行时并存**：仓库里有 `quickjs/`（跑 drpy JS spider）和 `pyramid/`（跑 Python spider），说明 TVBox 早就把 spider 抽象成"语言无关的运行时"，jar 只是其中一种。
- **`hosts` 重写**：很多源的图片/接口域名被污染，TVBox 在 DNS 层做替换。NovaTV 在 `util/http.js` 里实现了等价的 `hostMap`。
- **`rules` 正则删广告**：m3u8 里插入的 5 秒切片，用正则匹配 `#EXT-X-DISCONTINUITY` 段删掉。NovaTV 先留了 `/api/proxy` 的改写钩子，未启用清洗（避免误删正片）。

---

## 四、综合后的架构

```
┌──────────────────────────── 浏览器（DecoTV 式界面） ────────────────────────────┐
│  Hero 推荐 · 海报墙 · 聚合搜索 · 详情/选集 · 直播 · 收藏/续播        (web/)      │
│  播放器外壳：hls.js(HLS) / mpegts.js(FLV) / <video>(MP4)            (js/player)  │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │ 同源 REST（无跨域）
┌───────────────────────────────────▼──────────────────────────────────────────┐
│                         Node 服务（server/，零第三方依赖）                      │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐   ┌────────────────┐  │
│  │ ConfigStore │   │  Adapter 层  │   │  Proxy 层     │   │  Diag 诊断     │  │
│  │ 拉取/解码   │──▶│ CMS / Spider │──▶│ m3u8 改写     │   │ jar 验尸/MD5   │  │
│  │ 缓存/分类   │   │ Live         │   │ Range 流式透传│   │ 运行时统计     │  │
│  └─────────────┘   └──────┬───────┘   └───────────────┘   └────────────────┘  │
└───────────────────────────┼──────────────────────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
  苹果CMS 采集接口（type 0/1）          spider 侧车（type 3，可选）
  直接 HTTP 即可复用                     JVM/Android 容器，POST /spider
```

### 运行时选型对比

| 方案 | 能覆盖的源 | 成本 | 风险 | 结论 |
|---|---|---|---|---|
| A. Node 直连 CMS | type 0/1 | 极低 | 无 | **默认启用** |
| B. Node 跑 drpy JS | type 3 中的 `.js` | 中（要造 QuickJS + assets 模块加载器 + cheerio/pdfh 兼容层） | 脚本生态强依赖 `assets://` 内部模块，难完整兼容 | 预留接口，未实现 |
| C. JVM 侧车跑 jar | 标准 `.class` jar | 中高（需 CatVod 接口桩 + Android Context 模拟） | 大量 jar 依赖 Android API | 预留 `SPIDER_BRIDGE_URL` |
| D. Android 容器 | 全部（含加固包） | 很高（模拟器/云真机，1~2GB/实例） | 成本与合规 | 不推荐 |

**本次接的接口只能走 D**，原因见下节。

---

## 五、为什么这个接口的 46 个点播源跑不起来（实证）

对 `http://www.饭太硬.cc/tv` 的实测结论：

1. **配置不是 JSON，而是"图片里藏 JSON"**
   `GET /tv` 返回 `200 / content-type: image/x-ms-bmp / 20083 bytes`。实际内容是 `JPEG(2402B) + base64(17681B)`；
   载荷前还有 **8 字节盐 `CCtSiKQ*`**，盐之后才是 base64；base64 解出来是**带 `//` 注释的 JSONC**。
   → 平台内置三级解码链：JSON 直读 → JPEG EOI 后取尾 → 盐值 0..16 暴力对齐 + base64 + JSONC。

2. **49 个源，没有一个是 CMS 接口**
   `jar-spider: 46`（全部 `csp_*Guard`）、`js-spider: 3`（`drpy2.min.js`）、`cms-json: 0`。

3. **spider 包是 Android 加固包，不是 JVM jar**

   | 条目 | 大小 | 性质 |
   |---|---|---|
   | `classes.dex` | 36.1 KB | Dalvik 字节码（JVM 无法直接加载） |
   | `assets/ftyguard_v7.so` | 79.6 KB | 原生库（ARM） |
   | `assets/ftyguard_v8.so` | 100.0 KB | 原生库（ARM64） |
   | `assets/ftyshinidie.guard` | 1298.7 KB | 加密载荷 |
   | `META-INF/MANIFEST.MF` | 0.1 KB | 清单 |

   MD5 `654fb7dc…f38e` 与配置声明一致（校验通过）。
   → 这套结构只能由 Android 运行时 + native 库 + 壳的解密逻辑共同加载，**标准 JVM 与 Node 都无法执行**。

4. **结论**：这不是"平台没写好"，而是 TVBox 生态的结构性限制——spider 是**客户端壳的私有运行时**。任何 Web 端聚合平台想要复用这类源，只有两条路：自建 Android 容器（重），或换有 CMS 接口的源池（轻）。NovaTV 选择了后者并把前者做成可插拔的侧车协议。

---

## 六、可扩展点

- `server/adapters/` 下新增一个类即可接入新协议（现在有 `cms` / `spider` / `live`）。
- `POST /spider` 契约固定，侧车可以用 Java/Go/Python/甚至云函数实现。
- `rules` 广告清洗、`parses` 解析接口（WebView 侧）、弹幕（弹弹play）都留了位置，未实现。
- 多用户/云端收藏：目前是 localStorage，换成 SQLite/Postgres 只需替换 `favAll/toggleFav` 两个函数。
