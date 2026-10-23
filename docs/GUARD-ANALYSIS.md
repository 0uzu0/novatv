# 加固包解剖报告（ftyguard / ftyshinidie.guard）

> 目的：把「加固包为什么只能在 Android 上跑」从一句断言，变成一组可验证的事实。
> 所有数字都来自对 `data/config-cache.json` 里那个伪装成 jpg 的 spider 包的实测。

## 0. 样本

配置里 `j.jar` 伪装成图床图片：

```
https://xiuxiu-pro-new.meitudata.com/posters/23a0210a87314011a88b149d6f04722e.jpg;md5;654fb7dcb0aeaaea7dba0e662395f38e
```

`;md5;` 是 TVBox 的校验语法。下载后 md5 = `654fb7dcb0aeaaea7dba0e662395f38e`，与配置一致。
文件 1,449,796 B，其实是 ZIP：

| 条目 | 大小 | 说明 |
|---|---|---|
| `classes.dex` | 36,972 | 壳：76 个 class_defs |
| `assets/ftyguard_v7.so` | 81,520 | ELF32 · ARM (e_machine=40) |
| `assets/ftyguard_v8.so` | 102,440 | ELF64 · AArch64 (e_machine=183) |
| `assets/ftyshinidie.guard` | 1,329,913 | 真逻辑 |

## 1. guard 不是「一坨密文」，它有明文 ZIP 头

这是之前判断失误的地方。头部 30 字节按 ZIP local file header 解开：

```
signature : 04034b50        → ZIP local file header
version   : 10
flags     : 0x0800          → bit0(加密)=False, bit3=data descriptor=False, bit11(UTF-8 文件名)=True
method    : 8               → DEFLATE
crc32     : 7d6282a2
compressed: 1,329,606
size      : 2,801,896
filename  : classes.dex
data start: 41   data end: 1,329,647   file len: 1,329,913
```

对齐是完美的：`41 + 1,329,606 = 1,329,647`，余下 266 B 正好是 central directory + EOCD。
**没有加密位，声明方式是 DEFLATE。**

含义：guard 就是 Multidex 读取的 secondary-dex zip 格式，里面装一个 2.8 MB 的 `classes.dex`。
壳 dex 的字符串池也印证了这点 —— `MultiDexExtractor.load(`、`secondary-dexes`、
`Failed to reload existing extracted secondary dex files, falling back to fresh extraction`
全是 AndroidX Multidex 的原样日志。

## 2. 但数据体是二次加密的（不是标准 DEFLATE）

直接 inflate 报错：

```
zlib.error: Error -3 while decompressing data: invalid code lengths set
```

三段采样熵：前 64 K / 中段 / 尾 64 K 都是 **7.96 ~ 7.99 bit/byte**，
256 种字节值全部出现 —— 加密态，不是压缩态。

排除过的可能：

| 尝试 | 结果 |
|---|---|
| 单字节 XOR 0~255，取前 4 KB 试 inflate | 4 个 key（47/103/247/255）能解出 **5~6 字节**就断 → DEFLATE 的宽容性巧合，不是真 key |
| 用 4 个 key 全量解压 + CRC 校验 | 全部失败，0 字节有效输出 |
| 假定 guard 整体是标准 ZIP（中央目录可读） | 数据体加密，中央目录里的 CRC 是**明文 dex** 的，无法用于校验中间态 |

结论：**ZIP 头明文是对外兼容的壳，数据体由 native 层解密。**

## 3. 解密在 .so 里，且被 OLLVM + RegisterNatives 双重遮挡

### 3.1 没有 `Java_*` 导出符号

两个 .so 的动态符号表都只有 `JNI_OnLoad`：

```
ftyguard_v7.so  (ARM,   125 个动态符号)
  JNI_OnLoad                                   addr=0x39bd  size=912
  .datadiv_decode12482769245597196919          addr=0x4069  size=11368
  .datadiv_decode5814800646798009390           addr=0xa2c5  size=2
  .datadiv_decode9930862836887202800           addr=0x8fb1  size=2
  decode_eht_entry                             addr=0xa2c9  size=80

ftyguard_v8.so  (AArch64, 84 个动态符号)
  JNI_OnLoad                                   addr=0x47d0  size=1960
  .datadiv_decode17436524447802073507          addr=0xce18  size=4
  .datadiv_decode16244776623201238872          addr=0x4f78  size=12672
  .datadiv_decode2921592732575348853           addr=0xb39c  size=4
```

`.datadiv_decode*` 是 **OLLVM（Obfuscator-LLVM）字符串加密 pass** 留下的段符号，
那个 11~12 KB 的巨型函数就是字符串解密器。所以连符号名都读不出来 ——
`aes`、`decrypt` 这类关键词在 .so 里一个都搜不到（静态串全被加密）。

方法名被隐藏，说明所有 JNI 方法走的是 `JNI_OnLoad` 里 `RegisterNatives` 动态注册。

### 3.2 壳 dex 反而漏了方法名（在这边）

`classes.dex` 的字符串池里能读到：

```
decrypt          encrypt          getLoader
native_ting_md5  noxSign          generateRandomString
proxyInvoke      getSpider        calcResult
OoOoO0O0o0oOoO0O OoOoOo0O0o0oO0o0 oOo0oOo0Oo0oO0Oo (混淆字段名)
.ftyfnw          ftyguard_        secondary-dexes
```

`noxSign` 与 `native_ting_md5` 表明除了加密，还有**签名/完整性校验**链路。

## 4. 四条路线的真实成本

| 路线 | 是否可行 | 卡点 | 成本 |
|---|---|---|---|
| **A. Android 运行时**（真机 / 桌面模拟器 / redroid） | ✅ 唯一不需要逆向的路 | 必须有 ARM 指令执行能力 + ART；x86 宿主需翻译层 | 见下表 |
| **B. 用开源同站源码替换** | ✅ 已落地 3 个 | 只覆盖「当年泄漏过源码」的站 | 已做：`scripts/oss-spider.mjs` |
| **C. 协议层替代（直接打 CMS 采集接口）** | ❌ 对加固源不成立 | 见第 5 节实测 | — |
| **D. 逆向解出 dex，转 jar 在 JVM 跑** | ⚠️ 技术存在，不建议 | 要过 RegisterNatives 定位 + noxSign + native_ting_md5；解出后仍需 dex2jar + Android API 兼容层 | 天级，且属规避他人技术保护措施 |

### 4.1 路线 A 的三种形态，约束是同一个

关键区分：**「必须 Android」约束的是运行时类型，不是「必须是物理手机」。**
只要满足「ART 能跑 + ARM 的 .so 能 `dlopen`」，在哪跑都行。

| 形态 | 内核 | 界面 | ARM 翻译层 | 备注 |
|---|---|---|---|---|
| 真机 | 真内核 | 有 | 原生 ARM，不需要 | 最稳 |
| 桌面模拟器（雷电 / 夜神 / MuMu） | 虚拟机自带内核 | 有，可看 logcat | **厂商默认内置**（libhoudini / libndk_translation） | 最容易调试 |
| redroid 容器 | 共享宿主内核（需 binder） | headless | **官方镜像不带**，要选 `*_ndk_ChromeOS` 系列 | 适合 NAS 常驻 |

**这正是「模拟器能跑、redroid 难搞」的体感差异来源**：
桌面模拟器为了让 Android 游戏能跑，出厂就带 ARM 兼容层；redroid 是给云手机用的，
默认镜像可能没有翻译层，得专门挑，还要自己解决 binder。

### 4.2 对第 4 节原有判断的修正

本文档早期版本写「x86 上成功率中低，卡在加固壳反模拟器」。依据是桌面模拟器里
TVBox 类 APK 能正常拉源播放这一实测现象 —— 说明**这类壳的检测强度被高估了**：

- 壳真正强校验的是**签名与 dex 完整性**（`noxSign` / `native_ting_md5`），
  这部分在模拟器里同样成立（装的是原包，签名不变）
- 模拟器特征检测是**可选项**，很多壳不做，或只做 `ro.kernel.qemu` 这种弱判断
- 结论：x86 上跑不跑得起来，**先试比先判定更划算**；用桌面模拟器试成本最低

### 4.3 关于 D 为什么停在这里

技术上不是绝对无解：unidbg 能在 x86 上模拟 ARM 执行 `.so`，绕过「必须有 Android 设备」，
拦 `RegisterNatives` 拿到方法表就能调 `decrypt`。但它要求：

1. 定位动态注册表 → 需要反汇编 OLLVM 混淆过的 `JNI_OnLoad`（1.9 KB，控制流平坦化）
2. 构造 JNI 环境与 `Context` 对象（`decrypt` 大概率要 Context 或 key 从签名派生）
3. 过 `noxSign` / `native_ting_md5` 校验
4. 解出的 2.8 MB dex 再 dex2jar，站点类仍依赖 Android API

这不是配置问题，是一次完整的逆向工程；而且它绕的是他人产品的加密保护。
**本项目不提供这条路的实现。**

## 5. 为什么「协议层替代」对加固源天然失效

测了 ext 里带域名的三个源（其余域名硬编码在类里，配置看不出来）：

| 源 | 域名 | 实测 |
|---|---|---|
| Libvio 立播 | `www.libvio.pw` | `403 Access denied by geographic restriction`；直连 `403 browser verification required`（JS 挑战） |
| SixV 新6V | `www.xb6v.com` | 首页 200（"新版6v电影…专注免费电影下载"），但 `api.php/provide/vod/`、`index.php/ajax/data`、`type/1.html` 全 **404** → 下载站，非 CMS |
| S_zps | `107.173.211.148` | 200，是 **PanSou 盘搜**，网页抓取型 |

推论比个案更重要：

> **加固的动机就是「不想被随便采集」。标准 CMS 站谁都能采，根本不需要加固。**
> 所以「加固源」和「能用采集接口替代」几乎是互斥集合。

这也是开源替换只能覆盖 3 个的原因 —— 那 3 个能替换，是因为有人把源码公开过，不是因为接口标准。

## 6. 结论

1. **「加固包必须 Android」是硬约束**：要跑它的代码，必须有 ARM 指令执行能力 + ART，
   因为字节码在 native 层才出现，且 .so 无 x86 版本。
2. **但「必须 Android」≠「必须买设备」**：真机、桌面模拟器（雷电/夜神/MuMu）、redroid
   三者是同一类东西，约束完全相同（ART + ARM 翻译）。桌面模拟器出厂自带翻译层、
   有界面能看 logcat，**试错成本最低**；redroid 适合 NAS 常驻但默认镜像不带翻译层。
3. **反模拟器风险被高估了**：TVBox 类 APK 在桌面模拟器里能正常拉源播放这一现象说明，
   这类壳主要校验签名与 dex 完整性（原包签名不变即可通过），模拟器特征检测多为可选。
   所以 x86 上应当「先试再判定」。
4. **「跑不了 jar」≠「源不能播」**：服务端可播的路径有两条 —— 开源替换（3 个已通）、
   直连接口（对加固源不成立）。剩下的确实只能在 Android 侧车里跑。
5. **不要把 D 当成备用方案**：它既是天级工程，也是规避技术保护措施。

---

*测量脚本片段见本文件内联命令；样本不随仓库分发（`data/` 已在 `.gitignore`）。*
