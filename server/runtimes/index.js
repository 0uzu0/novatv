/**
 * 运行时能力矩阵：告诉调用方"每个源靠什么跑、缺什么、怎么补"
 *
 * 四类运行时（对应 TVBox 生态的真实边界）：
 *   cms      纯 HTTP 采集（macCMS JSON/XML）          —— 服务端原生
 *   js       drpy/hipy 系 JS 源（原本要 QuickJS）      —— 内置 Node 运行时，已可用
 *   jvm      未加固的 spider jar                       —— 需 JVM 侧车（java 已就绪）
 *   android  Android 加固包（dex + .so + guard）       —— 只能真 Android 容器（redroid/真机/云机）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SIDECAR_DIR = path.resolve(__dirname, '..', '..', 'sidecar');

let javaCache = null;
export function javaVersion() {
  if (javaCache !== null) return javaCache;
  try {
    const r = spawnSync('java', ['-version'], { timeout: 4000, encoding: 'utf8' });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    javaCache = text.split('\n')[0].trim();
  } catch {
    javaCache = '';
  }
  return javaCache;
}

export function sidecarUrls() {
  const bridge = process.env.SPIDER_BRIDGE_URL || '';
  return {
    // 本机默认端口：JVM 侧车 8899 / Android 侧车 8898（adb forward）
    jvm: process.env.SPIDER_JVM_URL || (bridge && !/android/i.test(bridge) ? bridge : '') || 'http://127.0.0.1:8899',
    android: process.env.SPIDER_ANDROID_URL || (/android/i.test(bridge) ? bridge : '') || 'http://127.0.0.1:8898',
    generic: bridge,
  };
}

async function ping(base, timeout = 900) {
  if (!base) return { configured: false, up: false };
  try {
    // 侧车开了 token 时必须带，否则健康检查会误判为 down
    const headers = process.env.SPIDER_TOKEN ? { 'X-Nova-Token': process.env.SPIDER_TOKEN } : {};
    const res = await fetch(base.replace(/\/$/, '') + '/health', { headers, signal: AbortSignal.timeout(timeout) });
    const body = await res.json().catch(() => ({}));
    return { configured: true, up: res.ok, url: base, body };
  } catch (e) {
    return { configured: true, up: false, url: base, error: e.message };
  }
}

export function androidArtifacts() {
  const files = [
    'android/docker-compose.yml',
    'android/README.md',
    'android/host-apk/README.md',
    'android/host-apk/app/src/main/java/novatv/host/HostService.java',
    'android/host-apk/app/src/main/AndroidManifest.xml',
  ];
  return files.map((f) => ({ file: f, present: fs.existsSync(path.join(SIDECAR_DIR, f)) }));
}

/** 完整能力矩阵（含每个运行时的启用方式与限制） */
export async function capabilityMatrix({ spider = null } = {}) {
  const urls = sidecarUrls();
  const [jvm, android] = await Promise.all([ping(urls.jvm), ping(urls.android)]);
  const java = javaVersion();

  return {
    checkedAt: new Date().toISOString(),
    runtimes: [
      {
        id: 'cms-json',
        label: 'CMS 采集接口',
        engine: 'Node 原生 HTTP',
        available: true,
        supportedTypes: ['type=0', 'type=1'],
        note: 'macCMS JSON / XML 直接抓取，无需任何外部运行时',
      },
      {
        id: 'js-spider',
        label: 'JS spider（drpy / hipy）',
        engine: '内置 Node JS 运行时',
        available: true,
        supportedTypes: ['type=3 + api=.js'],
        note: '复刻 TVBox QuickJS 宿主 API（req/pdfh/pdfa/pd/joinUrl/local），同步 curl 后端保证 drpy2 的阻塞语义',
        caps: ['esm-graph', 'assets-resolve', 'cheerio', 'crypto-js', 'sync-http', 'sniff'],
      },
      {
        id: 'jar-spider',
        label: 'JVM spider jar（未加固）',
        engine: java ? `本地 JDK · ${java}` : 'JDK 缺失',
        // 能不能跑取决于侧车是否在线；有 JDK 只是"起得来"
        available: Boolean(jvm.up),
        jdk: java || null,
        supportedTypes: ['type=3 + api=csp_*（未加固 jar）'],
        note: jvm.up
          ? '侧车在线，可直接调用'
          : java
            ? '本机有 JDK，起 sidecar/jvm 侧车（node scripts/jvm-sidecar.mjs）后即可用'
            : '需要先安装 JDK 21+ 或改用 Android 侧车',
        sidecar: jvm,
      },
      {
        id: 'android-spider',
        label: 'Android 加固 spider（csp_*）',
        engine: 'Android 容器 + Host APK',
        available: Boolean(android.up),
        supportedTypes: ['type=3 + api=csp_*（dex + .so + guard）'],
        note:
          '加固包的字节码在运行时才由 native 层解密，JVM/QuickJS 都无法加载；只能真 Android（redroid 容器 / 真机 / 云机）',
        sidecar: android,
        artifacts: androidArtifacts(),
      },
    ],
    spider,
  };
}

/** 某个运行时是否可用（供站点 supported 判定） */
export function runtimeSupported(runtime, matrix) {
  if (runtime === 'cms-json' || runtime === 'cms-xml') return true;
  if (runtime === 'js-spider') return true;
  if (runtime === 'jar-spider' || runtime === 'remote-spider') {
    const rt = matrix?.runtimes || [];
    return rt.some((r) => (r.id === 'jar-spider' || r.id === 'android-spider') && r.available);
  }
  return false;
}
