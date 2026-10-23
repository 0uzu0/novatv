/**
 * TVBox JS spider 宿主 API（对标 TVBox 壳注入到 QuickJS 的全局函数）
 *
 * 提供：req / pdfh / pdfa / pd / joinUrl / getProxy / local / log / md5 / base64 ...
 * 其中 pdfh/pdfa/pd 用 cheerio（与 drpy2 同一个 bundle）实现，选择器语义与 jsoup 版对齐。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { reqSync } from './http-sync.js';
import { JsModuleLoader } from './loader.js';

const PROP_RE = /^(Text|TextTrim|Html|html|outerHtml|outerHTML|Value|value|href|src|title|alt|style|id|class|data-[\w-]+)$/;

function splitRule(rule) {
  const segs = String(rule)
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  let prop = '';
  if (segs.length > 1 && PROP_RE.test(segs[segs.length - 1])) prop = segs.pop();
  return { selector: segs.join(' ') || 'body', prop };
}

function pick($, node, prop) {
  if (!node || node.length === 0) return '';
  if (!prop) {
    return { outer: $.html(node), text: node.text(), html: node.html(), ele: node };
  }
  switch (prop) {
    case 'Text':
      return node.text();
    case 'TextTrim':
      return node.text().trim();
    case 'Html':
    case 'html':
      return node.html() || '';
    case 'outerHtml':
    case 'outerHTML':
      return $.html(node);
    default:
      return node.attr(prop) ?? '';
  }
}

export function createHost({ siteKey = 'js', baseUrl = '', proxyBase = '', logLimit = 200 } = {}) {
  const logs = [];
  const loader = new JsModuleLoader({ assetsBase: process.env.JS_ASSETS_BASE || '' });
  const cookieJar = path.join(process.cwd(), 'data', 'js-rt-cache', 'cookies', `${siteKey.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.txt`);
  try {
    fs.mkdirSync(path.dirname(cookieJar), { recursive: true });
  } catch {
    /* ignore */
  }

  let cheerioRef = null;
  const ctx = vm.createContext({});

  const log = (...args) => {
    const line = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    logs.push({ t: Date.now(), line: line.slice(0, 500) });
    if (logs.length > logLimit) logs.shift();
    if (process.env.JS_RT_DEBUG) console.log('[js-rt]', line.slice(0, 300));
  };

  const getCheerio = () => {
    if (cheerioRef) return cheerioRef;
    const mod = loader.load('assets://js/lib/cheerio.min.js', host, baseUrl, false);
    cheerioRef = mod && mod.default ? mod.default : mod;
    if (!cheerioRef || typeof cheerioRef.load !== 'function') throw new Error('cheerio 未正确加载');
    return cheerioRef;
  };

  const loadDom = (html) => {
    const cheerio = getCheerio();
    try {
      return cheerio.load(String(html), { decodeEntities: false });
    } catch {
      return cheerio.load(String(html));
    }
  };

  const pdfh = (html, rule) => {
    if (!html || !rule) return '';
    const variants = String(rule).split('||');
    for (const v of variants) {
      const { selector, prop } = splitRule(v);
      let $;
      try {
        $ = loadDom(html);
      } catch (e) {
        log('pdfh 解析失败:', e.message);
        return '';
      }
      const node = $(selector).eq(0);
      const val = pick($, node, prop);
      if (val && (!prop ? val.text : String(val).trim())) return val;
      if (variants.length === 1) return val;
    }
    return '';
  };

  const pdfa = (html, rule) => {
    if (!html || !rule) return [];
    const { selector, prop } = splitRule(String(rule).split('||')[0]);
    let $;
    try {
      $ = loadDom(html);
    } catch (e) {
      log('pdfa 解析失败:', e.message);
      return [];
    }
    const out = [];
    $(selector).each((_, el) => {
      const node = $(el);
      const val = pick($, node, prop || 'Html');
      out.push(val);
    });
    return out;
  };

  const pd = (html, rule, base) => {
    if (!html || !rule) return '';
    const parts = String(rule)
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const resolve = (v) => {
      if (!base || typeof v !== 'string') return v;
      if (/^(https?:)?\/\//i.test(v)) return v;
      try {
        return new URL(v, base).href;
      } catch {
        return v;
      }
    };
    if (parts.length === 1) return resolve(pdfh(html, parts[0]));
    const obj = {};
    parts.forEach((p, i) => {
      obj[i] = resolve(pdfh(html, p));
    });
    return obj;
  };

  const joinUrl = (a, b) => {
    try {
      return new URL(String(b ?? ''), String(a ?? '')).href;
    } catch {
      return String(b ?? '');
    }
  };

  const req = (url, opt) => {
    if (!url) return { content: '', headers: {}, status: 0 };
    let o = opt;
    if (typeof o === 'string') {
      try {
        o = { headers: JSON.parse(o) };
      } catch {
        o = {};
      }
    }
    const res = reqSync(url, { cookieJar, timeout: 15000, ...(o || {}) });
    if (process.env.JS_RT_DEBUG) log(`req ${res.status} ${String(url).slice(0, 120)}`);
    return res;
  };

  const host = {
    ctx,
    def: (m) => {
      if (m == null) return m;
      if (m.__plainModule) return m;
      if (typeof m === 'object' && 'default' in m && m.default !== undefined) return m.default;
      return m;
    },
    loader,
    logs,
    api: {
      req,
      pdfh,
      pdfa,
      pd,
      joinUrl,
      joinUrl2: joinUrl,
      log,
      print: log,
      getProxy: () => proxyBase || '',
      // TVBox 的 local 是 KV 存储对象（drpy2 用 local.get/set 做缓存），不是函数
      local: (() => {
        const file = path.join(process.cwd(), 'data', 'js-rt-cache', 'local', `${siteKey.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.json`);
        const read = () => {
          try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
          } catch {
            return {};
          }
        };
        const write = (obj) => {
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(obj));
          } catch {
            /* ignore */
          }
        };
        return {
          get: (k, d = '') => {
            const v = read()[k];
            return v === undefined ? d : v;
          },
          set: (k, v) => {
            const o = read();
            o[k] = v;
            write(o);
            return true;
          },
          delete: (k) => {
            const o = read();
            delete o[k];
            write(o);
            return true;
          },
          clear: () => {
            write({});
            return true;
          },
        };
      })(),
      md5: (s) => crypto.createHash('md5').update(String(s)).digest('hex'),
      sleep: () => {},
      setTimeout: (fn) => {
        try {
          if (typeof fn === 'function') fn();
        } catch {
          /* ignore */
        }
        return 0;
      },
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      // 少数规则会用 fetch，包一层同源同步实现（返回 thenable）
      fetch: (url, o) => Promise.resolve(req(url, o)),
    },
  };

  Object.assign(ctx, host.api, {
    console: { log, info: log, warn: log, error: log, debug: log },
    __ctx: ctx,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    JSON,
    Math,
    Date,
    Promise,
    Buffer: undefined,
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    global: ctx,
    window: ctx,
    self: ctx,
  });
  ctx.globalThis = ctx;

  return host;
}

export { JsModuleLoader };
