# syntax=docker/dockerfile:1.7
#
# NovaTV 主服务镜像
#   构建：docker build -t novatv:local .
#   运行：docker run -d -p 8890:8890 -v "$PWD/data:/app/data" novatv:local
#
# 镜像里必须带 curl：JS 运行时（drpy 兼容层）的 req() 是同步语义，
# 靠 child_process 调 curl 实现，装不上就等于 3 个 JS 源全废。
# 多架构：node:22-bookworm-slim 官方支持 amd64/arm64，NAS 两种都能跑。

FROM node:22-bookworm-slim AS runtime

# NAS 上常见 uid/gid 不是 1000，构建时可以对齐宿主机
ARG PUID=1000
ARG PGID=1000
# 构建时由 CI 传入，用于把 GHCR 包关联回仓库
ARG GH_REPO=""

LABEL org.opencontainers.image.title="NovaTV" \
      org.opencontainers.image.description="参考 DecoTV UI + TVBox 播放原理的前后端综合视频平台" \
      org.opencontainers.image.source="${GH_REPO}"

# CONFIG_URL 故意不写进 ENV：默认值含中文域名，交给代码里的默认值更稳，
# 需要改的时候用 docker run -e / compose 的 environment 传
ENV NODE_ENV=production \
    PORT=8890 \
    TZ=Asia/Shanghai

# curl   → JS 运行时同步 HTTP
# tini   → PID 1 正确转发信号，docker stop 不会留僵尸
# tzdata → 日志时间与 NAS 一致
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tzdata tini \
 && rm -rf /var/lib/apt/lists/* \
 && if [ "$PUID" != "1000" ] || [ "$PGID" != "1000" ]; then \
      groupmod -o -g "$PGID" node && usermod -o -u "$PUID" node; \
    fi

WORKDIR /app

# 应用零 npm 依赖（全部用 Node 内置模块），所以不需要 npm install
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node web ./web
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node scripts ./scripts
# jvm-demo 站点声明了 sidecar/jvm/build/demo-spider.jar 这个路径，
# 主服务只把路径字符串转给侧车、不加载它，所以留个空目录占位即可
RUN mkdir -p /app/data /app/reports /app/sidecar/jvm/build \
 && chown -R node:node /app/data /app/reports /app/sidecar

USER node
EXPOSE 8890

# start-period 给足：首启要拉远端配置（图里藏 base64）+ 解码
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
