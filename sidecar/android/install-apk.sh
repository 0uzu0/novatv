#!/usr/bin/env bash
# ============================================================================
# NovaTV Spider 侧车 — 安卓设备一键部署（redroid 容器 / 旧手机 / TV 盒子通用）
#
# 用法：
#   bash sidecar/android/install-apk.sh <设备IP> [token] [端口]
#   bash sidecar/android/install-apk.sh 192.168.1.50 novatv123
#   ADB_PORT=15555 bash sidecar/android/install-apk.sh 127.0.0.1 novatv123
#
#   容器/模拟器部署时 ADB 端口一律是 15555（宿主 adb server 占着 5555，
#   编排里特意映射成 15555:5555）。
#
# 做的事：
#   1. adb 连接（网络 ADB，默认 5555）
#   2. 安装 dist/novatv-host.apk
#   3. 按 SDK 版本选正确启动命令（API<26 只能 am startservice）
#   4. adb forward 打通 8899，绕开容器网络与 QEMU NAT
#   5. 拉 /health，校验 .so 与服务状态
#   6. 打印 NAS 端要填的环境变量
#
# 前置：设备已开「开发者选项 → ADB 调试」，且与执行机同网段。
#       容器形态二选一，先起容器再跑本脚本：
#         redroid（需宿主 binder）：docker compose -f sidecar/android/docker-compose.redroid-x86.yml up -d
#         QEMU  （需 /dev/kvm）    ：docker compose -f sidecar/android/docker-compose.qemu-android.yml up -d
# ============================================================================
set -uo pipefail

IP="${1:-}"
TOKEN="${2:-novatv123}"
PORT="${3:-8899}"
ADB_PORT="${ADB_PORT:-5555}"
PKG="novatv.host"
SVC="$PKG/.HostService"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APK="${APK:-$ROOT/dist/novatv-host.apk}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }

if [ -z "$IP" ] && [ -z "${ADB_SERIAL:-}" ]; then
  red "用法: bash sidecar/android/install-apk.sh <设备IP> [token] [端口]"
  echo "  走 USB 线时可省掉 IP：ADB_SERIAL=<序列号> bash $0 '' novatv123"
  exit 1
fi

# ---------------------------------------------------------------- 找 adb
ADB=""
for c in adb \
         "${ANDROID_HOME:-}/platform-tools/adb" \
         "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
         "$HOME/AppData/Local/Android/Sdk/platform-tools/adb" \
         "/c/Users/$USER/AppData/Local/Android/Sdk/platform-tools/adb"; do
  [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && { ADB="$c"; break; }
done
if [ -z "$ADB" ]; then
  red "找不到 adb。安装 Android SDK platform-tools，或设置 ANDROID_HOME。"
  exit 1
fi
grn "adb: $ADB"

# ---------------------------------------------------------------- 1 连接
# ADB_SERIAL 非空 → 直接用它（USB 直连，或已手动连好的无线设备），跳过 connect。
# 空 → 走网络 ADB：adb connect <IP>:<端口>。
SERIAL="${ADB_SERIAL:-}"
if [ -n "$SERIAL" ]; then
  step "1/5 使用已连接设备 $SERIAL"
else
  step "1/5 连接设备 $IP:$ADB_PORT"
  "$ADB" connect "$IP:$ADB_PORT" 2>&1 | sed 's/^/  /'
  SERIAL="$IP:$ADB_PORT"
fi

DEVS="$("$ADB" devices | tr -d '\r' | awk -F'\t' 'NR>1 && $2=="device"{print $1}')"
if ! printf '%s\n' "$DEVS" | grep -qx "$SERIAL"; then
  red "连接失败：$SERIAL 不在设备列表里"
  echo "  当前在线设备："; printf '%s\n' "${DEVS:-（无）}" | sed 's/^/    /'
  echo
  echo "  按你的连接方式对号入座："
  echo "  ┌ USB 线连这台电脑"
  echo "  │   1) 手机：开发者选项 → USB 调试"
  echo "  │   2) adb devices            # 看到序列号（不是 IP:端口）"
  echo "  │   3) ADB_SERIAL=<序列号> bash $0 $IP $TOKEN"
  echo "  ├ Android 11+ 无线调试（端口随机，必须先配对）"
  echo "  │   1) 手机：开发者选项 → 无线调试 → 使用配对码配对"
  echo "  │   2) adb pair <IP>:<配对端口>     # 输入手机上那 6 位码"
  echo "  │   3) ADB_PORT=<调试端口> bash $0 $IP $TOKEN"
  echo "  └ Android 10 及以下（固定 5555）"
  echo "      1) USB 连一次：adb tcpip 5555"
  echo "      2) 拔线：bash $0 $IP $TOKEN"
  echo
  echo "  另外确认：手机与执行机同网段；手机连的是 Wi-Fi 不是仅 USB 网络共享。"
  exit 1
fi
grn "已连接: $SERIAL"

SHELL_GET() { "$ADB" -s "$SERIAL" shell "$@" 2>/dev/null | tr -d '\r'; }

# USB 模式没给 IP：从设备 wlan0 读一个，健康检查要用它
if [ -z "$IP" ]; then
  IP="$(SHELL_GET ip addr show wlan0 2>/dev/null | grep 'inet ' | head -1 | awk '{print $2}' | cut -d/ -f1)"
  if [ -z "$IP" ]; then
    IP="$(SHELL_GET ip route 2>/dev/null | grep -oE 'src [0-9.]+' | head -1 | awk '{print $2}')"
  fi
  if [ -n "$IP" ]; then
    ylw "  未指定 IP，已从设备读到: $IP"
  else
    ylw "  未指定 IP 且读不到（可能只连了 USB 网络共享）。请显式传 IP 参数。"
  fi
fi
SDK="$(SHELL_GET getprop ro.build.version.sdk)"
REL="$(SHELL_GET getprop ro.build.version.release)"
ABI="$(SHELL_GET getprop ro.product.cpu.abi)"
echo "  系统: Android ${REL:-?} (API ${SDK:-?})   ABI: ${ABI:-?}"

case "$ABI" in
  arm64*|armeabi*) ;;
  *) ylw "  警告：ABI=$ABI 不是 arm，加固包的 .so 只有 arm 版本，加载会失败" ;;
esac

# ---------------------------------------------------------------- 2 安装
step "2/5 安装 APK"
if [ ! -f "$APK" ]; then
  red "APK 不存在: $APK"
  echo "  构建：cd sidecar/android/host-apk && gradle assembleDebug"
  echo "  拷贝：cp app/build/outputs/apk/debug/app-debug.apk \"$ROOT/dist/novatv-host.apk\""
  exit 1
fi
"$ADB" -s "$SERIAL" install -r "$APK" 2>&1 | sed 's/^/  /'

# ---------------------------------------------------------------- 3 启动
step "3/5 启动侧车服务"
if [ "${SDK:-0}" -ge 26 ] 2>/dev/null; then
  CMD="am start-foreground-service"
else
  CMD="am startservice"
fi
echo "  命令: $CMD （SDK=${SDK:-?}；API 26 才支持 start-foreground-service）"
"$ADB" -s "$SERIAL" shell $CMD -n "$SVC" --es token "$TOKEN" --ez lan true 2>&1 | sed 's/^/  /'

# ---------------------------------------------------------------- 3.5 端口转发
# 为什么需要这一步：
#   容器 / 模拟器里的 Android 有自己的网络命名空间或 QEMU NAT，
#   宿主/执行机 ping 得到它的端口，却不一定连得通（QEMU 的 guest IP 是 10.0.2.15，
#   宿主根本路由不到）。adb forward 把执行机的 localhost:8899 直接捅到设备内网卡，
#   绕开所有端口映射和 NAT 问题 —— 对 redroid、QEMU 模拟器、真机都成立。
step "3.5/5 建立 adb 端口转发"
FORWARDED=0
# -a = 监听所有网卡。这一位不能省：主服务跑在容器里，它眼里的「宿主」
# 是 docker0 网桥（host.docker.internal），而 adb forward 默认只绑 127.0.0.1，
# 容器侧连不上，会表现为「主服务报侧车不可用、但宿主 curl 明明是通的」。
if "$ADB" -a -s "$SERIAL" forward "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1; then
  grn "  0.0.0.0:$PORT → 设备内 $PORT（局域网可达，有 token 保护）"
  FORWARDED=1
else
  ylw "  adb forward 失败（真机直连不受影响；容器/模拟器部署才依赖它）"
fi

# ---------------------------------------------------------------- 4 验证
step "4/5 等待服务并验证"
HE=""
HEALTH_URL=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  # 先试转发通道，再试直连 IP。
  # --noproxy '*' 必须加：执行机若设了 HTTP_PROXY（Clash/v2ray 很常见），
  # curl 会把局域网 IP 也丢给代理，结果永远是"无响应"——而服务其实是好的。
  if [ "$FORWARDED" = 1 ]; then
    HE="$(curl -s -m 4 --noproxy '*' "http://127.0.0.1:$PORT/health?token=$TOKEN" 2>/dev/null)"
    [ -n "$HE" ] && { HEALTH_URL="http://127.0.0.1:$PORT"; break; }
  fi
  HE="$(curl -s -m 4 --noproxy '*' "http://$IP:$PORT/health?token=$TOKEN" 2>/dev/null)"
  [ -n "$HE" ] && { HEALTH_URL="http://$IP:$PORT"; break; }
done

if [ -z "$HE" ]; then
  red "  /health 无响应（10 秒，已试转发通道与直连）"
  echo "  看服务日志："
  "$ADB" -s "$SERIAL" logcat -d -s NovaTVHost 2>/dev/null | tail -20 | sed 's/^/    /'
  echo "  常见原因：服务被系统冻结 / 不是 lan=true / 端口被占 / 设备非 Android"
  exit 1
fi

echo "$HE" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try { j=JSON.parse(s) } catch(e) { console.log("  "+s.slice(0,300)); process.exit(1) }
  const g=(k,v)=>console.log("  "+k.padEnd(12)+String(v));
  g("ok", j.ok);
  g("android", j.android+" (API "+j.sdk+")");
  g("abi", j.abi);
  g("model", j.model);
  g("监听", j.host+":"+j.port);
  const libs=j.libs||[];
  g("native库", libs.length?libs.join(", "):"❌ 空！.so 没打进 APK");
  g("jar", j.jarExists?("已就位 "+j.jarBytes+"B"):"未下载（首次调用时自动拉）");
  const ie=j.initErrors||{};
  const ke=Object.keys(ie);
  g("initErrors", ke.length?("❌ "+ke.map(k=>ie[k]).join(" | ").slice(0,200)):"无");
  console.log("");
  if (!j.ok) console.log("  ❌ 服务异常");
  else if (!libs.length) console.log("  ❌ 关键问题：native 库没进 APK");
  else if (ke.length) console.log("  ⚠️  加固壳解密异常，把上面 initErrors 发我");
  else console.log("  ✅ 侧车就绪");
});' || true

# ---------------------------------------------------------------- 5 下一步
step "5/5 NAS 端配置"
# 侧车地址取哪个，取决于刚才哪条通道通了：
#   走直连 → 直接用设备 IP（真机 / 已映射端口的容器）
#   走转发 → 说明设备藏在 NAT 或容器网络后面，NAS 那边不能照抄 127.0.0.1
if [ "$HEALTH_URL" = "http://127.0.0.1:$PORT" ] && [ "$FORWARDED" = 1 ]; then
  SIDECAR_HINT="http://host.docker.internal:$PORT"
  cat <<EOF
  注意：本次是靠 adb forward 才连上的，说明侧车在容器/模拟器里、藏在 NAT 后面。
  「宿主能 curl 通」不等于「主服务容器也能通」，别把 127.0.0.1 抄进去。

  ${ylw}主服务跑在同一台机器的 Docker 里（最常见）${RST}，填这个：

    SPIDER_ANDROID_URL=http://host.docker.internal:$PORT

  前提是主服务的编排里有这一行（docker-compose.nas.yml 已经写好了）：

    extra_hosts:
      - "host.docker.internal:host-gateway"

  ${DIM}说明：上面的 0.0.0.0:$PORT 监听在宿主，容器通过 docker0 网桥访问得到。${RST}

  ${ylw}主服务和侧车不是同一台机器${RST}，改填执行机的局域网地址：

    SPIDER_ANDROID_URL=http://<执行机局域网IP>:$PORT

EOF
else
  SIDECAR_HINT="http://$IP:$PORT"
fi

cat <<EOF
  在 NAS 的 docker-compose.yml（或 .env）里加：

    environment:
      SPIDER_ANDROID_URL: "$SIDECAR_HINT"
      SPIDER_TOKEN: "$TOKEN"

  然后 docker compose up -d，再用这条验证加固源是否转为可播：

    curl -s http://NAS_IP:8890/api/sources \\
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const j=JSON.parse(s);
          const hard=j.sites.filter(x=>x.runtime==="jar-spider");
          console.log("加固源", hard.length, "| 支持", hard.filter(x=>x.supported).length);
        })'
EOF
