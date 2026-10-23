#!/usr/bin/env bash
# ============================================================================
# NovaTV · redroid 可行性预检
#
# 目的：在 NAS 上花 10 秒判断「这台机器到底能不能跑 Android 容器」，
#      避免在注定失败的平台上折腾内核模块。
#
# 用法（NAS 上以 root 执行）：
#   sudo bash sidecar/android/preflight.sh
#
# 检测项与真实门槛（不是"建议"，是硬性条件）：
#   1. binder  —— Android 的 IPC 驱动。宿主机内核没有
#                 CONFIG_ANDROID_BINDER_IPC 就起不来，且 redroid 无法自带
#   2. arch    —— 加固包的 .so 只有 ARMv7 / AArch64，没有 x86 版本。
#                 x86_64 宿主必须靠 QEMU 用户态模拟（慢）或 native bridge（罕有）
#   3. KVM     —— 只在用 QEMU 全系统模拟（qemu-system-aarch64）时需要
#   4. binfmt  —— x86_64 宿主跑 arm64 镜像时，内核要注册 qemu-aarch64 处理器
#
# 退出码：0 = 可以继续；1 = 有硬阻塞（看输出最后的「结论」）
# ============================================================================
set -u

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
[ -t 1 ] || { RED=''; GRN=''; YEL=''; DIM=''; RST=''; }

ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$RST" "$1"; }
info() { printf '    %s%s%s\n' "$DIM" "$1" "$RST"; }
head_() { printf '\n%s\n' "$1"; }

BLOCKERS=0
WARNINGS=0
block() { bad "$1"; BLOCKERS=$((BLOCKERS + 1)); }
soft()  { warn "$1"; WARNINGS=$((WARNINGS + 1)); }

printf '%s\n' "════════════════════════════════════════════════════════"
printf '%s\n' " NovaTV redroid 预检  ·  $(date '+%F %T')"
printf '%s\n' "════════════════════════════════════════════════════════"

# ---------------------------------------------------------------- 0. 基本身份
head_ "【0】系统"
ARCH_RAW="$(uname -m)"
info "kernel: $(uname -sr)"
info "arch:   $ARCH_RAW"
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release 2>/dev/null || true
  info "os:     ${PRETTY_NAME:-unknown}"
fi
if [ "$(id -u)" != "0" ]; then
  bad "当前不是 root，binder 模块检测会不准；请用 sudo 重跑"
  BLOCKERS=$((BLOCKERS + 1))
  IS_ROOT=0
else
  ok "root 权限"
  IS_ROOT=1
fi

case "$ARCH_RAW" in
  aarch64|arm64)   ARCH=arm64 ;;
  x86_64|amd64)    ARCH=x86_64 ;;
  armv7l|armv8l)   ARCH=arm32 ;;
  *)               ARCH=other ;;
esac
info "归一化架构: $ARCH"

# ---------------------------------------------------------------- 1. binder
head_ "【1】binder 驱动（硬性门槛）"
BINDER_OK=0

# 1a. binderfs 已挂载（redroid 推荐方式）
if [ -d /dev/binderfs ] && [ -e /dev/binderfs/binder ]; then
  ok "binderfs 已挂载且含 binder 节点"
  BINDER_OK=1
fi

# 1b. 老式 /dev/binder
if [ -e /dev/binder ]; then
  ok "/dev/binder 存在"
  BINDER_OK=1
fi

# 1c. 模块是否已加载
if command -v lsmod >/dev/null 2>&1 && lsmod 2>/dev/null | grep -q '^binder_linux'; then
  ok "binder_linux 模块已加载"
  BINDER_OK=1
fi

# 1d. 内核配置里是否编进去了（群晖多数没有 /proc/config.gz）
CFG_SRC=""
if [ -r /proc/config.gz ]; then
  CFG_SRC=/proc/config.gz
elif [ -r "/boot/config-$(uname -r)" ]; then
  CFG_SRC="/boot/config-$(uname -r)"
fi

if [ -n "$CFG_SRC" ]; then
  if [ "$CFG_SRC" = /proc/config.gz ]; then
    BINDER_CFG="$(zcat /proc/config.gz 2>/dev/null | grep -E '^CONFIG_ANDROID_BINDER' || true)"
  else
    BINDER_CFG="$(cat "$CFG_SRC" 2>/dev/null | grep -E '^CONFIG_ANDROID_BINDER' || true)"
  fi
  if [ -n "$BINDER_CFG" ]; then
    info "内核配置:"
    printf '%s\n' "$BINDER_CFG" | while IFS= read -r l; do info "  $l"; done
    case "$BINDER_CFG" in
      *CONFIG_ANDROID_BINDER_IPC=y*|*CONFIG_ANDROID_BINDER_IPC=m*|*CONFIG_ANDROID_BINDERFS=y*)
        ok "内核内置/可加载 binder"
        BINDER_OK=1
        ;;
    esac
  else
    warn "内核配置里没有 CONFIG_ANDROID_BINDER*"
  fi
else
  info "无 /proc/config.gz 与 /boot/config-*，无法读取内核配置（NAS 常见）"
fi

# 1e. 尝试现场加载（只有模块存在才行）
if [ "$BINDER_OK" != 1 ] && [ "$IS_ROOT" = 1 ]; then
  if command -v modprobe >/dev/null 2>&1; then
    if modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null; then
      ok "modprobe binder_linux 成功（模块可用）"
      BINDER_OK=1
      mkdir -p /dev/binderfs 2>/dev/null || true
      mount -t binder binder /dev/binderfs 2>/dev/null && ok "binderfs 挂载成功" || true
    else
      info "modprobe binder_linux 失败（模块不存在或不允许加载）"
    fi
  fi
fi

if [ "$BINDER_OK" != 1 ]; then
  block "binder 不可用 → redroid 起不来"
  info "群晖 DSM / 威联通 QTS 默认内核普遍不含 binder，"
  info "需要自编译签名模块，多数设备上不可行。"
fi

# ---------------------------------------------------------------- 2. ashmem
head_ "【2】ashmem / memfd"
if [ -e /dev/ashmem ]; then
  ok "/dev/ashmem 存在"
else
  KV_MAJOR="$(uname -r | cut -d. -f1 | tr -cd '0-9')"
  KV_MINOR="$(uname -r | cut -d. -f2 | tr -cd '0-9')"
  case "${KV_MAJOR}:${KV_MINOR}" in
    *[!0-9:]*|:|*:)
      soft "无法解析内核版本 $(uname -r)，ashmem 需人工确认"
      ;;
    *)
      if [ "${KV_MAJOR}" -gt 5 ] || { [ "${KV_MAJOR}" -eq 5 ] && [ "${KV_MINOR}" -ge 4 ]; }; then
        ok "内核 ${KV_MAJOR}.${KV_MINOR} 用 memfd 替代 ashmem，无需 /dev/ashmem"
      else
        soft "无 /dev/ashmem 且内核 < 5.4，可能需要 ashmem_linux 模块"
      fi
      ;;
  esac
fi

# ---------------------------------------------------------------- 3. KVM
head_ "【3】KVM（QEMU 全系统模拟时才需要）"
if [ -e /dev/kvm ]; then
  ok "/dev/kvm 存在"
  [ -r /dev/kvm ] && ok "当前用户可读 /dev/kvm" || soft "/dev/kvm 不可读，需要把容器用户加入 kvm 组"
else
  soft "无 /dev/kvm（BIOS 未开 VT-x/AMD-V，或 NAS 内核未启用）"
  info "仅影响「qemu-system-aarch64 全系统模拟」，不影响 redroid 用户态模拟"
fi

# ---------------------------------------------------------------- 4. binfmt
head_ "【4】binfmt（x86_64 跑 arm64 镜像的关键）"
if [ "$ARCH" = "x86_64" ]; then
  if [ -d /proc/sys/fs/binfmt_misc ]; then
    if ls /proc/sys/fs/binfmt_misc 2>/dev/null | grep -qi 'aarch64'; then
      ok "已注册 qemu-aarch64 binfmt"
      info "受影响的镜像可直接 docker run --platform linux/arm64"
    else
      soft "未注册 qemu-aarch64 binfmt"
      info "解决：docker run --privileged --rm tonistiigi/binfmt --install arm64"
      info "（DSM 上需要 --privileged 且内核允许 binfmt_misc 挂载）"
    fi
  else
    soft "binfmt_misc 未挂载"
    info "DSM 常把 binfmt_misc 关掉；没有它就无法在 x86 上跑 arm64 镜像"
  fi
else
  ok "宿主本身就是 $ARCH，无需跨架构转译"
fi

# ---------------------------------------------------------------- 5. docker
head_ "【5】Docker"
if command -v docker >/dev/null 2>&1; then
  ok "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'docker 命令存在但 daemon 未响应')"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ok "daemon 可访问"
    # privileged 能否用（redroid 强制要求）
    if docker run --rm --privileged alpine:3.20 true >/dev/null 2>&1; then
      ok "支持 --privileged 容器"
    else
      soft "无法运行 --privileged 容器（可能无网络拉镜像，或权限受限）"
    fi
  else
    soft "docker daemon 不可访问（需要在 root 下运行，或加入 docker 组）"
  fi
else
  block "没有 docker 命令"
  info "群晖在「套件中心 → Container Manager」，威联通在 App Center"
fi

# ---------------------------------------------------------------- 6. 资源
head_ "【6】资源"
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
DISK_GB="$(df -Pk / 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}' || echo 0)"
info "内存: ${MEM_MB} MB   根分区可用: ${DISK_GB} GB"
if [ "${MEM_MB:-0}" -lt 2048 ]; then
  soft "内存 < 2GB：redroid + ART 跑加固包会很紧，建议 ≥ 4GB 空闲"
else
  ok "内存充足"
fi
if [ "${DISK_GB:-0}" -lt 10 ]; then
  soft "磁盘可用 < 10GB：redroid 数据目录会长到数 GB"
fi

# ---------------------------------------------------------------- 结论
printf '\n%s\n' "════════════════════════════════════════════════════════"
if [ "$BLOCKERS" -eq 0 ]; then
  printf ' %s结论：无硬阻塞，可以继续（%d 个警告）%s\n' "$GRN" "$WARNINGS" "$RST"
else
  printf ' %s结论：%d 个硬阻塞，redroid 不可行%s\n' "$RED" "$BLOCKERS" "$RST"
fi
printf '%s\n' "════════════════════════════════════════════════════════"

cat <<EOF

下一步建议：
EOF

if [ "$BLOCKERS" -gt 0 ]; then
  cat <<EOF
  ${RED}这台机器跑不了 redroid${RST}（原因见上）。加固源只能走：
    1) 旧安卓手机 / TV 盒子 + Host APK  —— 成功率 100%，成本一台闲置设备
    2) 换纯 CMS 采集源                    —— 浏览器原生可播，无需任何侧车
EOF
else
  case "$ARCH" in
    arm64)
      cat <<EOF
  ${GRN}宿主是 ARM64，与加固包的 AArch64 库同架构 —— 最理想的情况${RST}
    docker compose -f sidecar/android/docker-compose.redroid.yml up -d
EOF
      ;;
    x86_64)
      cat <<EOF
  ${YEL}宿主是 x86_64，但加固包只带 ARM 的 .so，必须靠 QEMU 用户态转译：${RST}
    1) 先注册 binfmt：
       docker run --privileged --rm tonistiigi/binfmt --install arm64
    2) 起 arm64 的 redroid：
       docker compose -f sidecar/android/docker-compose.redroid.yml up -d
    3) 心理预期：ART + 加固壳在 QEMU 下启动可能 5~15 分钟，
       单次 spider 调用可能数十秒。能跑通，但别指望流畅。
    ${DIM}更稳的替代：一台旧安卓手机，成功率 100%。${RST}
EOF
      ;;
    *)
      cat <<EOF
  架构 $ARCH_RAW 不在已知范围，请把本输出发给维护者。
EOF
      ;;
  esac
fi

cat <<EOF

  无论走哪条路，Host APK 都要先构建（CI 会自动产出，见 .github/workflows/android.yml）

EOF

exit $([ "$BLOCKERS" -eq 0 ] && echo 0 || echo 1)
