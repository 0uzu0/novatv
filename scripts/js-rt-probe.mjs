/**
 * JS 运行时探针：逐步验证 模块图 → 引擎装载 → init(规则) → home/search
 * 用法：node scripts/js-rt-probe.mjs <apiUrl> <extUrl> [关键词]
 */
import { createHost } from '../server/runtimes/js-rt/host.js';
import { createJsEngine, invoke } from '../server/runtimes/js-rt/engine.js';

const api = process.argv[2];
const ext = process.argv[3];
const kw = process.argv[4] || '';

if (!api || !ext) {
  console.error('用法: node scripts/js-rt-probe.mjs <apiUrl> <extUrl> [关键词]');
  process.exit(1);
}

const step = async (name, fn) => {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${name} (${Date.now() - t}ms)`, typeof r === 'string' ? r.slice(0, 160) : '');
    return r;
  } catch (e) {
    console.log(`✗ ${name} (${Date.now() - t}ms): ${e.message}`);
    if (e.detail?.logs) console.log('  logs:', JSON.stringify(e.detail.logs).slice(0, 800));
    if (process.env.DEBUG) console.log(e.stack);
    return null;
  }
};

const host = createHost({ siteKey: 'probe', baseUrl: api });

await step('cheerio 模块', () => {
  const m = host.loader.load('assets://js/lib/cheerio.min.js', host, api, false);
  const ch = m && m.default ? m.default : m;
  if (typeof ch?.load !== 'function') throw new Error('load 不是函数: keys=' + Object.keys(ch || {}).join(','));
  const $ = ch.load('<div class="a"><b>hi</b></div>');
  return 'selector=' + $('.a b').text();
});

await step('宿主 pdfh/pdfa', () => {
  const h = host.api.pdfh('<ul><li><a href="/x" title="t1">A1</a></li><li><a href="/y" title="t2">A2</a></li></ul>', 'li&&Text');
  const a = host.api.pdfa('<ul><li><a href="/x" title="t1">A1</a></li><li><a href="/y" title="t2">A2</a></li></ul>', 'li a&&href');
  if (!h) throw new Error('pdfh 空');
  return `pdfh=${h} pdfa=${JSON.stringify(a)}`;
});

const box = await step('引擎装载+init', () => createJsEngine({ api, ext, key: 'probe', name: 'probe' }));
if (box) {
  console.log('  导出方法:', Object.keys(box.engine).filter((k) => typeof box.engine[k] === 'function').join(','));
  console.log('  模块图:', box.host.loader.trace.map((t) => `${t.url.split('/').pop()}(${Math.round(t.bytes / 1024)}k)`).join(' → '));

  await step('home()', async () => {
    const r = await invoke(box, 'home');
    const cls = (r?.class || []).map((c) => c.type_name || c.type_id).slice(0, 8);
    return `class=${cls.join('/')} list=${(r?.list || []).length}`;
  });

  if (kw) {
    await step(`search(${kw})`, async () => {
      const r = await invoke(box, 'search', kw, false);
      const list = r?.list || [];
      console.log('  前3条:', list.slice(0, 3).map((v) => `${v.vod_id}|${v.vod_name}|${String(v.vod_pic || '').slice(0, 40)}`));
      return `total=${list.length}`;
    });
  }
  console.log('日志尾部:', JSON.stringify(box.host.logs.slice(-6)));
}
