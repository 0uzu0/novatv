/**
 * TVBox JS spider 模块加载器（同步）
 *
 * TVBox 的 js 源本质是 ES Module 图：
 *   drpy2.min.js  →  import cheerio from "assets://js/lib/cheerio.min.js"
 *                    import "assets://js/lib/crypto-js.js"
 *                    import "./node-rsa.js" ...
 * 壳里由 QuickJS + 自定义 loader 完成解析。这里在 Node 里用 vm 复刻同一套语义：
 *   - assets:// → 从规则同源目录/镜像找同名文件（TVBox 的 assets 内置文件在开源仓里都有副本）
 *   - 相对路径 → 相对 import 方 URL 解析
 *   - ESM 语法在装载时降级成 CJS（同步 require 映射），不需要 --experimental-vm-modules
 *   - 侧效应 import（import "x"）按 TVBox 语义以"无 module/exports"执行，让 UMD 走全局分支
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { reqSync } from './http-sync.js';

const CACHE_DIR = path.join(process.cwd(), 'data', 'js-rt-cache');
const TTL = 24 * 3600 * 1000;

const ID = '[\\w$\\u00a0-\\uffff]+';
// 语句级 import 必须带前缀（行首/分号/右花括号），否则会把 "parseImport: expected import" 这类字符串误伤
const RE_IMPORT_FROM = new RegExp(`(^|[;\\n}])([ \\t]*)import\\s*([^;'"]*?)\\s*from\\s*["']([^"'\\n]{1,300})["']`, 'g');
const RE_IMPORT_BARE = new RegExp(`(^|[;\\n}])([ \\t]*)import\\s*["']([^"'\\n]{1,300})["']`, 'g');
const RE_EXPORT_DEFAULT = /export\s+default\s*/g;
const RE_EXPORT_LIST = /export\s*\{([^}]*)\}\s*;?/g;
const RE_EXPORT_DECL = new RegExp(
  `export\\s+(?=(?:async\\s+)?(?:function|class|const|let|var)\\s+(${ID}))`,
  'g',
);

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function cachePaths(url) {
  const h = sha1(url);
  return { body: path.join(CACHE_DIR, `${h}.js`), meta: path.join(CACHE_DIR, `${h}.json`) };
}

function readCache(url) {
  const { body, meta } = cachePaths(url);
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m.url !== url) return null;
    const code = fs.readFileSync(body, 'utf8');
    return { code, fresh: Date.now() - m.fetchedAt < TTL };
  } catch {
    return null;
  }
}

function writeCache(url, code) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const { body, meta } = cachePaths(url);
    fs.writeFileSync(body, code);
    fs.writeFileSync(meta, JSON.stringify({ url, fetchedAt: Date.now(), bytes: code.length }));
  } catch {
    /* 缓存失败不影响执行 */
  }
}

function looksEsm(code) {
  // 压缩过的 bundle 往往是 ...};export{Eh as default,Oi as html}; 这种无空格、无换行的写法
  const hasImport = /\bimport\s*(?:["']|\*\s*as\b|[\w$]+\s*(?:,|from\b)|\{)/.test(code);
  const hasExport = /\bexport\s*(?:default\b|\{|\*|const\b|let\b|var\b|function\b|class\b|async\b)/.test(code);
  return hasImport || hasExport;
}

function looksCjs(code) {
  return /\bmodule\.exports\b/.test(code) || /\bexports\.[A-Za-z_$]/.test(code);
}

/** 把 ESM 源码降级为可同步执行的函数体 */
function toCjsBody(code) {
  const deps = [];
  let out = code;

  out = out.replace(RE_IMPORT_FROM, (m, prefix, ws, clause, spec) => {
    const idx = deps.push({ spec, clause: clause.trim(), sideEffect: false }) - 1;
    return `${prefix}${ws}/* import ${idx} */`;
  });
  out = out.replace(RE_IMPORT_BARE, (m, prefix, ws, spec) => {
    const idx = deps.push({ spec, clause: '', sideEffect: true }) - 1;
    return `${prefix}${ws}/* import ${idx} */`;
  });

  const exportedNames = [];
  out = out.replace(RE_EXPORT_DECL, (m, name) => {
    exportedNames.push(name);
    return 'export '.length ? '' : '';
  });
  out = out.replace(RE_EXPORT_DEFAULT, '__exports.default__ = ');
  out = out.replace(RE_EXPORT_LIST, (m, list) => {
    return list
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [local, alias] = p.split(/\s+as\s+/);
        return `__exports[${JSON.stringify((alias || local).trim())}] = ${local.trim()};`;
      })
      .join(' ');
  });
  for (const n of exportedNames) out += `\n__exports[${JSON.stringify(n)}] = typeof ${n} !== 'undefined' ? ${n} : undefined;`;

  // 声明头（按依赖顺序生成常量）
  const header = deps
    .map((d, i) => {
      const v = `__m${i}`;
      const load = `__req(${JSON.stringify(d.spec)})`;
      if (d.sideEffect) return `var ${v} = ${load};`;
      const lines = [`var ${v} = ${load};`];
      const clause = d.clause.replace(/^,\s*/, '');
      if (!clause) return lines.join('\n');
      // const a = 1, b = 2 拆开写
      const parts = [];
      let depth = 0;
      let cur = '';
      for (const ch of clause) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (ch === ',' && depth === 0) {
          parts.push(cur);
          cur = '';
        } else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      for (const raw of parts) {
        const p = raw.trim();
        if (!p) continue;
        if (p.startsWith('*')) {
          const ns = p.replace(/^\*\s*as\s*/, '').trim();
          lines.push(`var ${ns} = ${v};`);
        } else if (p.startsWith('{')) {
          const inner = p.slice(1, -1);
          for (const item of inner.split(',')) {
            const t = item.trim();
            if (!t) continue;
            const [a, b] = t.split(/\s+as\s+/);
            const name = (b || a).trim();
            const key = a.trim();
            lines.push(
              `var ${name} = (${v} && ${v}.__plainModule) ? __ctx[${JSON.stringify(key)}] : (${v} ? ${v}[${JSON.stringify(key)}] : undefined);`,
            );
          }
        } else {
          lines.push(`var ${p} = (${v} && ${v}.__plainModule) ? __ctx[${JSON.stringify(p)}] : __def(${v});`);
        }
      }
      return lines.join('\n');
    })
    .join('\n');

  return { body: `${header}\n${out}\n`, deps };
}

export class JsModuleLoader {
  constructor({ assetsBase = process.env.JS_ASSETS_BASE || '' } = {}) {
    this.memo = new Map();
    this.assetsBase = assetsBase;
    this.trace = [];
  }

  #download(url) {
    const cached = readCache(url);
    if (cached?.fresh) return cached.code;
    const res = reqSync(url, { timeout: 25000, headers: { 'User-Agent': 'okhttp/3.15' } });
    const text = typeof res.content === 'string' ? res.content : '';
    if (res.status >= 200 && res.status < 400 && text.length > 32) {
      writeCache(url, text);
      return text;
    }
    if (cached) return cached.code; // 网络失败用过期缓存
    throw new Error(`加载脚本失败 ${res.status || 'ERR'} ${url}`);
  }

  /** assets:// → 实际 URL 候选（TVBox 内置 assets 在开源仓根目录一般有同名副本） */
  #resolveAssets(spec, baseUrl) {
    const rest = spec.replace(/^assets:\/\//, '').replace(/^\/+/, '');
    const tail = rest.split('/').pop();
    const bases = [];
    if (this.assetsBase) bases.push(this.assetsBase.replace(/\/$/, '') + '/');
    if (baseUrl) bases.push(new URL('.', baseUrl).href);
    const cands = [];
    for (const b of bases) {
      for (const p of [rest, `assets/${rest}`, `js/lib/${tail}`, `lib/${tail}`, tail]) {
        const u = b + p;
        if (!cands.includes(u)) cands.push(u);
      }
    }
    return cands;
  }

  #resolve(spec, baseUrl) {
    if (/^https?:\/\//i.test(spec)) return [spec];
    if (spec.startsWith('assets://')) return this.#resolveAssets(spec, baseUrl);
    if (/^\.{1,2}\//.test(spec) || !spec.includes('://')) {
      if (!baseUrl) throw new Error(`无法解析相对模块 ${spec}`);
      return [new URL(spec, baseUrl).href];
    }
    throw new Error(`不支持的模块地址 ${spec}`);
  }

  /**
   * @param {string} spec 模块地址
   * @param {object} ctxHost {ctx, def} 沙箱上下文
   * @param {string} fromUrl 引用方 URL
   * @param {boolean} sideEffect
   */
  load(spec, host, fromUrl, sideEffect = false) {
    const cands = this.#resolve(spec, fromUrl);
    let lastErr;
    for (const url of cands) {
      try {
        return this.#loadResolved(url, host, sideEffect);
      } catch (e) {
        lastErr = e;
      }
    }
    // assets 多候选失败时给出可读信息
    throw new Error(`模块解析失败 ${spec} → ${lastErr?.message || 'unknown'}`);
  }

  #loadResolved(url, host, sideEffect) {
    const memoKey = `${url}|${sideEffect ? 'se' : 'mod'}`;
    if (this.memo.has(memoKey)) return this.memo.get(memoKey);

    const code = this.#download(url);
    this.trace.push({ url, bytes: code.length, sideEffect });

    const esm = looksEsm(code);
    const exportsObj = {};
    const moduleObj = { exports: exportsObj };
    let result;

    if (esm) {
      const { body, deps } = toCjsBody(code);
      const wrapped = `(function(__module,__exports,__req,__def,__ctx){\n${body}\n;return __module.exports;})`;
      const fn = vm.runInContext(wrapped, host.ctx, { timeout: 15000, filename: url });
      const reqFn = (s) => this.load(s, host, url, false);
      const exportsProxy = moduleObj.exports;
      const ret = fn(moduleObj, exportsProxy, reqFn, host.def, host.ctx);
      const finalExports = ret && Object.keys(ret).length ? ret : exportsProxy;
      if (finalExports.default__) {
        finalExports.default = finalExports.default__;
        delete finalExports.default__;
      }
      finalExports.__esModule = true;
      result = finalExports;
      if (sideEffect) result = { __plainModule: false };
    } else if (looksCjs(code) && !sideEffect) {
      const wrapped = `(function(module,exports,globalThis_shim){\n${code}\n;return module.exports;})`;
      const fn = vm.runInContext(wrapped, host.ctx, { timeout: 15000, filename: url });
      const exp = fn(moduleObj, exportsObj, host.ctx);
      result = exp && Object.keys(exp).length ? exp : exportsObj;
    } else {
      // 纯脚本：直接在当前上下文里执行，变量成为全局（与 TVBox 一致）
      try {
        vm.runInContext(code, host.ctx, { timeout: 15000, filename: url });
      } catch (e) {
        if (!sideEffect) throw e;
      }
      result = { __plainModule: true, default: undefined };
    }

    this.memo.set(memoKey, result);
    return result;
  }
}

export const __debug = { toCjsBody, looksEsm, looksCjs };
