/**
 * JS spider 引擎容器
 *
 * 一个 TVBox js 源 = 引擎脚本(api) + 规则(ext)。
 * 引擎导出的对象就是 CatVod 接口：init/home/homeVod/category/detail/play/search/action/proxy。
 * 这里负责装载、初始化、调用包装、以及把引擎日志带回诊断。
 */
import { createHost } from './host.js';

const REGISTRY = new Map(); // key → { engine, host, at }
const TTL = 10 * 60 * 1000;

export async function createJsEngine({ api, ext, key, name, proxyBase }) {
  const started = Date.now();
  const host = createHost({ siteKey: key, baseUrl: api, proxyBase });
  const mod = host.loader.load(api, host, api, false);
  const engine = (mod && mod.default) || mod;
  if (!engine || typeof engine !== 'object' || typeof engine.init !== 'function') {
    throw new Error('该 js 未导出 CatVod 接口（缺少 init）');
  }
  const r = engine.init(typeof ext === 'string' ? ext : ext ?? '');
  if (r && typeof r.then === 'function') await r;
  return { engine, host, tookMs: Date.now() - started, name };
}

export async function getEngine(site, { proxyBase } = {}) {
  const key = `${site.key}::${site.api}`;
  const hit = REGISTRY.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const made = await createJsEngine({
    api: site.api,
    ext: site.ext ?? '',
    key: site.key,
    name: site.name,
    proxyBase,
  });
  REGISTRY.set(key, { ...made, at: Date.now() });
  return made;
}

export function dropEngine(siteKey) {
  for (const k of [...REGISTRY.keys()]) if (k.startsWith(siteKey + '::')) REGISTRY.delete(k);
}

/** 统一调用入口：把引擎异常转成可读错误，并附上最近日志 */
export function invoke(engineBox, method, ...args) {
  const fn = engineBox.engine?.[method];
  if (typeof fn !== 'function') {
    const err = new Error(`js 引擎未实现 ${method}()`);
    err.code = 'JS_METHOD_MISSING';
    throw err;
  }
  try {
    const out = fn.apply(engineBox.engine, args);
    if (out && typeof out.then === 'function') {
      return out.catch((e) => {
        throw decorate(e, engineBox, method);
      });
    }
    return out;
  } catch (e) {
    throw decorate(e, engineBox, method);
  }
}

function decorate(e, box, method) {
  const err = new Error(`${method} 执行失败: ${e?.message || e}`);
  err.code = 'JS_SPIDER_ERROR';
  err.detail = { method, logs: (box.host?.logs || []).slice(-12) };
  err.stack = e?.stack;
  return err;
}

export function engineStatus() {
  return [...REGISTRY.entries()].map(([k, v]) => ({
    key: k.split('::')[0],
    loadedAt: v.at,
    initMs: v.tookMs,
    modules: (v.host?.loader?.trace || []).length,
    logs: (v.host?.logs || []).length,
  }));
}

/**
 * V8 与 QuickJS 的语义差异自动修复
 *
 * drpy 规则里的代码是字符串，由引擎内部 eval 执行。规则常写 `var d = []`，
 * 而 V8 规定：直接 eval 的 var 若与eval 所在函数作用域里的 let/const 同名 → SyntaxError
 * （QuickJS 不报这个错，所以 TVBox 能跑）。这里捕获该错误，把规则里冲突的标识符重命名后重试。
 */
function renameInRule(engine, id) {
  let rule;
  try {
    rule = engine.getRule ? engine.getRule() : null;
  } catch {
    rule = null;
  }
  if (!rule || typeof rule !== 'object') return false;
  const re = new RegExp(`(?<![\\w$.])${id.replace(/[$]/g, '\\$&')}(?![\\w$])`, 'g');
  const alias = `${id}_nv`;
  let changed = 0;
  for (const k of Object.keys(rule)) {
    const v = rule[k];
    if (typeof v !== 'string' || !v.includes('js:')) continue;
    if (!re.test(v)) continue;
    re.lastIndex = 0;
    rule[k] = v.replace(re, alias);
    changed++;
  }
  return changed > 0;
}

/** 带自动修复的调用：遇到 eval 标识符冲突时改规则重试 */
export async function invokeAuto(box, method, ...args) {
  try {
    return await invoke(box, method, ...args);
  } catch (e) {
    const m = /Identifier '([^']+)' has already been declared/.exec(e.message || '');
    if (m && renameInRule(box.engine, m[1])) {
      (box.host?.logs || []).push({ t: Date.now(), line: `[compat] 规则标识符 ${m[1]} 与引擎内部声明冲突，已重命名后重试` });
      return await invoke(box, method, ...args);
    }
    throw e;
  }
}

/** 引擎是否已预热（聚合搜索用来决定要不要为它等一次冷启动） */
export function isWarm(siteKey, api) {
  const hit = REGISTRY.get(`${siteKey}::${api}`);
  return Boolean(hit && Date.now() - hit.at < TTL);
}
