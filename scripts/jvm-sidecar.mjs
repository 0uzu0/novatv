/**
 * JVM 侧车：编译 + 打包 demo spider jar + 启动 HTTP 服务
 *
 *   node scripts/jvm-sidecar.mjs           # 编译并启动（默认 8899）
 *   node scripts/jvm-sidecar.mjs --build   # 只编译打包
 *
 * 侧车加载的是「未加固」jar。加固包（csp_*Guard，dex+.so+guard）请走 sidecar/android。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'sidecar', 'jvm', 'src');
const DEMO = path.join(ROOT, 'sidecar', 'jvm', 'demo');
const BUILD = path.join(ROOT, 'sidecar', 'jvm', 'build');
const CLASSES = path.join(BUILD, 'classes');
const DEMO_CLASSES = path.join(BUILD, 'demo-classes');
const JAR = path.join(BUILD, 'demo-spider.jar');
const LIBS = path.join(ROOT, 'sidecar', 'jvm', 'libs');

/**
 * sidecar/jvm/libs/*.jar 会一起进 classpath。
 * 第三方开源 spider（okhttp/jsoup/org.json 等依赖）编译出的 jar 靠这里补齐运行时。
 * 生成方式：node scripts/oss-spider.mjs
 */
function libJars() {
  if (!fs.existsSync(LIBS)) return [];
  return fs
    .readdirSync(LIBS)
    .filter((f) => f.endsWith('.jar'))
    .map((f) => path.join(LIBS, f));
}

function walk(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(' ')} 失败（exit ${r.status}）`);
    process.exit(r.status || 1);
  }
}

/** jar.exe 常常不在 PATH 里（只有 javapath 的 java/javac），这里主动找 JDK */
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

fs.mkdirSync(CLASSES, { recursive: true });
fs.mkdirSync(DEMO_CLASSES, { recursive: true });

console.log('→ 编译侧车与 catvod/android 占位类');
run('javac', ['-encoding', 'UTF-8', '-d', CLASSES, ...walk(SRC, '.java')]);

console.log('→ 编译 demo spider（模拟普通 jar）');
run('javac', ['-encoding', 'UTF-8', '-cp', CLASSES, '-d', DEMO_CLASSES, ...walk(DEMO, '.java')]);

console.log('→ 打包 demo-spider.jar');
try {
  fs.rmSync(JAR, { force: true });
} catch {
  console.warn('! 旧 jar 被运行中的侧车占用，先停掉 8899 端口进程再打包');
  process.exit(2);
}
run(findJarTool(), ['cf', JAR, '-C', DEMO_CLASSES, '.']);
console.log(`✓ ${path.relative(ROOT, JAR)} (${(fs.statSync(JAR).size / 1024).toFixed(1)} KB)`);

if (process.argv.includes('--build')) process.exit(0);

const port = process.env.JVM_SIDECAR_PORT || '8899';
const CP = [CLASSES, ...libJars()].join(path.delimiter);
console.log(`→ 启动侧车 http://127.0.0.1:${port}`);
if (libJars().length) console.log(`  额外依赖 ${libJars().length} 个 jar（sidecar/jvm/libs）`);
const child = spawnSync('java', ['-cp', CP, 'novatv.Sidecar'], {
  stdio: 'inherit',
  env: { ...process.env, JVM_SIDECAR_PORT: port, NOVA_SPIDER_JAR: JAR },
});
process.exit(child.status || 0);
