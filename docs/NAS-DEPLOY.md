# NAS Docker 详细部署方案

> 面向：群晖 / 威联通 / 飞牛 / Unraid / 自建 Linux，x86_64 或 ARM 都适用。
> 目标：一条命令起服务，浏览器能搜能播；加固源另配 Android 侧车。
>
> 本方案对应编排文件：**`docker-compose.nas.yml`**（一体化，用 profile 分规模）。
> 如果你只要最小可用，`docker-compose.yml` + `docs/DEPLOY.md` 也够，那份更短。

## 〇、三层结构，先看清再动手

```
                      ┌─────────────────────────────────────────┐
浏览器 ──────────────►│  novatv  :8890                          │
http://NAS:8890       │  搜索聚合 / 详情 / m3u8 改写 / 分片代理   │
                      │  / 缓存 / 网页                            │
                      └──────────┬──────────────────────────────┘
                                 │ 普通 HTTP，内网
                 ┌───────────────┴────────────────┐
                 ▼                                ▼
    ┌────────────────────────┐      ┌──────────────────────────────┐
    │ novatv-sidecar :8899   │      │ novatv-android :15555(adb)   │
    │ JVM 侧车               │      │ KVM 虚拟机里的 Android 11     │
    │ 跑「未加固」jar 源      │      │ 跑「加固包」csp_*Guard        │
    │ 可选 --profile jvm     │      │ 可选 --profile android       │
    └────────────────────────┘      └──────────────────────────────┘
```

三者的职责边界（这是整个设计的核心）：

| 层 | 能跑什么 | 跑不了什么 |
|---|---|---|
| 主服务 | CMS 采集源、JS 源、直接 m3u8 | 任何 jar / dex |
| JVM 侧车 | **未加固**的 spider jar（普通 class） | 加固包（字节码在 guard 里，JVM 拿不到） |
| Android 侧车 | **加固包**（dex 壳 + ARM .so 解密） | 无 |

所以：只想要「能播」→ 只起主服务；想多覆盖些源 → 加 jvm；要加固源 → 再加 android。

---

## 一、开工前：三条判定命令

在 NAS 的 SSH 里跑，决定你能启用哪几个 profile。

```bash
# 1) Docker 与 compose v2（v1 跑不了本编排）
docker --version
docker compose version      # 要 v2.x，报错说明只有 v1，先升级

# 2) 端口有没有被占（8890 主服务 / 15555 adb / 6081 VNC）
ss -ltn | grep -E ':(8890|15555|6081) '

# 3) Android 侧车的前提
ls -l /dev/kvm
```

第 3 条的输出决定 android profile 能不能开：

| `/dev/kvm` 的输出 | 含义 | 怎么办 |
|---|---|---|
| `crw-rw---- ... root kvm` | 有，权限正常 | ✅ 能开 android profile |
| `No such file` | 没有 | BIOS 开 VT-x/AMD-V；或改用真机 |

> **`ls` 有输出不等于能跑**。`660 root:kvm` 意味着只有 root 和 kvm 组能打开它，
> 而容器里的模拟器是非 root 用户。真报 `permission denied /dev/kvm` 时，
> 查 gid 填进编排的 `group_add`：
> ```bash
> stat -c '%g' /dev/kvm      # 例：108
> ```

一条命令跑完整自检（会额外检查磁盘、构建上下文、profile 前提）：

```bash
bash scripts/nas-deploy.sh --check --all
```

---

## 二、准备目录

```bash
# 私有仓库需要 PAT：Username 填 0uzu0，Password 处粘贴 token
git clone https://github.com/0uzu0/novatv.git
cd novatv

# 数据目录（容器要以非 root 身份写，属主要对上）
mkdir -p data
```

| 目录 | 内容 | 删了会怎样 |
|---|---|---|
| `./data` | 配置解码快照、JS 运行时模块缓存 | 下次启动慢几分钟，配置不丢（配置在远端） |
| `./data-android` | Android 虚拟机的 AVD 与已装 APK | 要重新 boot + 重装 APK |

---

## 三、配置 `.env`

```bash
cp .env.example .env
vi .env
```

**必改两项：**

```ini
# 1) 目录属主。查法：id 你的用户名 → uid=1026(xxx) gid=100(users)
PUID=1026
PGID=100

# 2) 侧车口令。用侧车就必须设，随便一串字母数字
#    生成：openssl rand -hex 16
SPIDER_TOKEN=换成你自己的口令
```

**按需启用侧车地址**（不启用就保持注释）：

```ini
# 起了 --profile jvm
SPIDER_JVM_URL=http://novatv-sidecar:8899

# 起了 --profile android（容器形态）
SPIDER_ANDROID_URL=http://host.docker.internal:8899

# Android 侧车是局域网里的手机 / TV 盒子时，换成手机 IP
# SPIDER_ANDROID_URL=http://192.168.1.23:8899
```

改目录属主（只有用 root 跑才有必要，`nas-deploy.sh` 会自动做）：

```bash
sudo chown -R 1026:100 ./data
```

---

## 四、启动

按需要的规模选一条，**不需要改文件**：

```bash
# ① 最小：只有主服务。CMS 源、JS 源都能用
docker compose -f docker-compose.nas.yml up -d --build

# ② 加 JVM 侧车：多覆盖「未加固 jar」那批源
docker compose -f docker-compose.nas.yml --profile jvm up -d --build

# ③ 全量：再加 Android 侧车（需要 /dev/kvm）
docker compose -f docker-compose.nas.yml --profile jvm --profile android up -d --build
```

首次构建约 **2~4 分钟**（拉 `node:22-bookworm-slim` + 构建）。Android 侧车会额外拉
数 GB 的模拟器镜像，网络慢的话第一次要等一会。

或者用脚本，它把自检 → 生成 .env → 构建 → 等就绪串成一步：

```bash
bash scripts/nas-deploy.sh --all          # = --nas --jvm --android
bash scripts/nas-deploy.sh --nas --jvm    # 只要 JVM 侧车
```

看进度：

```bash
docker compose -f docker-compose.nas.yml ps
docker compose -f docker-compose.nas.yml logs -f novatv
```

等 `docker compose ps` 里 novatv 变成 `healthy`（约 25~60 秒，首启要拉远端配置并解码）。

---

## 五、验证：五层，逐层往下

别跳步。每一层过了再进下一层，出问题时才知道卡在哪。

### 5.1 容器状态

```bash
docker compose -f docker-compose.nas.yml ps
```

期望：`novatv` 是 `Up (healthy)`。侧车如果启用了，也应该是 `Up`。

### 5.2 主服务健康

```bash
curl -s http://127.0.0.1:8890/api/health
```

期望返回 JSON，里面有 `ok: true`。

### 5.3 网页能开

浏览器打开 `http://<NAS-IP>:8890`。能看到界面即可。

### 5.4 源统计（关键一层）

NAS 上不一定装了 node，所以用最朴素的 grep：

```bash
curl -s http://127.0.0.1:8890/api/diag | grep -o '"runtimes":{[^}]*}' | head -1
```

输出形如 `"runtimes":{"js-site":12,"jar-spider":46,"direct":8}` —— 这是各类运行时
**配置里的条数**，不是可用数。要看可用数（`supported`），用这条：

```bash
curl -s http://127.0.0.1:8890/api/sources \
  | tr ',' '\n' | grep -c '"supported":true'
```

侧车接上之后，这个数字应该明显变大。**从 0 变成正数，说明侧车在干活。**

> 宿主上装了 node 的话，可以直接看结构化结果（更直观）：
> ```bash
> curl -s http://127.0.0.1:8890/api/sources | node -e '
> let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
>   const j=JSON.parse(s);
>   const hard=j.sites.filter(x=>x.runtime==="jar-spider");
>   console.log("总源数", j.sites.length);
>   console.log("jar 源", hard.length, "| 其中可用", hard.filter(x=>x.supported).length);
> });'
> ```


### 5.5 真播一个

网页里搜个片，点播放。播放器拿到的是 `/api/proxy?url=...` 形式的地址，
主服务会去拉分片再吐给浏览器 —— 这层通了才算端到端可用。

---

## 六、Android 侧车接入（加固源）

如果预检说没有 `/dev/kvm`，跳到 6.5 用真机，流程更短。

### 6.1 起来并等它 boot

```bash
docker compose -f docker-compose.nas.yml --profile android up -d --build
docker logs -f novatv-android        # 等到出现 boot completed，首次 2~5 分钟
```

也可以浏览器打开 `http://<NAS-IP>:6081` 看模拟器画面（noVNC）。

### 6.2 装 APK 并建立端口通道

在**宿主机**上跑（不是容器里）：

```bash
ADB_PORT=15555 bash sidecar/android/install-apk.sh 127.0.0.1 novatv123
```

（最后的 `novatv123` 换成你 `.env` 里的 `SPIDER_TOKEN`。）

脚本做四件事：装 APK → 启动侧车服务 → `adb -a forward tcp:8899` → 拉 `/health` 校验。
输出末尾会直接告诉你 `.env` 该填什么。

**这一步为什么必须在宿主做**：模拟器在 QEMU 的 NAT 后面（guest IP 是 `10.0.2.15`），
宿主的 Docker 端口映射救不了它，只有 `adb forward` 能把端口捅出来。
`-a` 让 forward 监听 `0.0.0.0`，容器才够得着。

### 6.3 让主服务连上

`.env` 里：

```ini
SPIDER_ANDROID_URL=http://host.docker.internal:8899
SPIDER_TOKEN=你的口令
```

`host.docker.internal` 靠编排里这行解析（`docker-compose.nas.yml` 已写好）：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

然后重建容器让新环境变量生效：

```bash
docker compose -f docker-compose.nas.yml --profile jvm --profile android up -d
```

### 6.4 `/health` 里两个字段决定成败

```bash
curl -s "http://127.0.0.1:8899/health?token=你的口令"
```

```jsonc
{
  "libs": ["libftyguard_v7.so", "libftyguard_v8.so"],  // 空数组 = .so 没打进 APK
  "initErrors": {}                                      // 有 key = 加固壳解密失败
}
```

- `libs` 空 → APK 打包问题，跟 KVM 无关，重新构建 APK
- `initErrors` 有 `dlopen` / `UnsatisfiedLinkError` → 翻译层跑不动壳的 native 校验
- 两个都正常 → 再放一次真实搜索，能出 JSON 列表就是真通了

### 6.5 没有 KVM：改用真机

任何一台 Android 7+ 的旧手机 / TV 盒子，插电放着，开「开发者选项 → ADB 调试」：

```bash
bash sidecar/android/install-apk.sh 192.168.1.23 novatv123
```

然后 `.env` 填 `SPIDER_ANDROID_URL=http://192.168.1.23:8899`。

真机的成功率是 100%（架构原生、无模拟器特征）；容器是「可能成」。
这不是能力差距，是加固壳的检测逻辑决定的。

### 6.6 ⚠️ NAS 重启后必须重建端口通道

`adb forward` 是**宿主机上的进程状态**，不在 Docker 里，NAS 重启就没了。
容器会自己起来（`restart: unless-stopped`），但 8899 通道不会，表现为
「网页还能开，但加固源全部不可用」。

重建：

```bash
adb connect 127.0.0.1:15555
adb -a forward tcp:8899 tcp:8899
curl -s "http://127.0.0.1:8899/health?token=你的口令"
```

想一劳永逸就把这两行写进 NAS 的开机任务：

- 群晖：控制面板 → 任务计划 → 新增 → 触发的任务 → 开机，用户选 root，命令填上面两行
- 威联通：`/etc/config/autorun.sh` 或 Autorun 套件
- 自建 Linux：systemd service 或 `/etc/rc.local`

---

## 七、日常运维

### 升级

```bash
bash scripts/nas-deploy.sh --upgrade --all
```

脚本会 `git pull` → 重建 → 等健康。侧车容器会重建，但 AVD（`./data-android`）在，
APK 不用重装；**但 6.6 的 forward 要重建**。

### 备份

只需要备份两样：

```bash
tar czf novatv-backup-$(date +%F).tar.gz .env data data-android
```

`.env` 里有 token，别传公开地方。

### 看日志

```bash
docker compose -f docker-compose.nas.yml logs -f --tail=100 novatv
docker compose -f docker-compose.nas.yml logs -f --tail=100 novatv-android
```

日志已限流（10MB × 3），不会撑爆 NAS。

### 改端口

改 `.env` 的 `NOVATV_PORT`，然后 `up -d`。

---

## 八、排障表

| 现象 | 大概率原因 | 处理 |
|---|---|---|
| 容器起来又立刻退出 | `.env` 的 PUID/PGID 与 `./data` 属主不匹配 | `sudo chown -R <PUID>:<PGID> ./data` |
| `healthy` 但网页打不开 | 端口没映射 / 防火墙 / NAS 反代 | `curl 127.0.0.1:8890` 先确认本机通 |
| 网页能开、搜不出东西 | 远端配置拉不到（域名/网络/DNS） | `docker logs novatv \| grep -i config` |
| `jar 源` 可用数一直是 0 | 侧车没起 / 地址填错 / token 不一致 | `curl "http://侧车:8899/health?token=..."` |
| `host.docker.internal` 解析不了 | Docker < 20.10，不支持 `host-gateway` | `.env` 改填宿主在 docker0 的 IP（`ip addr show docker0`） |
| 加固源全不可用但网页正常 | **NAS 重启后 adb forward 丢了** | 按 6.6 重建 |
| 容器日志 `permission denied /dev/kvm` | 容器内非 root 用户读不了 660 的节点 | 查 `stat -c '%g' /dev/kvm`，填 `group_add` |
| 容器日志 `no acceleration` / 启动 15 分钟未完成 | KVM 没生效，退化成软件模拟 | 同上；确认 BIOS VT-x 已开 |
| 装 APK 报 `INSTALL_FAILED_NO_MATCHING_ABIS` | 模拟器镜像不带 ARM 翻译层 | 换 Play Store 版 system image，或改真机 |
| `initErrors` 里有 `dlopen` 失败 | 翻译层跑不动加固壳的 native 校验 | 换镜像再试一次；仍失败则只能真机 |
| `--profile` 不起作用 | compose v1 | `docker compose version` 确认是 v2 |

---

## 九、资源与安全边界

### 资源占用（x86_64，实测口径参考）

| 服务 | 常驻内存 | 说明 |
|---|---|---|
| novatv | 150~300 MB | 无状态聚合，主要花在缓存 |
| novatv-sidecar | 200~400 MB | JVM 堆 |
| novatv-android | 2~4 GB | KVM 虚拟机 + ART，已在上限里限 4G |

最小可用（只跑主服务）**1 GB 内存够**。全量建议 **8 GB 以上**。

### 安全：三条必须守的线

1. **`SPIDER_TOKEN` 一定要设**。侧车是「能执行别人代码」的服务，
   不设 token 等于把执行入口敞在局域网。
2. **8890 不要直接暴露到公网**。要走外网就用反代 + HTTPS + 认证，
   别把源站裸奔出去。
3. **`adb forward -a` 会监听 0.0.0.0:8899**。这是为了让容器够得着，
   代价是局域网内其他机器也能访问，靠 token 兜。家里内网可以接受，
   办公/公共网络请改用防火墙只放行 NAS 自己。

---

## 十、和另一份文档的关系

| 文档 | 什么时候看 |
|---|---|
| 本文 `docs/NAS-DEPLOY.md` | 从零部署，要一份完整方案 |
| `docs/DEPLOY.md` | 只想最小部署、或要群晖图形界面截图式指引 |
| `sidecar/android/X86-NAS.md` | Android 侧车跑不起来，要深入判断 binder / KVM / ABI |
| `sidecar/android/README.md` | 侧车协议、APK 构建、四种部署形态对比 |
