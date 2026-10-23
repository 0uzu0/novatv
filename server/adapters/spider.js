/**
 * Spider 桥接适配器
 *
 * TVBox 的 type=3 站点由 jar 内的 spider 实现（CatVod Spider 接口）。
 * 服务端复用它的唯一办法是「外部运行时」，这里对接两种侧车：
 *
 *   jvm      → sidecar/jvm（未加固 jar，可加载 com.github.catvod.spider.*）
 *   android  → sidecar/android（加固包，只能在 Android 容器里跑）
 *
 * 协议一致：POST {bridge}/spider {site, method, params} → {ok, data}
 * data 是 spider 的原始返回值（TVBox 形态的 JSON 字符串），这里负责归一化。
 */
import { buildRoutes, resolvePlayUrl } from './cms.js';

function pickBridge(site) {
  const env = process.env;
  const isJvmJar = site?.spiderKind === 'jvm-jar' || /^csp_/i.test(String(site?.api || ''));
  const candidates = [
    env.SPIDER_JVM_URL,
    env.SPIDER_BRIDGE_URL && !/android/i.test(env.SPIDER_BRIDGE_URL) ? env.SPIDER_BRIDGE_URL : '',
    isJvmJar ? 'http://127.0.0.1:8899' : '',
    env.SPIDER_ANDROID_URL,
    env.SPIDER_BRIDGE_URL,
  ].filter(Boolean);
  return candidates[0] || '';
}

const asObj = (v) => {
  if (!v) return {};
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v;
};

function normalizeItem(v) {
  return {
    id: String(v.vod_id ?? v.id ?? ''),
    name: String(v.vod_name || v.name || '').trim(),
    pic: v.vod_pic || v.pic || '',
    remarks: v.vod_remarks || v.note || '',
    year: String(v.vod_year || ''),
    area: v.vod_area || '',
    typeName: v.vod_class || v.type_name || '',
    actor: v.vod_actor || '',
    director: v.vod_director || '',
    score: v.vod_score ? String(v.vod_score) : '',
    content: String(v.vod_content || v.des || '').replace(/<[^>]+>/g, ' ').trim(),
    playFrom: v.vod_play_from || '',
    playUrl: v.vod_play_url || '',
  };
}

export class SpiderBridgeAdapter {
  constructor(site, ctx) {
    this.site = site;
    this.ctx = ctx;
    this.bridge = pickBridge(site);
  }

  get available() {
    return Boolean(this.bridge);
  }

  async #call(method, params = {}) {
    if (!this.bridge) {
      const diag = await this.ctx.store.inspectSpider().catch(() => ({}));
      const err = new Error(
        `源「${this.site.name}」依赖 ${this.site.api}（${this.site.runtimeReason}），当前没有可用的 spider 侧车`,
      );
      err.code = 'SPIDER_RUNTIME_MISSING';
      err.detail = {
        site: this.site.key,
        api: this.site.api,
        spider: { kind: diag.kind, verdict: diag.verdict, guardBytes: diag.guardBytes },
        fix:
          diag.kind === 'android-hardened'
            ? '加固包只能用 Android 容器：sidecar/android/docker-compose.yml（redroid）或真机 + Host APK'
            : '普通 jar 可起 JVM 侧车：node scripts/jvm-sidecar.mjs，并设置 SPIDER_JVM_URL',
      };
      throw err;
    }
    const res = await fetch(this.bridge.replace(/\/$/, '') + '/spider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site: { key: this.site.key, name: this.site.name, api: this.site.api, ext: this.site.ext, spiderJar: this.site.spiderJar },
        method,
        params,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const body = asObj(await res.json().catch(() => ({})));
    if (!body.ok) {
      const err = new Error(body.error || `侧车返回 ${res.status}`);
      err.code = 'SPIDER_BRIDGE_ERROR';
      err.detail = body;
      throw err;
    }
    return asObj(body.data);
  }

  async home() {
    return this.category({ tid: '', pg: 1 });
  }

  async category({ tid = '', pg = 1 } = {}) {
    const started = Date.now();
    const r = await this.#call('category', { tid, pg });
    return {
      site: this.site.key,
      items: (r.list || []).map(normalizeItem).filter((x) => x.name),
      classes: (r.class || []).map((c) => ({ id: String(c.type_id), name: String(c.type_name) })),
      page: Number(r.page || pg),
      tookMs: Date.now() - started,
      runtime: 'jar-spider',
      engine: this.bridge,
    };
  }

  async search(wd) {
    const started = Date.now();
    const r = await this.#call('search', { wd });
    return {
      site: this.site.key,
      items: (r.list || []).map(normalizeItem).filter((x) => x.name),
      page: Number(r.page || 1),
      tookMs: Date.now() - started,
      runtime: 'jar-spider',
      engine: this.bridge,
    };
  }

  async detail(id) {
    const started = Date.now();
    const r = await this.#call('detail', { id });
    const item = normalizeItem((r.list || [])[0] || {});
    const routes = buildRoutes(item.playFrom, item.playUrl);
    return { site: this.site.key, item, routes, tookMs: Date.now() - started, runtime: 'jar-spider' };
  }

  async play({ id, flag, ep }) {
    const { routes } = await this.detail(id);
    const route = routes.find((r) => r.flag === flag) || routes[0];
    if (!route) throw new Error('该影片没有可播放地址');
    const episode = route.episodes[Number(ep) || 0] || route.episodes[0];
    if (!episode) throw new Error('剧集不存在');
    const started = Date.now();
    const r = await this.#call('play', { flag: route.flag, ep: episode.url, id });
    const raw = String(r.url || r.playUrl || episode.url);
    const resolved = resolvePlayUrl(raw, this.site);
    return {
      ...resolved,
      site: this.site.key,
      flag: route.flag,
      title: episode.name,
      parse: Number(r.parse || 0),
      header: r.header || null,
      tookMs: Date.now() - started,
    };
  }
}
