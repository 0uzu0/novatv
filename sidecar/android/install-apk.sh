#!/usr/bin/env bash
# ============================================================================
# NovaTV Spider 侧车 — 安卓设备一键部署（redroid 容器 / 旧手机 / TV 盒子通用）
#
# 用法：
#   bash sidecar/android/install-apk.sh <设备IP> [token] [端口]
#   bash sidecar/android/install-apk.sh 192.168.1.50 novatv123
#   ADB_PORT=5556 bash sidecar/android/install-apk.sh 127.0.0.1 novatv123
#
# 做的事：
#   1. adb 连接（网络 ADB，默认 5555）
#   2. 安装 dist/novatv-host.apk
#   3. 按 SDK 版本选正确启动命令（API<26 只能 am startservice）
#   4. 拉 /health，校验 .so 与服务状态
#   5. 打印 NAS 端要填的环境变量
#
# 前置：设备已开「开发者选项 → ADB 调试」，且与执行机同网段。
#       redroid 容器：先 docker compose -f docker-compose.redroid-x86.yml up -d，
#       容器里 adbd 已监听 5555，直接对本机执行即可。
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

if [ -z "$IP" ]; then
  red "用法: bash sidecar/android/install-apk.sh <设备IP> [token] [端口]"
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
step "1/5 连接设备 $IP:$ADB_PORT"
"$ADB" connect "$IP:$ADB_PORT" 2>&1 | sed 's/^/  /'
DEVS="$("$ADB" devices | tr -d '\r' | awk -F'\t' 'NR>1 && $2=="device"{print $1}')"
if ! printf '%s\n' "$DEVS" | grep -qx "$IP:$ADB_PORT"; then
  red "连接失败。逐项检查："
  echo "  - 设备与执行机是否同网段（redroid 容器直接对 127.0.0.1 即可）"
  echo "  - 开发者选项里「ADB 调试 / USB 调试」是否打开"
  echo "  - 若走 USB：直接 adb devices 看序列号，不用 connect"
  echo "  当前在线设备："; printf '%s\n' "${DEVS:-（无）}" | sed 's/^/    /'
  exit 1
fi
grn "已连接"

SHELL_GET() { "$ADB" -s "$IP:$ADB_PORT" shell "$@" 2>/dev/null | tr -d '\r'; }
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
"$ADB" -s "$IP:$ADB_PORT" install -r "$APK" 2>&1 | sed 's/^/  /'

# ---------------------------------------------------------------- 3 启动
step "3/5 启动侧车服务"
if [ "${SDK:-0}" -ge 26 ] 2>/dev/null; then
  CMD="am start-foreground-service"
else
  CMD="am startservice"
fi
echo "  命令: $CMD （SDK=${SDK:-?}；API 26 才支持 start-foreground-service）"
"$ADB" -s "$IP:$ADB_PORT" shell $CMD -n "$SVC" --es token "$TOKEN" --ez lan true 2>&1 | sed 's/^/  /'

# ---------------------------------------------------------------- 4 验证
step "4/5 等待服务并验证"
HE=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  HE="$(curl -s -m 4 "http://$IP:$PORT/health?token=$TOKEN" 2>/dev/null)"
  [ -n "$HE" ] && break
done

if [ -z "$HE" ]; then
  red "  /health 无响应（10 秒）"
  echo "  看服务日志："
  "$ADB" -s "$IP:$ADB_PORT" logcat -d -s NovaTVHost 2>/dev/null | tail -20 | sed 's/^/    /'
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
cat <<EOF
  在 NAS 的 docker-compose.yml（或 .env）里加：

    environment:
      SPIDER_ANDROID_URL: "http://$IP:$PORT"
      SPIDER_TOKEN: "$TOKEN"

  然后 docker compose up -d，再用这条验证加固源是否转为可播：

    curl -s http://NAS_IP:8890/api/sources \\
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const j=JSON.parse(s);
          const hard=j.sites.filter(x=>x.runtime==="jar-spider");
          console.log("加固源", hard.length, "| 支持", hard.filter(x=>x.supported).length);
        })'
EOF
