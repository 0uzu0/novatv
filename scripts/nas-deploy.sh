#!/usr/bin/env bash
# ============================================================================
# NovaTV —— NAS 一键部署（本地构建路线）
#
# 用法（在仓库根目录）：
#   bash scripts/nas-deploy.sh                 # 最小部署：只起主服务
#   bash scripts/nas-deploy.sh --nas           # 改用一体化编排 docker-compose.nas.yml
#   bash scripts/nas-deploy.sh --nas --jvm     # 一体化 + JVM 侧车
#   bash scripts/nas-deploy.sh --all           # 全量 = --nas --jvm --android
#   bash scripts/nas-deploy.sh --check         # 只做环境自检，不动容器
#   bash scripts/nas-deploy.sh --upgrade       # git pull 后重建
#
# 参数可组合，顺序无关。也可用环境变量覆盖（Linux/NAS 上更顺手）：
#   COMPOSE_FILE=docker-compose.nas.yml COMPOSE_PROFILES=jvm,android bash scripts/nas-deploy.sh
#
# 做的事：
#   1. 自检 docker / compose 版本、磁盘、端口占用（启用 android 时查 /dev/kvm）
#   2. 没有 .env 就从 .env.example 生成，PUID/PGID 自动填成当前用户
#   3. docker compose up -d --build
#   4. 轮询 /api/health，healthy 后打印访问地址与源统计
#
# 前置：能 clone 私有仓库（需要 PAT），且能拉 node:22-bookworm-slim 基础镜像。
# 不想本地构建、想直接拉 GHCR 镜像的，看 docs/DEPLOY.md 路线 B。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 先解析参数（顺序无关，可组合），再决定用哪份编排
MODE="up"
ARG_FILE=""
ARG_PROFILES=""
for arg in "$@"; do
  case "$arg" in
    --upgrade) MODE="upgrade" ;;
    --check) MODE="check" ;;
    --nas) ARG_FILE="docker-compose.nas.yml" ;;
    --jvm) ARG_PROFILES="${ARG_PROFILES:+$ARG_PROFILES,}jvm" ;;
    --android) ARG_PROFILES="${ARG_PROFILES:+$ARG_PROFILES,}android" ;;
    --all)
      ARG_FILE="docker-compose.nas.yml"
      ARG_PROFILES="jvm,android"
      ;;
    --help | -h)
      sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg" >&2
      echo "可用：--upgrade --check --nas --jvm --android --all --help" >&2
      exit 2
      ;;
  esac
done

# 环境变量优先于参数，方便 CI / 脚本化调用
COMPOSE_FILE="${COMPOSE_FILE:-${ARG_FILE:-docker-compose.yml}}"
COMPOSE_PROFILES="${COMPOSE_PROFILES:-${ARG_PROFILES}}"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "找不到编排文件：$COMPOSE_FILE" >&2
  exit 2
fi

DC=(docker compose -f "$COMPOSE_FILE")
if [ -n "$COMPOSE_PROFILES" ]; then
  # 逗号或空格分隔都认
  for p in ${COMPOSE_PROFILES//,/ }; do DC+=(--profile "$p"); done
fi

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

fail=0
ok() { green "  ✔ $*"; }
bad() {
  red "  ✘ $*"
  fail=1
}
warn() { yellow "  ! $*"; }

echo "════════════════════════════════════════════"
echo " NovaTV NAS 部署"
echo " 目录：$ROOT"
echo "════════════════════════════════════════════"
echo

# ---------------------------------------------------------------- 1. 环境自检
echo "[1/5] 环境自检"

if command -v docker >/dev/null 2>&1; then
  DVER="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "?")"
  ok "docker $DVER"
  case "$DVER" in
    1[0-9].* | 2[0-9].* | 3[0-9].*) ;;
    *) warn "docker 版本偏低，compose v2 可能不可用" ;;
  esac
else
  bad "找不到 docker。群晖：套件中心装 Container Manager；威联通：装 Container Station"
fi

if docker compose version >/dev/null 2>&1; then
  ok "docker compose $(docker compose version --short 2>/dev/null || echo v2)"
elif command -v docker-compose >/dev/null 2>&1; then
  bad "只有旧版 docker-compose（v1）。本项目的编排用了 v2 语法，请升级"
else
  bad "找不到 docker compose"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64 | amd64) ok "架构 $ARCH（镜像原生支持）" ;;
  aarch64 | arm64) ok "架构 $ARCH（镜像原生支持）" ;;
  *) warn "架构 $ARCH 未验证，可能没有对应基础镜像" ;;
esac

# 启用 android profile 时，/dev/kvm 是硬前提 —— 早失败好过构建完才发现
WANT_ANDROID=0
if printf '%s\n' "${COMPOSE_PROFILES//,/ }" | tr ' ' '\n' | grep -qx android; then
  WANT_ANDROID=1
fi
if [ "$WANT_ANDROID" = "1" ]; then
  if [ -e /dev/kvm ]; then
    KVM_GID="$(stat -c '%g' /dev/kvm 2>/dev/null || echo '')"
    ok "/dev/kvm 存在（Android 侧车可用，gid=${KVM_GID:-?}）"
    dim "  若容器日志报 permission denied /dev/kvm，把 gid 填进编排的 group_add"
  else
    bad "启用了 android profile，但这台机器没有 /dev/kvm —— 模拟器起不来"
    dim "  BIOS 开 VT-x/AMD-V，或直接改用真机："
    dim "  bash sidecar/android/install-apk.sh <手机IP> novatv123"
  fi
fi

AVAIL="$(df -Pk . | awk 'NR==2 {print int($4/1024)}')"
if [ "${AVAIL:-0}" -lt 3000 ]; then
  warn "可用空间 ${AVAIL}MB，低于 3GB。构建镜像建议留 5GB"
else
  ok "可用空间 ${AVAIL}MB"
fi

PORT_DEFAULT=8890
if [ -f .env ]; then
  PORT_DEFAULT="$(grep -E '^NOVATV_PORT=' .env | cut -d= -f2 | tr -d ' "' || echo 8890)"
  PORT_DEFAULT="${PORT_DEFAULT:-8890}"
fi
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT_DEFAULT} "; then
  warn "端口 ${PORT_DEFAULT} 已被占用，改 .env 里的 NOVATV_PORT"
else
  ok "端口 ${PORT_DEFAULT} 空闲"
fi

if [ -f Dockerfile ] && [ -d server ] && [ -d web ]; then
  ok "构建上下文完整"
else
  bad "缺 Dockerfile / server / web —— 需要整个仓库，不能只拷 compose 文件"
fi

if [ "$MODE" = "check" ]; then
  echo
  [ "$fail" = "0" ] && green "自检通过" || red "自检未通过，按上面提示处理后重跑"
  exit "$fail"
fi

# ---------------------------------------------------------------- 2. .env
echo
echo "[2/5] 配置"

if [ -f .env ]; then
  ok ".env 已存在，沿用"
else
  if [ ! -f .env.example ]; then
    bad "找不到 .env.example"
    exit 1
  fi
  cp .env.example .env
  UID_NOW="$(id -u)"
  GID_NOW="$(id -g)"
  # 原地改 PUID/PGID，避免 sed -i 在不同 busybox 上的差异
  awk -v u="$UID_NOW" -v g="$GID_NOW" '
    /^PUID=/ { print "PUID=" u; next }
    /^PGID=/ { print "PGID=" g; next }
    { print }
  ' .env.example > .env
  ok "已生成 .env（PUID=${UID_NOW} PGID=${GID_NOW}，取自当前用户）"
fi

PUID_VAL="$(grep -E '^PUID=' .env | cut -d= -f2 | tr -d ' "' || true)"
PGID_VAL="$(grep -E '^PGID=' .env | cut -d= -f2 | tr -d ' "' || true)"
CONFIG_VAL="$(grep -E '^CONFIG_URL=' .env | cut -d= -f2- | tr -d '"' || true)"
dim "  PUID=${PUID_VAL:-1000}  PGID=${PGID_VAL:-1000}"
dim "  CONFIG_URL=${CONFIG_VAL:-<默认>}"

mkdir -p data reports
# Android 侧车要持久化 AVD，否则每次重启都要重装 APK
[ "$WANT_ANDROID" = "1" ] && mkdir -p data-android
if [ -n "${PUID_VAL:-}" ] && [ "$(id -u)" = "0" ]; then
  chown -R "${PUID_VAL}:${PGID_VAL:-1000}" data reports 2>/dev/null || true
  ok "data / reports 属主已对齐 ${PUID_VAL}:${PGID_VAL:-1000}"
fi

# ---------------------------------------------------------------- 3. 构建
echo
echo "[3/5] 构建镜像（首次 2~4 分钟，拉基础镜像 + 编译）"
if [ "$MODE" = "upgrade" ]; then
  if git rev-parse --git-dir >/dev/null 2>&1; then
    echo "  → git pull"
    git pull --ff-only || warn "git pull 失败，用当前代码继续"
  else
    warn "不是 git 仓库，跳过 git pull"
  fi
fi
"${DC[@]}" build
ok "镜像构建完成"

# ---------------------------------------------------------------- 4. 启动
echo
echo "[4/5] 启动容器"
"${DC[@]}" up -d
ok "容器已启动"

# ---------------------------------------------------------------- 5. 等就绪
echo
echo "[5/5] 等待服务就绪"
PORT="$(grep -E '^NOVATV_PORT=' .env | cut -d= -f2 | tr -d ' "' || true)"
PORT="${PORT:-8890}"

READY=0
for i in $(seq 1 45); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
  printf '.'
done
echo

if [ "$READY" != "1" ]; then
  red "90 秒内未就绪。最近日志："
  "${DC[@]}" logs --tail=40 novatv || true
  exit 1
fi

green "✔ 服务已就绪"
echo
curl -s -m 5 "http://127.0.0.1:${PORT}/api/health" | head -c 300
echo
echo
curl -s -m 20 "http://127.0.0.1:${PORT}/api/sources" 2>/dev/null |
  grep -o '"byRuntime":{[^}]*}' | head -1 || true
echo

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ -z "${IP:-}" ]; then IP="<NAS-IP>"; fi
echo "════════════════════════════════════════════"
green " 打开：http://${IP}:${PORT}"
echo "════════════════════════════════════════════"
echo
DC_STR="${DC[*]}"
# 反推出等价参数，让"升级"那行可以直接复制粘贴
UP_ARGS=""
case "$COMPOSE_FILE" in *nas*) UP_ARGS=" --nas" ;; esac
case "$COMPOSE_PROFILES" in
  *android*) UP_ARGS="$UP_ARGS --jvm --android" ;;
  *jvm*) UP_ARGS="$UP_ARGS --jvm" ;;
esac

dim "常用命令（本次用的编排：${COMPOSE_FILE}${COMPOSE_PROFILES:+，profile=${COMPOSE_PROFILES}}）："
dim "  ${DC_STR} logs -f              看日志"
dim "  ${DC_STR} restart novatv       重启"
dim "  ${DC_STR} ps                   看状态"
dim "  bash scripts/nas-deploy.sh --upgrade${UP_ARGS}"
dim "                                    升级"
