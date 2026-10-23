# 部署：GitHub → NAS Docker 运行

仓库已经推上去了：**https://github.com/0uzu0/novatv**（私有，分支 `main`）。

NAS 上有两条路，按你的 Docker 环境选：

| 路线 | 需要 | 适合 |
|---|---|---|
| **A. 本地构建**（推荐） | NAS 能 clone 仓库、能拉基础镜像 | 私有仓库最省事，不用折腾 GHCR 登录 |
| **B. 拉 CI 镜像** | GHCR 能认证（或包改公开） | NAS 不想跑构建，只想要一个镜像 |

两条路的 `docker-compose.yml` 是同一份，`build:` 段留着就是给路线 A 用的。

---

## 一、镜像是什么

| 镜像 | 内容 | 大小（约） | 何时需要 |
|---|---|---|---|
| `ghcr.io/0uzu0/novatv` | 主服务：API + 前端静态资源 + 媒体代理 + JS 运行时 | 180 MB | **必装** |
| `ghcr.io/0uzu0/novatv-sidecar` | JVM 侧车：加载未加固 spider jar | 300 MB | 只有手里有普通 jar 才需要 |

两个镜像都是 `linux/amd64 + linux/arm64` 双架构，群晖/威联通/软路由都能直接跑。
主镜像里装了 `curl`（JS 运行时的同步 HTTP 后端）和 `tini`（正确处理 `docker stop`），
不是随便找个 node 镜像就能替代的。

---

## 二、推代码之后发生了什么

每次 `git push` 到 `main`，GitHub Actions 的 `docker` 工作流依次跑三个 job：

```
lint    → 全部 JS 语法检查 + .dockerignore 预检 + compose 解析（1 分钟）
build   → 构建 2 个镜像 × 2 个架构，推 GHCR（首次 6~10 分钟）
smoke   → 真的把镜像跑起来，curl /api/health、首页、hls.min.js，全绿才算通过
```

**`smoke` 通过就等于「镜像能跑」这件事已经被验证过了**，这比本地 `docker build` 成功更有说服力。

镜像位置：`https://github.com/0uzu0?tab=packages`

| 触发 | 产出标签 |
|---|---|
| push 到 main | `latest`、`sha-abc1234` |
| 打 tag `v1.2.0` | `1.2.0`、`1.2`、`sha-abc1234` |
| PR | 只构建不推送（验证能编过） |

**回滚靠 sha 标签**，所以 NAS 上不建议长期用 `latest`，见第五节。

---

## 三、路线 A：本地构建（推荐）

### 3.1 在 NAS 上 clone

私有仓库要认证，用 PAT 而不是账号密码：

1. GitHub → Settings → Developer settings → **Personal access tokens → Tokens (classic)**
2. 勾 `repo`（只 clone 私有仓库的话）→ 生成 → 复制
3. NAS 上：

```bash
mkdir -p /volume1/docker && cd /volume1/docker
git clone https://github.com/0uzu0/novatv.git
# 提示 Username 填 0uzu0，Password 处粘贴 PAT
cd novatv
```

> 群晖/威联通没装 git 的话，也可以在电脑上 `git clone` 后把整个目录用 File Station /
> SMB 拷过去。构建上下文就是整个仓库（`server/ web/ fixtures/ scripts/ package.json Dockerfile`），
> 少一个目录都会 build 失败。

### 3.2 配置

```bash
cp .env.example .env
vi .env
```

必改的只有 PUID/PGID（群晖第一个用户通常是 1026）：

```bash
id <你的NAS用户名>     # 输出 uid=1026(...) gid=100(users)
```

```ini
PUID=1026
PGID=100
```

其余按需：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NOVATV_PORT` | `8890` | 宿主机端口，冲突就改这个 |
| `CONFIG_URL` | `http://www.饭太硬.cc/tv` | 换接口只改这里，支持"图里藏 base64"的载体 |
| `CONFIG_URLS` | 空 | 额外配置聚合，逗号分隔 |
| `TZ` | `Asia/Shanghai` | 日志时间 |

然后改目录属主，否则容器里的 node 写不进 `/app/data`：

```bash
sudo chown -R 1026:100 ./data
```

### 3.3 启动

```bash
docker compose up -d --build          # 首次约 2~4 分钟（拉基础镜像 + 构建）
docker compose ps                     # 等 STATUS 变成 healthy
docker compose logs -f                # 看启动日志，Ctrl+C 退出
```

或者直接跑仓库自带的脚本，它把自检、生成 `.env`、构建、等就绪串成一步
（PUID/PGID 会自动填成当前 SSH 用户，省掉 `id` 那一步）：

```bash
bash scripts/nas-deploy.sh            # 首次部署
bash scripts/nas-deploy.sh --check    # 只自检，不动容器
bash scripts/nas-deploy.sh --upgrade  # git pull + 重建
```

浏览器打开 `http://<NAS-IP>:8890`。

升级就是：

```bash
git pull && docker compose up -d --build
```

---

## 四、路线 B：拉 CI 构建好的镜像

GHCR 的包**默认私有**，二选一。

### 方案 B1：改成公开（NAS 端零配置）

GitHub → 头像 → **Packages** → `novatv` → 右侧 **Package settings** →
最底部 **Change visibility** → `Public`。`novatv-sidecar` 同理。

### 方案 B2：保持私有，NAS 上登录

```bash
echo "<你的PAT>" | docker login ghcr.io -u 0uzu0 --password-stdin
```

PAT 要勾 `read:packages`。群晖 Container Manager 没有登录入口，需要 SSH 进 NAS 执行；
威联通可以在 Container Station 的「注册表」里添加 `ghcr.io` 并填账号 + PAT。

登录后：

```bash
cp .env.example .env && vi .env      # PUID/PGID 同上
docker compose pull
docker compose up -d
```

不用 clone 整个仓库，只需要 `docker-compose.yml` + `.env`（`build:` 段会被 pull 绕过）。

---

## 五、群晖 Container Manager 图形操作

「项目」→ 新增 → 选择「创建 docker-compose.yml」→ 把 `docker-compose.yml` 内容贴进去 →
**路径**填 `/volume1/docker/novatv` → 下一步 → 完成。
环境变量在「项目」→ 你的项目 → 设置 → 环境变量里加，或者直接在 yml 里把 `${...}` 换成实际值。

> 图形界面走的是路线 B。想走路线 A，SSH 进去 `docker compose up -d --build` 更直接。
>
> 群晖自带的 Docker 20.10 对多架构 manifest list 支持没问题（构建时已关掉 provenance，
> 就是为了避开 OCI index 的兼容坑）。如果 `pull` 报 `manifest unknown`，
> 把 `NOVATV_TAG` 改成 `sha-xxxxxxx` 再试。

---

## 六、升级与回滚

```bash
# 路线 A
git pull && docker compose up -d --build

# 路线 B：升级到最新
docker compose pull && docker compose up -d

# 钉住某个版本（.env 里改）
NOVATV_TAG=sha-a1b2c3d
docker compose pull && docker compose up -d
```

`./data` 是唯一需要备份的目录（配置解码快照 + JS 模块缓存），丢了只是下次启动慢十秒，不是致命项。

---

## 七、可选：启用 JVM 侧车

只有当你的接口里有**未加固**的 spider jar 时才有意义。
那 36 个 `csp_*Guard` 加固包在这里依然跑不起来（dex 加密 + 只有 arm 的 .so），
必须走 `sidecar/android`，见 [RUNTIME.md](RUNTIME.md)。

```bash
docker compose -f docker-compose.yml -f docker-compose.sidecar.yml up -d --build
```

叠加文件会自动把主服务的 `SPIDER_JVM_URL` 指到 `http://novatv-sidecar:8899`，
不需要手改。起来之后打开站点的「诊断」页，`jar-spider` 会从灰变绿。

### 7.1 让侧车跑「开源替代」那 3 个站

侧车镜像里自带的是 `demo-spider.jar`（协议自检用），不是真站点。
真站点是 `npm run oss:build` 在你电脑上编译出来的产物，落在
`sidecar/jvm/build/oss-spiders-<hash>.jar` + `oss-spiders.json`。

把它们搬到 NAS，并让两个容器看到**同一个路径**：

```bash
# NAS 上
mkdir -p /volume1/docker/novatv/sidecar/jvm/build
# 从电脑上传 oss-spiders-<hash>.jar 和 oss-spiders.json 到这个目录
```

然后在 `docker-compose.sidecar.yml` 的两个服务下各加一行卷（路径必须一致，
主服务靠这个路径判断"有哪些开源替代"，侧车靠它加载）：

```yaml
services:
  novatv:
    volumes:
      - ./sidecar/jvm/build:/app/sidecar/jvm/build:ro
  novatv-sidecar:
    volumes:
      - ./sidecar/jvm/build:/app/sidecar/jvm/build:ro
```

重启后 `/api/sources` 里那 3 个站会从 `supported:false` 变成可播。
**没有这两个文件也不影响主服务**：检测不到 jar 就不做替换，界面如实标"需要 Android"。

---

## 八、排障

| 症状 | 原因 / 处理 |
|---|---|
| `pull` 报 `unauthorized` | 包还是私有的，NAS 没登录 → 第三节 B1 或 B2 |
| `pull` 报 `manifest unknown` | 标签不存在（看 Actions 是否成功），或老 Docker 不认多架构 → 用 `sha-` 标签 |
| `build` 报 `COPY failed` | 路线 A 必须拷整个仓库，别只拷 compose 文件 |
| 容器起来了但页面 502 | 端口映射写错，或 `NOVATV_PORT` 与 NAS 上已占用端口冲突 |
| 健康检查一直 `unhealthy` | `docker logs novatv` 看报错；常见是 PUID 不对导致 `/app/data` 只读 |
| 页面能开但搜不到东西 | 接口域名是中文的，容器内需要能出网；`docker exec novatv curl -I "$CONFIG_URL"` 验证 |
| 源全是灰色 / `supported:false` | 正常：`csp_*Guard` 加固源需要 Android 侧车，见 RUNTIME.md |
| 日志占满硬盘 | 已配 `max-size: 10m` × 3，如仍不够改 compose 里的 `logging` |
| 时间不对 | `TZ` 变量没生效，确认 `.env` 里 `TZ=Asia/Shanghai` |

进容器里手工验证：

```bash
docker exec -it novatv sh
curl -s http://127.0.0.1:8890/api/health
curl -s http://127.0.0.1:8890/api/runtime | head -c 800
```

---

## 九、镜像里到底装了什么

```
/app
├── server/          # API + 适配器 + JS 运行时 + 媒体代理
├── web/             # 前端（含本地化的 hls.min.js / mpegts.js，不依赖 CDN）
├── fixtures/        # 内置 mock CMS（演示源，无版权内容）
├── scripts/         # validate / probe，进容器排查用
├── data/            # 卷挂载点：配置快照 + JS 模块缓存
└── reports/         # 验证报告输出
```

- 非 root 运行（`node`，默认 uid 1000），`EXPOSE 8890`
- 零 npm 依赖，所以镜像里没有 `node_modules`
- 运行时依赖只有 `curl`（同步 HTTP）与 `ca-certificates`
