/**
 * 把 FongMi/CatVodSpider 的**开源站点实现**编译成 JVM 侧车能直接加载的 jar。
 *
 * 为什么需要这个：
 *   加固包（csp_*Guard）里的站点逻辑，有一部分在 CatVodSpider 仓库里有开源 Java 实现。
 *   把开源实现编译成 .class jar，就能跑在纯 JVM 侧车上——完全不需要 Android / redroid。
 *   实测 Kanqiu（88kanqiu.one 体育赛程）在侧车里能正常抓数据。
 *
 * 用法：
 *   node scripts/oss-spider.mjs --list                # 看哪些配置里的源有开源版本
 *   node scripts/oss-spider.mjs                       # 编译默认站点集合
 *   node scripts/oss-spider.mjs --sites Kanqiu,Bili   # 只编指定站点
 *   node scripts/oss-spider.mjs --ref 91cb48b         # 换个源码快照（默认 2024-01，站点最全）
 *
 * 产物：
 *   sidecar/jvm/build/oss-spiders.jar   第三方站点 jar（含 jar 自带的 Spider 基类）
 *   sidecar/jvm/libs/*.jar              运行时依赖（okhttp/jsoup/org.json/...）
 *
 * 原理说明（为什么不冲突）：
 *   侧车用 ChildFirstClassLoader，jar 里的 com.github.catvod.* 优先于侧车自己的占位类，
 *   派发走反射（新签名优先、旧签名兜底），所以「自带基类」的第三方 jar 能直接跑。
 *   详见 sidecar/jvm/src/novatv/Sidecar.java 顶部注释。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'tools', 'openspider');
const REFS = path.join(WORK, 'refs', 'CatVodSpider');
const SRC = path.join(WORK, 'src');
const CLASSES = path.join(WORK, 'classes');
const LIBS = path.join(ROOT, 'sidecar', 'jvm', 'libs');
const OUT_JAR = path.join(ROOT, 'sidecar', 'jvm', 'build', 'oss-spiders.jar');
/** 侧车自身的 class 目录：编译开源站点时要用它补 BuildConfig 等占位类 */
const SIDECAR_CLASSES = path.join(ROOT, 'sidecar', 'jvm', 'build', 'classes');
const SIDECAR_SRC = path.join(ROOT, 'sidecar', 'jvm', 'src');
/**
 * 「Android 构建期产物」桩目录。
 * 注意只放 BuildConfig 这类独立小类：**不能**把侧车的 com.github.catvod.crawler.Spider
 * 一起挂进来，否则会盖掉源码树自带的 Spider（签名不同，全员编译失败）。
 */
const STUBS = path.join(WORK, 'stubs');

const REPO = 'https://github.com/FongMi/CatVodSpider.git';
/** 2024-01 是「站点源码最全」的最后一个快照（44 个站点），之后逐步清理到只剩 10 个 */
const DEFAULT_REF = '91cb48b';
const DEFAULT_SITES = ['Kanqiu', 'Bili', 'FirstAid', 'XPath', 'Dm84', 'Wogg', 'AppYsV2', 'WebDAV'];

/** 运行时依赖：gradle 缓存里找得到就用本地的，找不到从 maven 下 */
const DEPS = [
  {
    file: 'okhttp-4.12.0.jar',
    url: 'https://repo1.maven.org/maven2/com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.jar',
    gradle: 'com.squareup.okhttp3/okhttp/4.12.0',
  },
  {
    file: 'okio-jvm-3.9.0.jar',
    url: 'https://repo1.maven.org/maven2/com/squareup/okio/okio-jvm/3.9.0/okio-jvm-3.9.0.jar',
    gradle: 'com.squareup.okio/okio-jvm/3.9.0',
  },
  {
    file: 'kotlin-stdlib-1.9.23.jar',
    url: 'https://repo1.maven.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/1.9.23/kotlin-stdlib-1.9.23.jar',
    gradle: 'org.jetbrains.kotlin/kotlin-stdlib',
  },
  {
    file: 'gson-2.10.1.jar',
    url: 'https://repo1.maven.org/maven2/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar',
    gradle: 'com.google.code.gson/gson/2.10.1',
  },
  {
    file: 'jsoup-1.17.2.jar',
    url: 'https://repo1.maven.org/maven2/org/jsoup/jsoup/1.17.2/jsoup-1.17.2.jar',
  },
  {
    file: 'json-20240303.jar',
    url: 'https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar',
  },
  {
    file: 'juniversalchardet-1.0.3.jar',
    url: 'https://repo1.maven.org/maven2/com/googlecode/juniversalchardet/juniversalchardet/1.0.3/juniversalchardet-1.0.3.jar',
  },
  {
    // XPath 站点爬虫用 JXDocument 解析规则，TVBox 生态标配
    file: 'JsoupXpath-2.5.1.jar',
    url: 'https://repo1.maven.org/maven2/cn/wanghaomiao/JsoupXpath/2.5.1/JsoupXpath-2.5.1.jar',
  },
  {
    // ProxyVideo 内置本地 HTTP 服务，Bili / Wogg / Push 都走这条链
    file: 'nanohttpd-2.3.1.jar',
    url: 'https://repo1.maven.org/maven2/org/nanohttpd/nanohttpd/2.3.1/nanohttpd-2.3.1.jar',
  },
  {
    // QRCode 工具类生成登录二维码（Bili / Push / Wogg 的网盘与账号登录）
    file: 'zxing-core-3.5.3.jar',
    url: 'https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar',
  },
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.slice(0, 3).join(' ')} … 失败（exit ${r.status}）`);
    process.exit(r.status || 1);
  }
}

function walkJava(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJava(p));
    else if (p.endsWith('.java')) out.push(p);
  }
  return out;
}

function findJarTool() {
  const cands = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'jar.exe'),
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'jar'),
    'C:/Program Files/Java/jdk-21/bin/jar.exe',
    'C:/Program Files/Java/jdk-17/bin/jar.exe',
    '/usr/bin/jar',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'jar';
}

/** 编译期需要一个 android.jar 做 API 桩；运行时不需要（侧车有自己的 android stub） */
function findAndroidJar() {
  const probe = path.join(ROOT, 'sidecar', 'android', 'host-apk', 'local.properties');
  const roots = [];
  if (fs.existsSync(probe)) {
    const m = fs.readFileSync(probe, 'utf8').match(/^sdk\.dir=(.+)$/m);
    if (m) roots.push(m[1].replace(/\\:/g, ':').replace(/\\\\/g, '/').replace(/\\/g, '/').trim());
  }
  for (const k of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) if (process.env[k]) roots.push(process.env[k]);
  roots.push('C:/Users/ZT/AppData/Local/Android/Sdk');
  for (const r of roots) {
    const pf = path.join(r, 'platforms');
    if (!fs.existsSync(pf)) continue;
    const vers = fs
      .readdirSync(pf)
      .filter((v) => /^android-\d+$/.test(v))
      .sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10));
    for (const v of vers) {
      const j = path.join(pf, v, 'android.jar');
      if (fs.existsSync(j)) return j;
    }
  }
  return null;
}

function findGradleJar(groupPath) {
  const roots = [
    path.join(process.env.USERPROFILE || '', '.gradle', 'caches', 'modules-2', 'files-2.1'),
    path.join(process.env.HOME || '', '.gradle', 'caches', 'modules-2', 'files-2.1'),
  ];
  for (const root of roots) {
    const dir = path.join(root, ...groupPath.split('/'));
    if (!fs.existsSync(dir)) continue;
    for (const ver of fs.readdirSync(dir)) {
      const vdir = path.join(dir, ver);
      if (!fs.statSync(vdir).isDirectory()) continue;
      for (const hash of fs.readdirSync(vdir)) {
        const h = path.join(vdir, hash);
        if (!fs.statSync(h).isDirectory()) continue;
        const hit = fs.readdirSync(h).find((f) => f.endsWith('.jar') && !f.includes('-sources'));
        if (hit) return path.join(h, hit);
      }
    }
  }
  return null;
}

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

async function ensureDeps() {
  fs.mkdirSync(LIBS, { recursive: true });
  const paths = [];
  for (const d of DEPS) {
    const dest = path.join(LIBS, d.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      paths.push(dest);
      continue;
    }
    let copied = false;
    if (d.gradle) {
      const g = findGradleJar(d.gradle);
      if (g) {
        fs.copyFileSync(g, dest);
        console.log(`  ✓ ${d.file}（取自 gradle 缓存）`);
        copied = true;
      }
    }
    if (!copied) {
      try {
        await download(d.url, dest);
        console.log(`  ✓ ${d.file}（下载）`);
      } catch (e) {
        console.error(`  ✗ ${d.file} 获取失败：${e.message}`);
        console.error('    国内网络可从 https://maven.aliyun.com/repository/public 手动下载同名文件放进 sidecar/jvm/libs');
        process.exit(1);
      }
    }
    paths.push(dest);
  }
  return paths;
}

function ensureRepo() {
  if (fs.existsSync(path.join(REFS, '.git'))) return;
  fs.mkdirSync(path.dirname(REFS), { recursive: true });
  console.log(`→ 克隆 ${REPO}（只取历史，不取工作区）`);
  run('git', ['clone', '--filter=blob:none', REPO, REFS]);
}

function exportSrc(ref) {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  console.log(`→ 导出 ${ref} 的源码快照`);
  const tarFile = path.join(WORK, 'snapshot.tar');
  // 先落盘再解包：直接管道在 Windows 上容易因为缓冲区/编码失败
  const r = spawnSync('git', ['archive', ref, '--output', tarFile, 'app/src/main/java'], { cwd: REFS });
  if (r.status !== 0) {
    console.error(`✗ git archive 失败：${r.stderr?.toString() || ''}`);
    console.error(`  提示：先 cd tools/openspider/refs/CatVodSpider && git fetch --unshallow`);
    process.exit(1);
  }
  // GNU tar 会把 "C:/..." 里的冒号当远程主机，所以用相对路径 + cwd
  const t = spawnSync('tar', ['-xf', 'snapshot.tar', '-C', 'src'], { cwd: WORK });
  fs.rmSync(tarFile, { force: true });
  if (t.status !== 0) {
    console.error('✗ 解包失败：需要系统自带 tar（Windows 10+ / Linux 都有）');
    if (t.stderr) console.error('  ' + t.stderr.toString().trim());
    process.exit(1);
  }
  return path.join(SRC, 'app', 'src', 'main', 'java');
}

function listSites(javaRoot) {
  const dir = path.join(javaRoot, 'com', 'github', 'catvod', 'spider');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.java'))
    .map((f) => f.replace(/\.java$/, ''))
    .sort();
}

/** 配置里在用的站点类名（csp_XxxGuard → Xxx） */
function configSites() {
  return new Set(configEntries().map((e) => e.cls));
}

/** 配置里 type=3 且 api 是 csp_* 的条目，带 ext（smoke test 要用真实 ext） */
function configEntries() {
  const cache = path.join(ROOT, 'data', 'config-cache.json');
  if (!fs.existsSync(cache)) return [];
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    const j = c.json || c.data || c;
    const out = [];
    for (const s of j.sites || []) {
      if (Number(s.type) !== 3) continue;
      const api = String(s.api || '');
      // 注意：配置快照可能已经被主服务替换过（api 变成 oss-spiders-xxx.jar#...），
      // 这时要认得出来，否则重跑本脚本会以为「配置里没有这些站点」而选不到东西。
      let cls = null;
      if (/^csp_/i.test(api)) cls = api.replace(/^csp_/i, '').replace(/Guard$/i, '');
      else if (s.ossCls) cls = String(s.ossCls);
      else if (/#com\.github\.catvod\.spider\./.test(api)) cls = api.split('.').pop();
      if (!cls) continue;
      out.push({ cls, key: s.key, ext: s.ext });
    }
    return out;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ main
const ref = val('--ref', DEFAULT_REF);

if (has('--list')) {
  ensureRepo();
  const javaRoot = exportSrc(ref);
  const sites = listSites(javaRoot);
  const mine = configSites();
  const lower = new Map([...mine].map((s) => [s.toLowerCase(), s]));
  console.log(`\nCatVodSpider@${ref} 开源站点 ${sites.length} 个，配置里 csp_* 源 ${mine.size} 个\n`);
  const hit = [];
  for (const s of sites) {
    const cfg = mine.has(s) ? s : lower.get(s.toLowerCase());
    if (cfg) hit.push(`${cfg}${cfg === s ? '' : '（' + s + '）'}`);
  }
  console.log(`可直接替换的 ${hit.length} 个：${hit.join(', ')}\n`);
  console.log('全部开源站点：');
  console.log('  ' + sites.join(' '));
  process.exit(0);
}

// 默认只编「配置里真的用到」的开源站点（大小写容错，WoGG / Wogg 这类）。
// 想全量编或指定站点：--sites Kanqiu,XPath
const explicitSites = val('--sites', '');

console.log('→ 准备依赖（sidecar/jvm/libs）');
const depPaths = await ensureDeps();

const androidJar = findAndroidJar();
if (!androidJar) {
  console.error('✗ 找不到 android.jar（编译期 API 桩）。装 Android SDK，或设置 ANDROID_HOME。');
  process.exit(1);
}
console.log(`  ✓ android.jar: ${androidJar}`);

ensureRepo();
const javaRoot = exportSrc(ref);

const avail = new Set(listSites(javaRoot));
const mine = configSites();
const lower = new Map([...mine].map((s) => [s.toLowerCase(), s]));

let sites;
if (explicitSites) {
  sites = explicitSites.split(',').map((s) => s.trim()).filter(Boolean);
} else if (mine.size) {
  sites = [...avail].filter((s) => mine.has(s) || lower.has(s.toLowerCase()));
  console.log(`  自动选取 ${sites.length} 个「配置用得上的开源站点」`);
} else {
  sites = DEFAULT_SITES;
}
const want = sites.filter((s) => avail.has(s));
const missing = sites.filter((s) => !avail.has(s));
if (missing.length) console.warn(`! 该快照里没有这些站点，跳过：${missing.join(', ')}`);
if (!want.length) {
  console.error('✗ 没有可编译的站点');
  process.exit(1);
}

fs.rmSync(CLASSES, { recursive: true, force: true });
fs.mkdirSync(CLASSES, { recursive: true });

// 开源站点会引用 BuildConfig、sardine 这类「拿不到的依赖」，
// 编译前把它们编到 STUBS 挂到 classpath（只补桩，不覆盖源码树自带的 Spider）。
const STUBS_SRC = path.join(WORK, 'stubs-src');
console.log('→ 编译桩类（BuildConfig / sardine）');
fs.mkdirSync(STUBS, { recursive: true });
{
  const r = spawnSync(
    'javac',
    [
      '-encoding',
      'UTF-8',
      '-nowarn',
      '-d',
      STUBS,
      path.join(SIDECAR_SRC, 'com', 'github', 'catvod', 'BuildConfig.java'),
      ...walkJava(STUBS_SRC),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    console.error('✗ 桩类编译失败：');
    console.error((r.stderr || '').split('\n').slice(0, 8).join('\n'));
    process.exit(1);
  }
}

const cp = [androidJar, STUBS, ...depPaths].join(path.delimiter);
console.log(`→ 逐个编译 ${want.length} 个站点（javac 自动带上 bean/net/utils 依赖链）`);
const compiled = [];
const failed = [];
for (const s of want) {
  const file = path.join(javaRoot, 'com', 'github', 'catvod', 'spider', `${s}.java`);
  const r = spawnSync(
    'javac',
    ['-encoding', 'UTF-8', '-nowarn', '-cp', cp, '-sourcepath', javaRoot, '-d', CLASSES, file],
    { encoding: 'utf8' },
  );
  if (r.status === 0) {
    compiled.push(s);
    console.log(`  ✓ ${s}`);
  } else {
    // 只留「缺哪个符号」这一句，够定位又不刷屏
    const first = (r.stderr || '')
      .split('\n')
      .find((l) => l.includes('package') || l.includes('symbol') || l.includes('找不到') || l.includes('程序包'));
    failed.push({ site: s, why: (first || '').trim().slice(0, 120) });
    console.log(`  ✗ ${s}`);
  }
}
if (failed.length) {
  console.log('\n  以下站点缺第三方依赖（ZXing / OkHttp 扩展等），需要时手动补 jar 到 sidecar/jvm/libs：');
  for (const f of failed) console.log(`    - ${f.site}: ${f.why}`);
}
if (!compiled.length) {
  console.error('✗ 一个都没编出来');
  process.exit(1);
}
const want$ = compiled;

const count = (function countClass(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countClass(path.join(dir, e.name));
    else if (e.name.endsWith('.class')) n++;
  }
  return n;
})(CLASSES);

fs.mkdirSync(path.dirname(OUT_JAR), { recursive: true });
/**
 * jar 用「内容指纹」命名：oss-spiders-<hash>.jar。
 *
 * 起因很具体：侧车用 URLClassLoader 打开 jar 后，Windows 不释放句柄，
 * 同一个路径没法原地覆盖，改一次就要停一次服务。
 * 换个文件名就绕开了整类问题：新包是新路径，旧包继续被跑着的侧车用着，
 * 等它重启自然换到新路径。旧文件顺手清理，删不掉就算了。
 */
const HASH = (() => {
  const h = crypto.createHash('sha1');
  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, base);
      else if (e.name.endsWith('.class')) {
        h.update(path.relative(base, p).replace(/\\/g, '/'));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(CLASSES, CLASSES);
  return h.digest('hex').slice(0, 8);
})();
const JAR_NAME = `oss-spiders-${HASH}.jar`;
const JAR_PATH = path.join(path.dirname(OUT_JAR), JAR_NAME);
if (!fs.existsSync(JAR_PATH)) run(findJarTool(), ['cf', JAR_PATH, '-C', CLASSES, '.']);
else console.log(`  · ${JAR_NAME} 已存在（内容一致），复用`);

// 旧指纹包清理：删不掉（被运行中的侧车占着）就留着，不影响正确性
for (const f of fs.readdirSync(path.dirname(OUT_JAR))) {
  if (!/^oss-spiders(-[0-9a-f]{8})?\.jar$/.test(f)) continue;
  if (f === JAR_NAME) continue;
  try {
    fs.unlinkSync(path.join(path.dirname(OUT_JAR), f));
  } catch {
    /* 被占用，下次再说 */
  }
}

// manifest 供 server/config/oss-spiders.js 判断「哪些 csp_XxxGuard 有开源替代」
const manifest = path.join(path.dirname(OUT_JAR), 'oss-spiders.json');

/**
 * --verify：对着跑起来的 JVM 侧车把每个类真的调一次 home，
 * 只有回 ok 的才写进 verified。主服务优先用 verified —— 「编得过」不等于「跑得起来」，
 * Bili / Push / Wogg 这类会因缺 Android UI 依赖在运行期炸，不能报成可播放。
 */
let verified = null;
if (has('--verify')) {
  const port = process.env.JVM_SIDECAR_PORT || '8899';
  const entries = configEntries();
  console.log(`\n→ 冒烟测试（侧车 :${port}）`);
  verified = [];
  for (const cls of compiled) {
    const e = entries.find((x) => x.cls === cls) || entries.find((x) => x.cls.toLowerCase() === cls.toLowerCase());
    const ext = e ? (typeof e.ext === 'string' ? e.ext : JSON.stringify(e.ext ?? '')) : '';
    const body = {
      site: { key: `verify-${cls}`, api: `${JAR_NAME}#com.github.catvod.spider.${cls}`, spiderJar: JAR_PATH, ext },
      method: 'home',
      params: {},
    };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/spider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json();
      if (j.ok) {
        verified.push(cls);
        console.log(`  ✓ ${cls}`);
      } else {
        console.log(`  ✗ ${cls}  ${String(j.errorClass || '').padEnd(28)} ${String(j.error).slice(0, 70)}`);
      }
    } catch (err) {
      console.log(`  ✗ ${cls}  侧车不可达：${err.message}`);
    }
  }
}

fs.writeFileSync(
  manifest,
  JSON.stringify(
    {
      ref,
      builtAt: new Date().toISOString(),
      jar: JAR_NAME,
      sites: compiled,
      ...(verified ? { verified } : {}),
    },
    null,
    1,
  ),
);
console.log(`✓ ${path.relative(ROOT, manifest)}（${compiled.length} 个站点${verified ? `，冒烟通过 ${verified.length} 个` : ''}）`);
console.log(`✓ ${path.relative(ROOT, JAR_PATH)}  ${(fs.statSync(JAR_PATH).size / 1024).toFixed(1)} KB / ${count} 个 class`);
console.log(`\n接下来：`);
console.log(`  npm run sidecar:jvm        # 侧车会自动把 sidecar/jvm/libs/*.jar 加进 classpath`);
console.log(`  主服务重启后会自动把配置里的 csp_XxxGuard 换成开源实现（无需手改配置）`);
console.log(`  想核对替换结果：GET /api/sources，看 api 是否变成 ${JAR_NAME}#...`);
