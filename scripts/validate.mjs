#!/usr/bin/env node
/**
 * NovaTV 端到端验证脚本
 * 用法: node scripts/validate.mjs [baseUrl]
 * 输出: 控制台报告 + reports/validation-<timestamp>.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8890';
const rows = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    rows.push({ name, ok: true, ms: Date.now() - t, detail });
    console.log(`  ✔ ${name}  (${Date.now() - t}ms)${detail ? '  ' + detail : ''}`);
    return true;
  } catch (e) {
    rows.push({ name, ok: false, ms: Date.now() - t, detail: e.message });
    console.log(`  ✘ ${name}  → ${e.message}`);
    return false;
  }
}

async function getJson(pathname) {
  const r = await fetch(BASE + pathname, { signal: AbortSignal.timeout(45000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.items) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log(`\nNovaTV 验证 · ${BASE}\n${'─'.repeat(62)}`);

console.log('\n[1] 服务与接口配置');
await step('健康检查', async () => {
  const j = await getJson('/api/health');
  assert(j.ok, 'health 非 ok');
  return `port=${j.port}`;
});
let cfg;
await step('拉取并解码「饭太硬」配置', async () => {
  cfg = await getJson('/api/config?force=1');
  assert(cfg.sites?.length > 0, '没有解析出任何源');
  return `载体=${cfg.carrier} http=${cfg.http.status} bytes=${cfg.http.bytes} 源=${cfg.sites.length} 耗时=${cfg.tookMs}ms`;
});
await step('站点运行时分类', async () => {
  const s = cfg.stats || {};
  assert(s.total > 0, '统计为空');
  return Object.entries(s.byRuntime).map(([k, v]) => `${k}:${v}`).join(' ');
});
await step('直播源条目', async () => {
  assert(cfg.lives?.length > 0, '没有 lives');
  return `${cfg.lives.length} 组：${cfg.lives.map((l) => l.name).join('/')}`;
});

console.log('\n[2] Spider 包验尸（TVBox type=3 能否复用）');
let diag;
await step('下载 spider 并校验 MD5/结构', async () => {
  diag = await getJson('/api/diag');
  const sp = diag.spider || {};
  assert(sp.entries?.length, 'spider 未解析出条目');
  return `kind=${sp.kind} md5Ok=${sp.md5Ok} entries=${sp.entries.length} guard=${(sp.guardBytes / 1024).toFixed(0)}KB`;
});

console.log('\n[3] 点播链路（搜索 → 详情 → 播放）');
await step('聚合搜索', async () => {
  const j = await getJson('/api/search?wd=' + encodeURIComponent('星际'));
  const ok = j.groups.filter((g) => g.items.length);
  assert(ok.length > 0, '没有命中任何源');
  return `命中 ${ok.length} 源 / ${j.total} 条，跳过 ${j.groups.filter((g) => g.skipped).length} 源，${j.tookMs}ms`;
});
let detail;
await step('详情与多线路解析', async () => {
  detail = await getJson('/api/detail?site=nova-demo&id=1001');
  assert(detail.routes?.length > 0, '没有线路');
  return `${detail.item.name} · ${detail.routes.length} 线路 / ${detail.routes.reduce((s, r) => s + r.episodes.length, 0)} 集`;
});
let play;
await step('取播放地址', async () => {
  play = await getJson('/api/play?site=nova-demo&id=1001&flag=nova_hls&ep=0');
  assert(play.proxyUrl, '没有代理地址');
  return `${play.type} · ${play.url.slice(0, 58)}…`;
});
await step('代理播放 HLS 清单（改写子资源）', async () => {
  const r = await fetch(BASE + play.proxyUrl, { signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  assert(text.includes('#EXTM3U'), '不是有效 m3u8');
  const proxied = (text.match(/\/api\/proxy\?url=/g) || []).length;
  assert(proxied > 0, '子资源未改写');
  return `${r.status} · ${text.length}B · 改写 ${proxied} 个分片`;
});
await step('取首个 TS 分片（Range 透传）', async () => {
  const r0 = await fetch(BASE + play.proxyUrl);
  const m3u8 = await r0.text();
  const seg = m3u8.split('\n').find((l) => l.trim().startsWith('/api/proxy'));
  const r = await fetch(BASE + seg.trim(), { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(30000) });
  const buf = await r.arrayBuffer();
  assert(buf.byteLength > 1000, '分片过小：' + buf.byteLength);
  return `${r.status} · ${(buf.byteLength / 1024).toFixed(1)}KB · ${r.headers.get('content-type')}`;
});

console.log('\n[4] 运行时矩阵（jar / js / android）');
let runtime;
await step('能力矩阵', async () => {
  runtime = await getJson('/api/runtime');
  assert(runtime.runtimes?.length >= 4, '运行时矩阵缺少条目');
  return runtime.runtimes.map((r) => `${r.id}:${r.available ? 'OK' : '--'}`).join(' ');
});
await step('JS 运行时：虎牙源真实搜索', async () => {
  const j = await getJson('/api/search?wd=' + encodeURIComponent('英雄联盟') + '&sites=' + encodeURIComponent('虎牙js'));
  const g = j.groups?.[0] || {};
  assert(g.items?.length > 0, g.error || '没有结果');
  return `${g.items.length} 条 · ${j.tookMs}ms · 首条「${g.items[0].name} / ${g.items[0].remarks}」`;
});
await step('JS 运行时：详情 → 播放（服务端嗅探）', async () => {
  const s = await getJson('/api/search?wd=' + encodeURIComponent('英雄联盟') + '&sites=' + encodeURIComponent('虎牙js'));
  const it = s.groups[0].items[0];
  const d = await getJson('/api/detail?site=' + encodeURIComponent('虎牙js') + '&id=' + encodeURIComponent(it.id));
  assert(d.routes?.length > 0, '没有线路');
  const p = await getJson(
    '/api/play?site=' + encodeURIComponent('虎牙js') +
      '&id=' + encodeURIComponent(it.id) +
      '&flag=' + encodeURIComponent(d.routes[0].flag) + '&ep=0',
  );
  assert(p.url, '取流失败');
  return `${p.needParse ? '需解析' : '直链'} · ${p.type} · 嗅探 ${p.sniffed?.tookMs ?? '—'}ms`;
});
await step('JVM 侧车：加载真实 jar 并搜索', async () => {
  const jvm = runtime.runtimes.find((r) => r.id === 'jar-spider');
  if (!jvm?.sidecar?.up) throw new Error('侧车未启动（node scripts/jvm-sidecar.mjs）');
  const j = await getJson('/api/search?wd=' + encodeURIComponent('演示') + '&sites=jvm-demo');
  const g = j.groups?.[0] || {};
  assert(g.items?.length > 0, g.error || '没有结果');
  return `${g.items.length} 条 · ${g.tookMs}ms · 引擎 ${jvm.sidecar.body?.service || 'sidecar'}`;
});
await step('JVM 侧车：详情 → 播放 → 代理', async () => {
  const d = await getJson('/api/detail?site=jvm-demo&id=j1');
  assert(d.routes?.length > 0, '没有线路');
  const p = await getJson('/api/play?site=jvm-demo&id=j1&flag=' + encodeURIComponent(d.routes[0].flag) + '&ep=0');
  const r = await fetch(BASE + p.proxyUrl, { signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  assert(t.includes('#EXTM3U'), '代理清单异常');
  return `${p.type} · 代理 ${r.status} · ${t.length}B`;
});

console.log('\n[5] 直播链路（真实源）');
let live;
await step('解析直播播放列表', async () => {
  live = await getJson('/api/live?index=3');
  assert(live.count > 0, '没有频道');
  return `${live.name} · ${live.count} 频道 / ${live.groups.length} 分组`;
});
await step('探测直播流类型', async () => {
  const m3u8Ch = live.groups.flatMap((g) => g.channels).find((c) => /\.m3u8/.test(c.url));
  assert(m3u8Ch, '没有 m3u8 频道');
  const j = await getJson('/api/probe?url=' + encodeURIComponent(m3u8Ch.url));
  assert(j.type, '探测失败');
  return `${m3u8Ch.name} → ${j.type} (${j.contentType})`;
});
await step('直播 HLS 经代理播放', async () => {
  const m3u8Ch = live.groups.flatMap((g) => g.channels).find((c) => /\.m3u8/.test(c.url));
  const r = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent(m3u8Ch.url), { signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  assert(t.includes('#EXTM3U'), '不是有效播放列表');
  return `${r.status} · ${t.length}B`;
});

console.log('\n[6] 静态资源');
await step('首页 HTML', async () => {
  const r = await fetch(BASE + '/');
  const t = await r.text();
  assert(t.includes('NovaTV'), '首页异常');
  return `${r.status} · ${t.length}B`;
});
await step('hls.js / mpegts.js 本地化', async () => {
  const a = await fetch(BASE + '/vendor/hls.min.js');
  const b = await fetch(BASE + '/vendor/mpegts.js');
  assert(a.ok && b.ok, '播放器脚本缺失');
  return `hls.js ${((await a.arrayBuffer()).byteLength / 1024) | 0}KB · mpegts.js ${((await b.arrayBuffer()).byteLength / 1024) | 0}KB`;
});

const ok = rows.filter((r) => r.ok).length;
console.log(`\n${'─'.repeat(62)}`);
console.log(`结果：${ok}/${rows.length} 通过${ok === rows.length ? '  ✅ 全部通过' : '  ⚠️ 有失败项'}`);

// 结论摘要
const summary = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  config: cfg && {
    carrier: cfg.carrier,
    http: cfg.http,
    payloadOffset: cfg.payloadOffset,
    sites: cfg.stats,
    lives: cfg.lives?.length,
    spider: cfg.spider,
  },
  spider: diag?.spider && {
    kind: diag.spider.kind,
    md5Ok: diag.spider.md5Ok,
    entries: diag.spider.entries.map((e) => e.name),
    guardBytes: diag.spider.guardBytes,
    verdict: diag.spider.verdict,
  },
  steps: rows,
};
await fs.mkdir('reports', { recursive: true });
const file = path.join('reports', `validation-${Date.now()}.json`);
await fs.writeFile(file, JSON.stringify(summary, null, 2));
console.log(`报告已写入 ${file}\n`);
process.exit(ok === rows.length ? 0 : 1);
