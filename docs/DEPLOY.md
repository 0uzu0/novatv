# 部署：GitHub Actions 打包 → NAS Docker 运行

整个流程只有一次手工操作（把代码推到 GitHub），之后每次 `git push` 都会自动出新镜像，
NAS 上 `docker compose pull && docker compose up -d` 就完成升级。

---

## 一、镜像是什么

| 镜像 | 内容 | 大小（约） | 何时需要 |
|---|---|---|---|
| `ghcr.io/<owner>/novatv` | 主服务：API + 前端静态资源 + 媒体代理 + JS 运行时 | 180 MB | **必装** |
| `ghcr.io/<owner>/novatv-sidecar` | JVM 侧车：加载未加固 spider jar | 300 MB | 只有手里有普通 jar 才需要 |

两个镜像都是 `linux/amd64 + linux/arm64` 双架构，群晖/威联通/树莓派都能直接拉。
主镜像里装了 `curl`（JS 运行时的同步 HTTP 后端）和 `tini`（正确处理 `docker stop`），
不是随便找个 node 镜像就能替代的。

---

## 二、推代码，触发第一次构建

项目已经是一个 git 仓库并提交好了，你只需要建远程并推：

```bash
cd novatv

# 在 GitHub 上先建一个空仓库（不要勾 README / .gitignore），然后：
git remote add origin git@github.com:<你的账号>/novatv.git
git branch -M main
git push -u origin main
```

推上去后打开仓库的 **Actions** 页，会看到 `docker` 工作流依次跑三个 job：

```
lint    → 全部 JS 语法检查（30 秒）
build   → 构建 2 个镜像 × 2 个架构，推 GHCR（首次约 6~10 分钟）
smoke   → 真的把镜像跑起来，curl /api/health、首页、hls.min.js，全绿才算通过
```

构建完成后，镜像在
`https://github.com/users/<你的账号>/packages/container/novatv` 可以查到。

### 关于标签

| 触发 | 产出标签 |
|---|---|
| push 到 main | `latest`、`sha-abc1234` |
| 打 tag `v1.2.0` | `1.2.0`、`1.2`、`sha-abc1234` |
| PR | 只构建不推送（验证能编过） |

**回滚靠 sha 标签**，所以 NAS 上不建议长期用 `latest`，见第五节。

---

## 三、让 NAS 能拉到镜像

GHCR 的包**默认是私有的**，二选一：

### 方案 A：改成公开（推荐，NAS 端零配置）

GitHub → 你的头像 → **Packages** → `novatv` → 右侧 **Package settings** →
最底部 **Change visibility** → `Public`。
`novatv-sidecar` 同理。

### 方案 B：保持私有，NAS 上登录

需要一个 **classic PAT**，勾选 `read:packages`（GitHub 的 Settings → Developer settings →
Personal access tokens → Tokens (classic)）。

```bash
echo "<你的PAT>" | docker login ghcr.io -u <你的GitHub用户名> --password-stdin
```

群晖 Container Manager 没有 docker login 的图形入口，需要 SSH 进 NAS 执行上面这条；
威联通可以在 Container Station 的「注册表」里添加 `ghcr.io` 并填账号 + PAT。

---

## 四、在 NAS 上跑起来

### 4.1 建目录

群晖（SSH）：

```bash
mkdir -p /volume1/docker/novatv/data
cd /volume1/docker/novatv
```

把仓库里的 `docker-compose.yml`、`docker-compose.sidecar.yml`、`.env.example` 拷过来
（`git clone` 也行，但 NAS 上没必要留整个源码）。

### 4.2 配置

```bash
cp .env.example .env
vi .env
```

必须改的只有一项：

```ini
GHCR_OWNER=你的github用户名小写
```

其余按需：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NOVATV_TAG` | `latest` | 生产建议钉死成 `sha-abc1234` 或 `1.2.0` |
| `NOVATV_PORT` | `8890` | 宿主机端口，冲突就改这个 |
| `PUID` / `PGID` | `1000` | **群晖第一个用户通常是 1026**，填错会导致 `/app/data` 写不进去 |
| `CONFIG_URL` | `http://www.饭太硬.cc/tv` | 换接口只改这里，支持"图里藏 base64"的载体 |
| `CONFIG_URLS` | 空 | 额外配置聚合，逗号分隔 |

不知道 PUID/PGID 是多少：

```bash
id <你的NAS用户名>      # 输出 uid=1026(...) gid=100(users)
```

然后 `sudo chown -R 1026:100 /volume1/docker/novatv/data`。

### 4.3 启动

```bash
docker compose pull
docker compose up -d
docker compose ps        # 等 STATUS 变成 healthy（首次约 30 秒）
docker compose logs -f   # 看启动日志
```

浏览器打开 `http://<NAS-IP>:8890`。

### 4.4 群晖 Container Manager 图形操作

「项目」→ 新增 → 选择「创建 docker-compose.yml」→ 把 `docker-compose.yml` 内容贴进去 →
**路径**填 `/volume1/docker/novatv` → 下一步 → 完成。
环境变量在「项目」→ 你的项目 → 设置 → 环境变量里加，或者直接在 yml 里把 `${...}` 换成实际值。

> 群晖自带的 Docker 20.10 对多架构 manifest list 支持没问题（构建时已关掉 provenance，
> 就是为了避开 OCI index 的兼容坑）。如果 `pull` 报 `manifest unknown`，
> 把 `NOVATV_TAG` 改成 `sha-xxxxxxx` 再试。

---

## 五、升级与回滚

```bash
# 升级到最新
docker compose pull && docker compose up -d

# 钉住某个版本（.env 里改）
NOVATV_TAG=1.2.0

# 回滚：换回上一个 sha
NOVATV_TAG=sha-a1b2c3d
docker compose pull && docker compose up -d
```

`./data` 是唯一需要备份的目录（配置解码快照 + JS 模块缓存），丢了只是下次启动慢十秒，不是致命项。

---

## 六、可选：启用 JVM 侧车

只有当你的接口里有**未加固**的 spider jar 时才有意义。
那 46 个 `csp_*Guard` 加固包在这里依然是跑不起来的（dex 加密 + 只有 arm 的 .so），
必须走 `sidecar/android`，见 [RUNTIME.md](RUNTIME.md)。

```bash
docker compose -f docker-compose.yml -f docker-compose.sidecar.yml up -d
```

叠加文件会自动把主服务的 `SPIDER_JVM_URL` 指到 `http://novatv-sidecar:8899`，
不需要手改。起来之后打开站点的「诊断」页，`jar-spider` 会从灰变绿。

换成自己的 jar：

```yaml
# docker-compose.sidecar.yml
services:
  novatv-sidecar:
    volumes:
      - ./jars/my-spider.jar:/app/jars/demo-spider.jar:ro
```

---

## 七、排障

| 症状 | 原因 / 处理 |
|---|---|
| `pull` 报 `unauthorized` | 包还是私有的，且 NAS 没登录 → 走第三节方案 A 或 B |
| `pull` 报 `manifest unknown` | 标签不存在（看 Actions 是否成功），或老 Docker 不认多架构 → 用 `sha-` 标签 |
| 容器起来了但页面 502 | 端口映射写错，或 `NOVATV_PORT` 与 NAS 上已占用端口冲突 |
| 健康检查一直 `unhealthy` | `docker logs novatv` 看报错；常见是 PUID 不对导致 `/app/data` 只读 |
| 页面能开但搜不到东西 | 接口域名是中文的，容器内需要能出网；`docker exec novatv curl -I "$CONFIG_URL"` 验证 |
| 源全是灰色 / `supported:false` | 正常：jar 加固源需要 Android 侧车，见 RUNTIME.md |
| 日志占满硬盘 | 已配 `max-size: 10m` × 3，如仍不够改 compose 里的 `logging` |
| 时间不对 | `TZ` 变量没生效，确认 `.env` 里 `TZ=Asia/Shanghai` |

进容器里手工验证：

```bash
docker exec -it novatv sh
curl -s http://127.0.0.1:8890/api/health
curl -s http://127.0.0.1:8890/api/runtime | head -c 800
```

---

## 八、镜像里到底装了什么

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
