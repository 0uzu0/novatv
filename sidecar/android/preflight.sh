#!/usr/bin/env bash
# ============================================================================
# NovaTV · redroid 可行性预检
#
# 目的：在 NAS 上花 10 秒判断「这台机器能用哪条路线跑 Android 侧车」，
#      避免在注定失败的平台上折腾内核模块。
#
# 两条互不依赖的通道（只需要通一条）：
#   A. redroid（容器化 Android）  —— 共享宿主内核，门槛 = binder
#   B. QEMU 虚拟机（真模拟器）    —— 自带 Android 内核，门槛 = KVM
# B 的意义：群晖 / 威联通官方内核不给 binder，A 直接死，但 B 照样能跑。
#
# 用法（NAS 上以 root 执行）：
#   sudo bash sidecar/android/preflight.sh
#
# 检测项与真实门槛（不是"建议"，是硬性条件）：
#   1. binder  —— Android 的 IPC 驱动。走 A 路线时，宿主内核没有
#                 CONFIG_ANDROID_BINDER_IPC 就起不来，且 redroid 无法自带
#   2. arch    —— 加固包的 .so 只有 ARMv7 / AArch64，没有 x86 版本。
#                 x86_64 宿主必须靠镜像自带的 Native Bridge（libndk / libhoudini）
#                 就地翻译；qemu 全栈模拟仅作兜底。见 X86-NAS.md
#   3. KVM     —— 走 B 路线的硬性门槛。binder 由 guest 内核提供，与宿主无关
#   4. binfmt  —— 走 qemu-user 兜底路线时，内核要注册 qemu-aarch64 处理器
#                 （Native Bridge 路线不需要，别多注册，否则会覆盖翻译层）
#
# 退出码：0 = 至少一条路线可行；1 = 两条都不通（看输出最后的「结论」）
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
# 两条互不依赖的技术通道，分开评估：
#   REDROID_OK —— 容器化 Android，共享宿主内核，门槛是 binder
#   QEMU_OK    —— 虚拟机里的 Android，自带内核，门槛是 KVM
# 二者只需要一条通，所以「没 binder」不等于「这条路封死」。
REDROID_OK=0
QEMU_OK=0
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
  bad "binder 不可用 → redroid（容器化 Android）这条路封死"
  info "群晖 DSM / 威联通 QTS / 飞牛 fnOS 官方内核普遍不带 binder，"
  info "自编签名模块在多数机型上不可行。"
  info "但这【只】封死 redroid：下面【3】若检出 KVM，"
  info "QEMU 虚拟机路线完全不受影响 —— binder 由 guest 的 Android 内核提供，"
  info "与宿主内核无关。见 docker-compose.qemu-android.yml"
else
  REDROID_OK=1
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
head_ "【3】KVM（路线 B「虚拟机里的 Android」的生死线）"
VCPUS="$(grep -c -E '^flags.*(vmx|svm)' /proc/cpuinfo 2>/dev/null)" || true
VCPUS="${VCPUS:-0}"
if [ -e /dev/kvm ]; then
  ok "/dev/kvm 存在 → 可以跑硬件加速的 Android 虚拟机"
  QEMU_OK=1
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    ok "当前用户可读写 /dev/kvm"
  else
    soft "当前 shell 用户读不了 /dev/kvm（需 root 或在 kvm 组）"
  fi

  # /dev/kvm 默认是 root:kvm 660。容器里的模拟器进程常以非 root 用户跑，
  # 只加 --device 会把「属主 root、权限 660」原样带进容器，非 root 用户照样打不开，
  # 报 permission denied —— 这一步没配好，会被误判成「KVM 没开」。
  KVM_GID="$(stat -c '%g' /dev/kvm 2>/dev/null || echo '')"
  KVM_GRP="$(stat -c '%G' /dev/kvm 2>/dev/null || echo 'kvm')"
  if [ -n "$KVM_GID" ]; then
    POSIX_PERM="$(stat -c '%a' /dev/kvm 2>/dev/null || echo '')"
    info "设备节点: ${KVM_GRP} 组, gid=${KVM_GID}, 权限=${POSIX_PERM}"
    case "$POSIX_PERM" in
      66[06]|*7*)
        ok "组内可读写，容器里加 group_add 即可"
        info "编排里补一行（本次已在 compose 中预留注释）："
        info "  group_add: [\"${KVM_GID}\"]"
        ;;
      *)
        soft "权限位 ${POSIX_PERM} 异常，容器内可能打不开"
        ;;
    esac
  fi
else
  if [ "${VCPUS}" -gt 0 ] 2>/dev/null; then
    soft "CPU 支持虚拟化（${VCPUS} 个核带 vmx/svm），但 /dev/kvm 没出来"
    info "常见原因是 BIOS 里 VT-x/AMD-V 没开，或内核没加载 kvm 模块："
    info "  lsmod | grep -E 'kvm_intel|kvm_amd'"
    info "  sudo modprobe kvm_intel      # AMD 平台换成 kvm_amd"
    info "群晖：装了 Virtual Machine Manager 就说明 KVM 可用，照它的配置抄"
  else
    bad "CPU 不支持硬件虚拟化 → 虚拟机路线也走不通"
    info "部分低端 Atom / 赛扬不带 VT-x，BIOS 里也开不出来"
  fi
  info "（注意：没有 KVM 容器仍能起来，但会退化成 TCG 纯软件模拟，"
  info " Android 冷启动 10~40 分钟，dex 调用数十秒，只够离线爬虫用）"
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
if [ "$BLOCKERS" -gt 0 ]; then
  printf ' %s结论：%d 个全局阻塞（缺 docker 等），两条容器路线都不通%s\n' "$RED" "$BLOCKERS" "$RST"
elif [ "$REDROID_OK" = 1 ]; then
  printf ' %s结论：binder 可用 → 走 redroid（最省资源，%d 个警告）%s\n' "$GRN" "$WARNINGS" "$RST"
elif [ "$QEMU_OK" = 1 ]; then
  printf ' %s结论：无 binder 但有 KVM → 走 QEMU 虚拟机路线%s\n' "$YEL" "$RST"
else
  printf ' %s结论：binder 与 KVM 都不具备，容器路线封闭%s\n' "$RED" "$RST"
fi
printf '%s\n' "════════════════════════════════════════════════════════"

cat <<EOF

下一步建议：
EOF

if [ "$BLOCKERS" -gt 0 ]; then
  cat <<EOF
  ${RED}容器路线缺前提${RST}（原因见上）。可选：
    1) 装好 Docker（群晖「Container Manager」/ 威联通「Container Station」）后重跑本脚本
    2) 旧安卓手机 / TV 盒子 + Host APK  —— 成功率 100%，成本一台闲置设备
EOF
elif [ "$REDROID_OK" != 1 ] && [ "$QEMU_OK" = 1 ]; then
  cat <<EOF
  ${GRN}redroid 走不通，但 KVM 在 → 换「虚拟机里的 Android」，一样是 Docker，一条命令${RST}

  这条路和 redroid 的本质区别：Android 带自己的内核，binder 由 guest 提供，
  所以宿主内核有没有 binder_linux 这件事，跟它没关系。

    docker compose -f sidecar/android/docker-compose.qemu-android.yml up -d
    docker logs -f novatv-android-emu        # 等 "boot completed"，首次 2~5 分钟
    ADB_PORT=15555 bash sidecar/android/install-apk.sh 127.0.0.1 novatv123

  ${YEL}这条路自己的不确定点只有一个：ARM 翻译${RST}
  加固包的 .so 只有 ARM 版，x86_64 的 Android 必须有 libndk_translation 才装得上。
  装完先验这一步（脚本第 4 步如果报 NO_MATCHING_ABIS 就是这里的问题）：

    adb -s 127.0.0.1:15555 shell dumpsys package novatv.host | grep -i abi
    期望 primaryCpuAbi=arm64-v8a；若是 x86_64 或装不上，换 Play Store 版 system image

  ${DIM}资源要求：至少 2 核 4GB 分给它，且 BIOS 的 VT-x 必须真的开着。${RST}
EOF
elif [ "$REDROID_OK" = 1 ]; then
  case "$ARCH" in
    arm64)
      cat <<EOF
  ${GRN}宿主是 ARM64，与加固包的 AArch64 库同架构 —— 最理想的情况${RST}
    docker compose -f sidecar/android/docker-compose.redroid.yml up -d
    ADB_PORT=15555 bash sidecar/android/install-apk.sh 127.0.0.1 novatv123
EOF
      ;;
    x86_64)
      cat <<EOF
  ${YEL}宿主是 x86_64，加固包只带 ARM 的 .so，必须靠翻译层。两条，优先第 1 条：${RST}

  ${GRN}1) Native Bridge（推荐，接近原生速度）${RST}
       x86 的 redroid 有自带 libndk_translation / libhoudini 的镜像，
       装 arm64 APK 时由系统把 arm 指令就地翻译，不需要 qemu 全栈模拟：
       docker compose -f sidecar/android/docker-compose.redroid-x86.yml up -d
       ADB_PORT=15555 bash sidecar/android/install-apk.sh 127.0.0.1 novatv123
       装完必须确认走了翻译：adb -s 127.0.0.1:15555 shell dumpsys package novatv.host | grep -i abi
       应显示 primaryCpuAbi=arm64-v8a；若显示 x86_64 或报 NO_MATCHING_ABIS，
       说明该镜像不带翻译层，换 erstt/redroid:*_houdini_* tag。
       详见 sidecar/android/X86-NAS.md

  ${YEL}2) QEMU 虚拟机（第二条独立通道，redroid 失败时的备份方案）${RST}
       docker compose -f sidecar/android/docker-compose.qemu-android.yml up -d
       只要有 /dev/kvm 就能跑，不依赖 binder；
       代价是镜像数 GB、内存要 4G，比 redroid 重。

  ${DIM}注意：Native Bridge 同样要求内核有 binder_linux 与 binfmt_misc；
        群晖 DSM / 威联通 QTS 基本无解，那种机器直接看上面第 2 条。${RST}
  ${DIM}成功率最高仍是：一台旧安卓手机 / TV 盒子，100%。${RST}
EOF
      ;;
    *)
      cat <<EOF
  架构 $ARCH_RAW 不在已知范围，请把本输出发给维护者。
EOF
      ;;
  esac
else
  cat <<EOF
  ${RED}binder 与 KVM 都不具备，容器路线到此为止${RST}。加固源只能走：
    1) 旧安卓手机 / TV 盒子 + Host APK  —— 成功率 100%，成本一台闲置设备
    2) 换纯 CMS 采集源                    —— 浏览器原生可播，无需任何侧车
EOF
fi

cat <<EOF

  无论走哪条路，Host APK 都要先构建（CI 会自动产出，见 .github/workflows/android.yml）

EOF

# 退出码语义：0 = 至少有一条容器路线可行；1 = 两条都不通
if [ "$BLOCKERS" -gt 0 ] || { [ "$REDROID_OK" != 1 ] && [ "$QEMU_OK" != 1 ]; }; then
  exit 1
fi
exit 0
