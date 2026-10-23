import httpMod from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config/loader.js';
import { createContext, adapterFor, liveAdapterFor, publicSite } from './registry.js';
import { handleMock } from '../fixtures/mock-cms.js';
import { http } from './util/http.js';
import { fetchx } from './util/curl.js';
import { capabilityMatrix } from './runtimes/index.js';
import { engineStatus, isWarm } from './runtimes/js-rt/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8890);
const CONFIG_URL = process.env.CONFIG_URL || 'http://www.饭太硬.cc/tv';

const store = new ConfigStore({ url: CONFIG_URL });
const ctx = createContext(store);
ctx.proxyBase = `http://127.0.0.1:${PORT}/api/proxy`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const demoSite = {
  key: 'nova-demo',
  name: '🎬 Nova 演示源',
  api: `http://127.0.0.1:${PORT}/mock/api.php/provide/vod/`,
  type: 1,
  runtime: 'cms-json',
  runtimeReason: '本地 mock CMS（验证链路用）',
  supported: true,
  searchable: 1,
  quickSearch: 1,
  style: null,
  demo: true,
};

const jvmDemoSite = {
  key: 'jvm-demo',
  name: '🧩 JVM 侧车演示源',
  api: 'csp_DemoSpider',
  type: 3,
  runtime: 'jar-spider',
  runtimeReason: '由 sidecar/jvm 加载 demo-spider.jar（模拟未加固 jar）',
  supported: false,
  searchable: 1,
  quickSearch: 0,
  style: null,
  demo: true,
  spiderJar: path.join(ROOT, 'sidecar', 'jvm', 'build', 'demo-spider.jar'),
};

let capsCache = { at: 0, val: null };
async function caps() {
  if (capsCache.val && Date.now() - capsCache.at < 30000) return capsCache.val;
  const m = await capabilityMatrix({}).catch(() => ({ runtimes: [] }));
  // 站点能不能真的跑，取决于侧车是否在线（而不是本机装没装 JDK）
  const jvmUp = m.runtimes.find((r) => r.id === 'jar-spider')?.sidecar?.up === true;
  const androidUp = m.runtimes.some((r) => r.id === 'android-spider' && r.available);
  capsCache = { at: Date.now(), val: { jvm: jvmUp, android: androidUp, matrix: m } };
  return capsCache.val;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function sites() {
  const [cfg, c] = await Promise.all([store.get(), caps()]);
  const list = [demoSite, jvmDemoSite, ...cfg.sites];
  // jar 源能不能跑有两个条件：包里是不是普通 jar + 对应侧车是否在线
  const spider = await store.inspectSpider().catch(() => ({}));
  const canSharedJar = (spider.kind === 'jvm-jar' && c.jvm) || c.android;
  return list.map((s) => {
    if (s.runtime !== 'jar-spider') return s;
    const supported = s.spiderJar ? c.jvm || c.android : canSharedJar;
    return { ...s, supported };
  });
}

async function findSite(key) {
  const all = await sites();
  const site = all.find((s) => s.key === key);
  if (!site) throw Object.assign(new Error(`未找到源 ${key}`), { status: 404 });
  return site;
}

/**
 * 统一「运行时缺失」响应。
 * 提示必须按包的真实类型给：加固包配 SPIDER_BRIDGE_URL 也没用，
 * 说错方向比不提示更糟（用户会去折腾一个注定失败的方案）。
 */
async function runtimeMissing(res, site) {
  const spider = await store.inspectSpider().catch(() => ({}));
  const hardened = spider.kind === 'android-hardened' || spider.kind === 'android-dex';
  return json(res, 501, {
    error: `该源需要 ${site.runtime} 运行时（${hardened ? 'Android 加固包' : 'jar spider'}）`,
    code: 'SPIDER_RUNTIME_MISSING',
    site: publicSite(site),
    spider: { kind: spider.kind, verdict: spider.verdict, guardBytes: spider.guardBytes },
    fix: hardened
      ? {
          why: '加固包的 classes.dex 只是壳，真实字节码在 assets/*.guard 里，由 ARM 的 .so 解密后交给 ART；JVM / Node 都拿不到',
          how: [
            '1) 预检宿主该走哪条路线：sudo bash sidecar/android/preflight.sh',
            '2) 有 /dev/kvm → 起 KVM 虚拟机里的 Android：',
            '   docker compose -f docker-compose.nas.yml --profile android up -d',
            '   再装 APK：ADB_PORT=15555 bash sidecar/android/install-apk.sh 127.0.0.1 <token>',
            '3) 有 binder → 起 redroid：docker compose -f sidecar/android/docker-compose.redroid-x86.yml up -d',
            '4) 设 SPIDER_ANDROID_URL 指过去（容器形态填 http://host.docker.internal:8899）',
            '（有闲置安卓手机/TV 盒子时优先用真机，成功率 100%）',
            '详见 docs/NAS-DEPLOY.md 第六节',
          ],
        }
      : {
          why: '这是标准 JVM jar，需要 JVM 侧车加载',
          how: ['node scripts/jvm-sidecar.mjs', '设置 SPIDER_JVM_URL=http://127.0.0.1:8899'],
        },
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), port: PORT, configUrl: CONFIG_URL });
  }

  if (p === '/api/config') {
    const force = q.get('force') === '1';
    const cfg = await store.get({ force });
    const { raw, ...rest } = cfg;
    return json(res, 200, { ...rest, configUrl: CONFIG_URL });
  }

  if (p === '/api/sources') {
    const all = await sites();
    const cfg = await store.get();
    return json(res, 200, {
      stats: cfg.stats,
      carrier: cfg.carrier,
      spider: cfg.spider,
      sites: all.map(publicSite),
      lives: cfg.lives.map((l) => ({ index: l.index, name: l.name, url: l.url, type: l.type ?? 0 })),
    });
  }

  if (p === '/api/diag') {
    const cfg = await store.get();
    const spider = await store.inspectSpider({ force: q.get('force') === '1' });
    const runtimeStats = cfg.stats.byRuntime;
    return json(res, 200, {
      config: {
        url: CONFIG_URL,
        http: cfg.http,
        carrier: cfg.carrier,
        payloadOffset: cfg.payloadOffset,
        tookMs: cfg.tookMs,
      },
      spider,
      runtimes: runtimeStats,
      sites: cfg.sites.map((s) => ({
        key: s.key,
        name: s.name,
        runtime: s.runtime,
        supported: s.supported,
        api: s.api,
        reason: s.runtimeReason,
      })),
    });
  }

  if (p === '/api/runtime') {
    const spider = await store.inspectSpider().catch(() => null);
    const matrix = await capabilityMatrix({ spider });
    return json(res, 200, {
      ...matrix,
      jsEngines: engineStatus(),
      config: { url: CONFIG_URL, stats: (await store.get()).stats },
      env: {
        SPIDER_BRIDGE_URL: process.env.SPIDER_BRIDGE_URL || null,
        SPIDER_JVM_URL: process.env.SPIDER_JVM_URL || null,
        SPIDER_ANDROID_URL: process.env.SPIDER_ANDROID_URL || null,
      },
    });
  }

  if (p === '/api/lives') {
    const cfg = await store.get();
    return json(res, 200, { lives: cfg.lives.map((l) => ({ index: l.index, name: l.name, url: l.url, ua: l.ua })) });
  }

  if (p === '/api/live') {
    const cfg = await store.get();
    const idx = Number(q.get('index') || 0);
    const entry = cfg.lives[idx];
    if (!entry) return json(res, 404, { error: '直播源不存在' });
    try {
      const data = await liveAdapterFor(entry, ctx).load();
      return json(res, 200, data);
    } catch (e) {
      return json(res, 502, { error: e.message, source: entry.name });
    }
  }

  if (p === '/api/search') {
    const wd = (q.get('wd') || '').trim();
    if (!wd) return json(res, 400, { error: '缺少 wd 参数' });
    const only = (q.get('sites') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const limit = Math.min(Number(q.get('limit') || 24), 60);
    const all = await sites();
    const targets = all.filter((s) => (only.length ? only.includes(s.key) : true));
    const started = Date.now();
    const results = await Promise.all(
      targets.map(async (site) => {
        if (!site.supported) {
          return {
            site: site.key,
            name: site.name,
            runtime: site.runtime,
            ok: false,
            skipped: true,
            items: [],
            error: site.runtimeReason,
          };
        }
        // JS 源的引擎冷启动要 5~10s（模块图 + 规则 init），全量聚合时不等它；
        // 指定 sites= 单独搜、或引擎已预热时照常参与。
        if (site.runtime === 'js-spider' && !only.length && !isWarm(site.key, site.api)) {
          return {
            site: site.key,
            name: site.name,
            runtime: site.runtime,
            ok: false,
            skipped: true,
            items: [],
            error: 'JS 源引擎未预热，聚合搜索默认跳过（单独选该源搜索会自动预热）',
          };
        }
        const t = Date.now();
        try {
          const r = await adapterFor(site, ctx).search(wd);
          return {
            site: site.key,
            name: site.name,
            runtime: site.runtime,
            ok: true,
            items: r.items.slice(0, limit),
            tookMs: Date.now() - t,
          };
        } catch (e) {
          return {
            site: site.key,
            name: site.name,
            runtime: site.runtime,
            ok: false,
            items: [],
            error: e.message,
            detail: e.detail,
            tookMs: Date.now() - t,
          };
        }
      }),
    );
    const okCount = results.filter((r) => r.ok).length;
    return json(res, 200, {
      wd,
      total: results.reduce((s, r) => s + (r.items?.length || 0), 0),
      okCount,
      failedCount: results.length - okCount,
      tookMs: Date.now() - started,
      groups: results,
    });
  }

  if (p === '/api/home' || p === '/api/category') {
    const key = q.get('site');
    const site = await findSite(key);
    if (!site.supported) return runtimeMissing(res, site);
    const r = await adapterFor(site, ctx).category({ tid: q.get('tid') || '', pg: Number(q.get('pg') || 1) });
    return json(res, 200, { site: publicSite(site), ...r });
  }

  if (p === '/api/detail') {
    const site = await findSite(q.get('site'));
    const id = q.get('id');
    if (!id) return json(res, 400, { error: '缺少 id' });
    if (!site.supported) return runtimeMissing(res, site);
    try {
      const r = await adapterFor(site, ctx).detail(id);
      return json(res, 200, { site: publicSite(site), ...r });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (p === '/api/play') {
    const site = await findSite(q.get('site'));
    const id = q.get('id');
    if (!site.supported) return runtimeMissing(res, site);
    try {
      const r = await adapterFor(site, ctx).play({ id, flag: q.get('flag') || '', ep: q.get('ep') || '0' });
      // 代理要带上取流所需的 Referer/UA，否则多数直播 CDN 直接 403
      let proxied = r.url;
      if (r.url && /^https?:/i.test(r.url)) {
        const qs = new URLSearchParams({ url: r.url });
        const ref = r.headers?.Referer || r.referer;
        const ua = r.headers?.['User-Agent'] || r.headers?.['user-agent'];
        if (ref) qs.set('referer', ref);
        if (ua) qs.set('ua', ua);
        proxied = '/api/proxy?' + qs.toString();
      }
      return json(res, 200, { ...r, proxyUrl: proxied });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  return json(res, 404, { error: 'API 不存在' });
}

/** 媒体/图片代理：绕过 CORS + Mixed Content，m3u8 改写子资源，其余内容流式透传（支持直播/拖动） */
async function handleProxy(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return json(res, 400, { error: '缺少 url' });
  const referer = url.searchParams.get('referer') || undefined;
  const ua = url.searchParams.get('ua') || undefined;
  const range = req.headers.range;

  let origin;
  try {
    origin = new URL(target);
  } catch {
    return json(res, 400, { error: 'url 非法' });
  }

  try {
    // fetchx：直连失败会回落 curl（curl 才读 HTTPS_PROXY），NAS 上很关键
    const up = await fetchx(origin, {
      headers: {
        'User-Agent': ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*',
        ...(referer ? { Referer: referer } : {}),
        ...(range ? { Range: range } : {}),
      },
      redirect: 'follow',
      timeout: 30000,
    });

    const ct = up.headers.get('content-type') || 'application/octet-stream';
    const finalUrl = up.url || origin.href;
    const looksM3u8 =
      /mpegurl/i.test(ct) ||
      /\.m3u8(\?|$)/i.test(new URL(finalUrl).pathname) ||
      /\.m3u8(\?|$)/i.test(origin.pathname);

    const baseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    };

    if (looksM3u8) {
      const text = await up.text();
      // 有些源 content-type 给错（octet-stream），只有真的 #EXTM3U 才当播放列表处理
      if (text.trimStart().startsWith('#EXTM3U')) {
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(rewriteM3u8(text, finalUrl, { referer, ua }));
      }
      res.writeHead(up.status, { ...baseHeaders, 'Content-Type': ct, 'Cache-Control': 'no-store' });
      return res.end(text);
    }

    // 大文件 / 直播流：流式透传，避免整包 buffer 卡死
    const headers = { ...baseHeaders, 'Content-Type': ct, 'Cache-Control': 'public, max-age=300' };

    // curl 回退（fetchx 直连失败时走这条，国内是常态）：整包已经在内存里，没有 body 流。
    // 此时绝不能透传上游的 Content-Length，否则声明 950KB 却只发 0 字节，
    // 浏览器/播放器会一直等（curl 报 end of response with N bytes missing）。
    if (!up.body) {
      const buf = Buffer.from(await up.arrayBuffer());
      headers['Content-Length'] = String(buf.length);
      res.writeHead(up.status, headers);
      return res.end(buf);
    }

    // fetch 路径：只透传 range 相关头。Content-Length 仅在未被压缩时透传——
    // undici 会透明解压，压缩流的长度与解压后不符，透传同样会截断。
    for (const h of ['content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) headers[h.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase())] = v;
    }
    const enc = up.headers.get('content-encoding');
    if (!enc || enc === 'identity') {
      const cl = up.headers.get('content-length');
      if (cl) headers['Content-Length'] = cl;
    }
    res.writeHead(up.status, headers);
    const { Readable } = await import('node:stream');
    const nodeStream = Readable.fromWeb(up.body);
    nodeStream.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });
    // 注意：不能监听 req 的 'close'。Node 16+ 里 GET 请求体一读完就会触发 'close'，
    // 会把还在传输的响应流当场销毁。只应在客户端真正断开时清理上游流。
    res.on('close', () => {
      if (!res.writableEnded) nodeStream.destroy();
    });
    nodeStream.pipe(res);
  } catch (e) {
    if (!res.headersSent) return json(res, 502, { error: `代理失败: ${e.message}` });
    res.destroy();
  }
}

/** 探测流类型：给前端选择 hls.js / mpegts.js 引擎 */
async function handleProbe(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return json(res, 400, { error: '缺少 url' });
  try {
    const up = await fetchx(target, {
      headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-1' },
      redirect: 'follow',
      timeout: 12000,
    });
    const ct = up.headers.get('content-type') || '';
    const finalUrl = up.url || target;
    try {
      await up.arrayBuffer();
    } catch {
      /* 直播流可能读不完，忽略 */
    }
    const low = (ct + ' ' + finalUrl).toLowerCase();
    const type = /mpegurl|m3u8/.test(low) ? 'hls' : /flv/.test(low) ? 'flv' : /mp4|video\//.test(low) ? 'mp4' : 'unknown';
    return json(res, 200, { status: up.status, contentType: ct, finalUrl, type });
  } catch (e) {
    return json(res, 200, { type: 'error', error: e.message });
  }
}

export function rewriteM3u8(text, baseUrl, extra = {}) {
  const base = new URL(baseUrl);
  // 用相对路径，前端/hls.js 会基于 m3u8 自身地址解析，换域名部署也不用改
  // referer/ua 必须一路透传，否则分片会被 CDN 403（虎牙这类直播源强制校验）
  const tail = (extra.referer ? '&referer=' + encodeURIComponent(extra.referer) : '') + (extra.ua ? '&ua=' + encodeURIComponent(extra.ua) : '');
  const proxy = (abs) => `/api/proxy?url=${encodeURIComponent(abs)}${tail}`;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith('#')) {
        // 密钥 / init 分片 的 URI="..." 也要走代理
        return l.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${proxy(new URL(uri, base).href)}"`);
      }
      try {
        return proxy(new URL(l, base).href);
      } catch {
        return line;
      }
    })
    .join('\n');
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    // SPA 回退
    try {
      const html = await fs.readFile(path.join(WEB, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }
}

const server = httpMod.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/proxy') return await handleProxy(req, res, url);
      if (url.pathname === '/api/probe') return await handleProbe(req, res, url);
      return await handleApi(req, res, url);
    }
    if (url.pathname.startsWith('/mock/')) return handleMock(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n  NovaTV  ✦  聚合视频平台`);
  console.log(`  ────────────────────────────`);
  console.log(`  本地访问   http://127.0.0.1:${PORT}`);
  console.log(`  接口配置   ${CONFIG_URL}`);
  console.log(`  调试接口   /api/diag`);
  console.log(`  ────────────────────────────\n`);
  store.get().catch((e) => console.warn('[config] 首次加载失败:', e.message));
});
