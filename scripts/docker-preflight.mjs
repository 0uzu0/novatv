/**
 * Docker 预检：在本机没有 docker 的情况下，尽量提前发现构建会失败的原因
 *
 *   node scripts/docker-preflight.mjs
 *
 * 检查项：
 *   1. Dockerfile 里所有本地 COPY 源是否真的存在
 *   2. COPY 源是否被 .dockerignore 误排除
 *   3. 文件是否存在 CRLF（Windows 上最容易踩，会让 RUN 报 bad interpreter）
 *   4. 基础镜像是否官方支持 amd64 + arm64（查 Docker Hub，需要外网）
 *   5. compose 引用的镜像名是否全小写（GHCR 硬性要求）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILES = ['Dockerfile', 'Dockerfile.sidecar'];

let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => {
  console.log(`  ✘ ${m}`);
  fails++;
};
const warn = (m) => {
  console.log(`  ! ${m}`);
  warns++;
};

const rel = (p) => path.relative(ROOT, p) || '.';

/** .dockerignore 只认简单的 glob，这里实现够用的匹配：字面量 + 通配 + 目录前缀 */
function loadDockerignore() {
  const f = path.join(ROOT, '.dockerignore');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function ignored(rules, relPath) {
  let hit = false;
  for (const rule of rules) {
    const negate = rule.startsWith('!');
    const pat = (negate ? rule.slice(1) : rule).replace(/^\/+/, '').replace(/\/+$/, '');
    const re = new RegExp(
      '^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '(/|$)',
    );
    if (re.test(relPath)) hit = !negate;
  }
  return hit;
}

console.log('\n[1] Dockerfile 的 COPY 源');
const rules = loadDockerignore();
const bases = new Set();
for (const df of DOCKERFILES) {
  const full = path.join(ROOT, df);
  if (!fs.existsSync(full)) {
    bad(`${df} 不存在`);
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  const lines = text.split(/\r?\n/);

  if (/\r/.test(text)) bad(`${df} 含 CRLF，会破坏 RUN（bad interpreter）`);
  else ok(`${df} 行尾正常（LF）`);

  let copies = 0;
  for (const line of lines) {
    const from = /^FROM\s+(\S+)/i.exec(line.trim());
    if (from) bases.add(from[1]);

    const copy = /^COPY\s+(.+)$/i.exec(line.trim());
    if (!copy) continue;
    if (/--from=/i.test(line)) continue;
    const parts = copy[1].split(/\s+/).filter((x) => !x.startsWith('--'));
    const srcs = parts.slice(0, -1);
    for (const src of srcs) {
      copies++;
      const abs = path.join(ROOT, src);
      if (!fs.existsSync(abs)) {
        bad(`${df}: COPY 源不存在 → ${src}`);
      } else if (ignored(rules, src.replace(/^\.\//, ''))) {
        bad(`${df}: COPY 源被 .dockerignore 排除了 → ${src}`);
      } else {
        ok(`${df}: ${src}`);
      }
    }
  }
  if (!copies) warn(`${df} 没有任何本地 COPY`);
}

console.log('\n[2] 关键文件');
for (const f of ['docker-compose.yml', 'docker-compose.sidecar.yml', 'docker-compose.nas.yml', '.env.example', 'package.json', 'web/index.html']) {
  fs.existsSync(path.join(ROOT, f)) ? ok(f) : bad(`缺少 ${f}`);
}

console.log('\n[3] .dockerignore 必须排除的目录');
for (const f of ['data', 'reports', 'node_modules', 'sidecar/jvm/build']) {
  ignored(rules, f) ? ok(`${f} 已排除`) : warn(`${f} 未排除（会让构建上下文变大）`);
}
console.log('  · 但 data/.gitkeep 要能进仓库（compose 挂载点）');
fs.existsSync(path.join(ROOT, 'data', '.gitkeep')) ? ok('data/.gitkeep 存在') : warn('data/.gitkeep 缺失');

console.log('\n[4] 基础镜像架构支持（查 Docker Hub）');

/** Node 的 fetch 不读 HTTPS_PROXY，失败时退化到 curl（它会读环境里的代理） */
async function getJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (r.ok) return await r.json();
  } catch {
    /* 落到 curl */
  }
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('curl', ['-sS', '-m', '15', url], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

for (const ref of bases) {
  const clean = ref.replace(/^docker\.io\//, '');
  const [repo, tag = 'latest'] = clean.includes(':') ? clean.split(':') : [clean, 'latest'];
  const name = repo.includes('/') ? repo : `library/${repo}`;
  const url = `https://hub.docker.com/v2/repositories/${name}/tags/${encodeURIComponent(tag)}`;
  const j = await getJson(url);
  if (!j) {
    warn(`${ref}: 网络不可达，跳过架构校验（CI 里会自动查）`);
    continue;
  }
  const arches = [...new Set((j.images || []).map((i) => i.architecture))].sort();
  const hasAmd = arches.includes('amd64');
  const hasArm = arches.includes('arm64');
  if (hasAmd && hasArm) ok(`${ref} → ${arches.join(' / ')}`);
  else warn(`${ref} → ${arches.join(' / ') || '未知'}（缺 ${[!hasAmd && 'amd64', !hasArm && 'arm64'].filter(Boolean).join('/')}）`);
}

console.log('\n[5] compose 镜像名');
for (const f of ['docker-compose.yml', 'docker-compose.sidecar.yml', 'docker-compose.nas.yml']) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/^\s*image:\s*(\S+)/gm)) {
    const img = m[1];
    if (/[A-Z]/.test(img.replace(/\$\{[^}]*\}/g, ''))) bad(`${f}: 镜像名含大写 → ${img}（GHCR 要求全小写）`);
    else ok(`${f}: ${img}`);
  }
}

console.log('\n──────────────────────────────────────────────');
if (fails) {
  console.log(`预检结果：${fails} 项失败，${warns} 项提醒`);
  process.exit(1);
}
console.log(`预检结果：全部通过（${warns} 项提醒）`);
