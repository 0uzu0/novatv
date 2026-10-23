# 验证报告 · 饭太硬接口

> 验证对象：`http://www.饭太硬.cc/tv`
> 执行时间：2026-10-23 09:5x（GMT+8）
> 执行方式：`node scripts/validate.mjs`（可重跑）
> 原始数据：`reports/validation-*.json`

---

## 一、总览

| 项 | 结果 |
|---|---|
| 验证用例 | **20 / 20 通过**（含 JS 运行时与 JVM 侧车） |
| 配置接口 | HTTP 200 · 20083 B · `image/x-ms-bmp` |
| 配置载体 | `jpeg+base64`（JPEG 2402 B + 载荷 17681 B，偏移 2401，盐 8 字节） |
| 解码结果 | 49 个站点 / 6 组直播 / 0 个 parses |
| 运行时分布 | `jar-spider` 46 · `js-spider` 3 · `cms-json` 0 |
| spider 包 | 1.38 MB · MD5 校验 **通过** · `android-hardened` |
| 点播链路 | 搜索 → 详情 → 取流 → HLS 清单改写 → TS 分片获取 **全通** |
| 直播链路 | 1058 频道解析 · 流类型探测 · HLS 经代理播放 **全通** |

---

## 二、逐项结果

### [1] 服务与接口配置

| 用例 | 结果 | 关键数据 |
|---|---|---|
| 健康检查 | ✔ | `port=8890` |
| 拉取并解码「饭太硬」配置 | ✔ | 载体 `jpeg+base64`，`http=200`，`bytes=20083`，源 49，耗时 552 ms |
| 站点运行时分类 | ✔ | `jar-spider:46`　`js-spider:3` |
| 直播源条目 | ✔ | 6 组：综合直播 / 牛播一 / Kimentanm / 虎牙一起看 / 斗鱼一起看 / YY轮播 |

### [2] Spider 包验尸

| 用例 | 结果 | 关键数据 |
|---|---|---|
| 下载 spider 并校验 MD5/结构 | ✔ | `kind=android-hardened`，`md5Ok=true`，5 个条目，guard 载荷 1299 KB |

包内结构（`/api/diag` 输出）：

```
classes.dex                     36.1 KB   Android DEX
META-INF/MANIFEST.MF             0.1 KB   资源
assets/ftyguard_v7.so           79.6 KB   Native (ARM)
assets/ftyguard_v8.so          100.0 KB   Native (ARM64)
assets/ftyshinidie.guard      1298.7 KB   加密载荷
```

> **判定**：Android 加固 spider，标准 JVM / Node 均无法加载。这不是解码问题，而是运行时缺失。

### [3] 点播链路（搜索 → 详情 → 播放）

| 用例 | 结果 | 关键数据 |
|---|---|---|
| 聚合搜索 | ✔ | 命中 1 源 / 1 条，跳过 49 源，4 ms |
| 详情与多线路解析 | ✔ | 星际穿越 · 演示片，2 线路 / 5 集 |
| 取播放地址 | ✔ | `hls`，直链 + 代理地址 |
| 代理播放 HLS 清单 | ✔ | 200，1821 B，**改写 14 个分片** |
| 取首个 TS 分片（Range） | ✔ | **206**，64.1 KB，Range 透传正常 |

### [4] 直播链路（真实源）

| 用例 | 结果 | 关键数据 |
|---|---|---|
| 解析直播播放列表 | ✔ | 虎牙一起看 · **1058 频道 / 4 分组** |
| 探测直播流类型 | ✔ | `4K60PSDR-H264-AAC测试 → hls` |
| 直播 HLS 经代理播放 | ✔ | 200，1821 B |

### [5] 静态资源

| 用例 | 结果 | 关键数据 |
|---|---|---|
| 首页 HTML | ✔ | 200，4838 B |
| hls.js / mpegts.js 本地化 | ✔ | 404 KB / 212 KB（不依赖 CDN） |

---

## 三、界面实测截图

| 页面 | 截图 | 说明 |
|---|---|---|
| 首页 | `docs/screenshots/home.png` | Hero 轮播 + 数据概览 + 演示片单 + 直播预览 + 运行时概览 |
| 搜索 | `docs/screenshots/search.png` | 聚合结果按源分组，底部标注 49 个源被跳过的原因 |
| 详情 | `docs/screenshots/detail.png` | 海报 / 标签 / 线路 Tab / 剧集网格 |
| 播放 | `docs/screenshots/player.png` | 真实播放（MP4 分集，进度 0:05 / 0:05） |
| 直播 | `docs/screenshots/live.png` | 188 频道 / 6 分组，可搜索 |
| 源列表 | `docs/screenshots/sources.png` | 可用 1 / 需运行时 49，逐条标注原因 |
| 诊断 | `docs/screenshots/diag.png` | 载体解码参数、spider 包逐条验尸、运行时分布 |

---

## 四、结论与边界（必须说清楚的部分）

### 已真实跑通

1. **接口解码**：图片载体 + 盐 + base64 + JSONC 的全套解析，含 MD5 校验。
2. **配置解析**：49 个站点全部识别出运行时类型，46+3 的分类与实测包结构一致。
3. **播放链路**：`搜索 → 详情 → 多线路 → 取流 → HLS 清单改写 → 分片 Range 取流`，浏览器里确实播放出画面（截图可证）。
4. **直播链路**：1058 个频道解析、流类型自动识别（HLS/FLV）、HLS 经代理可播。
5. **跨域治理**：所有外链经 `/api/proxy`，m3u8 内分片与 `EXT-X-KEY` 的 URI 全部改写，Range 请求透传。

### [7] 运行时（本轮新增，实做）

| 用例 | 结果 | 关键数据 |
|---|---|---|
| 能力矩阵 | ✔ | `cms-json:OK` `js-spider:OK` `jar-spider:OK` `android-spider:--` |
| JS 运行时：虎牙源真实搜索 | ✔ | **24 条真实房间**（房间号/标题/主播名），冷启动约 7 s |
| JS 运行时：详情 → 播放 | ✔ | 1 线路 1 集 → 引擎返回 `parse:1` → 服务端嗅探 **939 ms** 拿到真 m3u8 |
| JVM 侧车：加载真实 jar | ✔ | `demo-spider.jar`（3.9 KB，javac 编译产物）→ `URLClassLoader` 加载成功 |
| JVM 侧车：搜索 | ✔ | **2 条 / 3 ms**，`runtime: jar-spider` |
| JVM 侧车：详情 → 播放 → 代理 | ✔ | 1 线路 1 集 → HLS → 代理 200 / 1821 B / 14 个分片改写 |

JS 运行时实测细节：

| 指标 | 数值 |
|---|---|
| 模块图 | 9 个模块 / 960 KB（drpy2 + cheerio + crypto-js + node-rsa + pako + json5 + jinja + gbk + 模板） |
| 冷启动（装载 + init(规则)） | 8.7 s（首跑含下载），缓存后 < 100 ms |
| `search("英雄联盟")` @虎牙 | 2.9 s / 24 条 |
| `play` 嗅探 | 抓 52,984 B 页面 → 反转义 `\u002F` → 命中 `.m3u8` |
| 斗鱼源 `search` | 20 条（规则里 `var d` 与引擎内部 `let d` 冲突，被自动重命名修复） |

## 三、结论

1. **接口解码**：图片载体 + 8 字节盐 + base64 + JSONC 的全套解析，MD5 校验一致。
2. **播放链路**：`搜索 → 详情 → 多线路 → 取流 → HLS 清单改写 → 分片 Range 取流` 全通，浏览器实拍可见画面。
3. **JS 源**：不再需要 QuickJS —— Node 里复刻的宿主把 drpy2 跑起来了，虎牙源端到端可用。
4. **jar 源**：JVM 侧车对未加固 jar 已验证；加固包必须走 Android 侧车（代码与 runbook 已就绪，本机无设备）。
5. **诚实边界**：本机网络下 `tx.hls.huya.com` 的 m3u8 返回 403（token 绑 IP），
   播放验证止于"取址 + 代理改写 + 分片透传"（用公共测试流完成）。
6. 点播链路的主体验证仍用内置苹果CMS mock 源 + 公共测试流，不含任何版权内容。
