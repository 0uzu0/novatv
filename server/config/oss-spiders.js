/**
 * 加固源 → 开源实现的替换映射。
 *
 * 背景：配置里 37 个 `csp_XxxGuard` 是 Android 加固包里的类，纯服务端跑不了。
 * 但其中一部分站点在 FongMi/CatVodSpider 仓库里有同名的开源 Java 实现，
 * 用 `node scripts/oss-spider.mjs` 编译成 oss-spiders.jar 后，可以直接跑在 JVM 侧车上。
 *
 * 判定方式不是硬编码名单，而是读构建产物旁边的 manifest ——
 * 只有「jar 里真的存在这个类」才替换，避免配置被改到一个不存在的类上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(ROOT, 'sidecar', 'jvm', 'build');
const MANIFEST = path.join(BUILD, 'oss-spiders.json');

/** NOVA_OSS_SPIDERS=0 可整体关闭替换（想强制走加固包时用） */
function enabled() {
  return String(process.env.NOVA_OSS_SPIDERS ?? '1') !== '0';
}

let cache;

function load() {
  if (cache) return cache;
  cache = { jar: null, sites: new Set(), verified: null };
  if (!enabled()) return cache;
  if (!fs.existsSync(MANIFEST)) return cache;
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    // jar 名带内容指纹（oss-spiders-<hash>.jar），以 manifest 为准；
    // 老格式没有 jar 字段时回落到固定名。
    const jarPath = path.join(BUILD, m.jar || 'oss-spiders.jar');
    if (!fs.existsSync(jarPath)) return cache;
    cache.jar = jarPath;
    for (const s of m.sites || []) cache.sites.add(String(s));
    // 有 verified 就只认冒烟通过的（编译通过 ≠ 跑得起来）；
    // 老 manifest 没有这个字段时退回「全部相信」。
    if (Array.isArray(m.verified)) cache.verified = new Set(m.verified.map(String));
  } catch {
    // manifest 缺失或损坏：不做替换，宁可保留原来的「需要 Android」结论
  }
  return cache;
}

/** 这个类名是否真的可以交给侧车跑（有 verified 时以它为准） */
function runnable(cls) {
  const { sites, verified } = load();
  if (!sites.has(cls)) return false;
  if (verified && !verified.has(cls)) return false;
  return true;
}

/** csp_KanqiuGuard → { cls:'Kanqiu', api, spiderJar }；无开源实现时返回 null */
export function ossFor(api) {
  const m = /^csp_(.+)Guard$/i.exec(String(api || ''));
  if (!m) return null;
  const { jar } = load();
  if (!jar) return null;
  // 类名大小写可能不一致（WoGG / Wogg），按不区分大小写找一次
  let cls = m[1];
  if (!runnable(cls)) {
    const hit = [...load().sites].find((s) => s.toLowerCase() === cls.toLowerCase());
    if (!hit || !runnable(hit)) return null;
    cls = hit;
  }
  return {
    cls,
    api: `${path.basename(jar)}#com.github.catvod.spider.${cls}`,
    spiderJar: jar,
  };
}

/** 给 /api/runtime、诊断页用：当前可替换多少个、来自哪个构建 */
export function ossSummary() {
  const { jar, sites, verified } = load();
  return {
    available: !!jar,
    jar: jar ? path.relative(ROOT, jar) : null,
    sites: [...sites].sort(),
    verified: verified ? [...verified].sort() : null,
  };
}
