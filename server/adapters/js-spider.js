/**
 * JS spider 适配器（TVBox type=3 且 api 为 .js：drpy / hipy 系）
 *
 * 引擎在 server/runtimes/js-rt 里跑，这里只做三件事：
 *   1) 调用 + 归一化（drpy 返回的常是 JSON 字符串）
 *   2) 剧集拆解复用 macCMS 的 "$$$ / # / $" 约定
 *   3) parse=1（返回网页）时调用服务端轻量嗅探，拿不到就如实标记需要解析
 */
import { getEngine, invoke, invokeAuto } from '../runtimes/js-rt/engine.js';
import { buildRoutes, resolvePlayUrl } from './cms.js';
import { sniffStream, looksLikePage } from '../runtimes/js-rt/sniffer.js';

function asObj(v) {
  if (!v) return {};
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v;
}

function normalizeItem(v) {
  const name = v.vod_name || v.name || v.title || '';
  return {
    id: String(v.vod_id ?? v.id ?? ''),
    name: String(name).trim(),
    pic: v.vod_pic || v.pic || v.vod_pic_slide || '',
    remarks: v.vod_remarks || v.note || '',
    year: String(v.vod_year || ''),
    area: v.vod_area || '',
    typeName: v.vod_class || v.type_name || '',
    actor: v.vod_actor || '',
    director: v.vod_director || '',
    score: v.vod_score ? String(v.vod_score) : '',
    content: String(v.vod_content || v.vod_blurb || v.des || '').replace(/<[^>]+>/g, ' ').trim(),
    playFrom: v.vod_play_from || '',
    playUrl: v.vod_play_url || '',
  };
}

export class JsSpiderAdapter {
  constructor(site, ctx) {
    this.site = site;
    this.ctx = ctx;
    this.proxyBase = ctx?.proxyBase || '';
  }

  async #engine() {
    if (!this.box) {
      this.box = await getEngine(this.site, { proxyBase: this.proxyBase });
      this.box.logs = this.box.host?.logs;
    }
    return this.box;
  }

  async #call(method, ...args) {
    const box = await this.#engine();
    return asObj(await invokeAuto(box, method, ...args));
  }

  async home() {
    return this.category({ tid: '', pg: 1 });
  }

  async category({ tid = '', pg = 1 } = {}) {
    const started = Date.now();
    const r = await this.#call('category', tid, pg, {}, {});
    const classes = (asObj(r).class || []).map((c) => ({ id: String(c.type_id), name: String(c.type_name) }));
    return {
      site: this.site.key,
      items: (r.list || []).map(normalizeItem).filter((x) => x.name),
      classes,
      page: Number(r.page || pg),
      pagecount: Number(r.pagecount || 0),
      tookMs: Date.now() - started,
      runtime: 'js-spider',
    };
  }

  async search(wd) {
    const started = Date.now();
    const r = await this.#call('search', wd, false);
    return {
      site: this.site.key,
      items: (r.list || []).map(normalizeItem).filter((x) => x.name),
      page: Number(r.page || 1),
      tookMs: Date.now() - started,
      runtime: 'js-spider',
    };
  }

  async detail(id) {
    const started = Date.now();
    const r = await this.#call('detail', id);
    const item = normalizeItem((r.list || [])[0] || {});
    if (!item.id && !item.name) throw new Error('详情为空');
    const routes = buildRoutes(item.playFrom, item.playUrl);
    return { site: this.site.key, item, routes, tookMs: Date.now() - started, runtime: 'js-spider' };
  }

  async play({ id, flag, ep }) {
    const { routes, item } = await this.detail(id);
    const route = routes.find((r) => r.flag === flag) || routes[0];
    if (!route) throw new Error('该影片没有可播放地址');
    const episode = route.episodes[Number(ep) || 0] || route.episodes[0];
    if (!episode) throw new Error('剧集不存在');

    const started = Date.now();
    let r = {};
    try {
      r = asObj(await invokeAuto(await this.#engine(), 'play', route.flag, episode.url, []));
    } catch (e) {
      // 有些规则 play 需要完整 item 作为第三参；失败时退回原始地址
      r = { url: episode.url, note: e.message };
    }

    const rawUrl = String(r.url || r.playUrl || episode.url || '');
    const needParseFlag = Number(r.parse) === 1 || (looksLikePage(rawUrl) && !/\.(m3u8|mp4|flv)/i.test(rawUrl));

    // parse=1：页面对 TVBox 是交给 WebView 嗅探的；服务端先试轻量嗅探
    if (needParseFlag && /^https?:/i.test(rawUrl)) {
      const sn = sniffStream(rawUrl, { referer: new URL(rawUrl).origin + '/' });
      if (sn.ok) {
        return {
          site: this.site.key,
          flag: route.flag,
          title: episode.name,
          url: sn.url,
          type: sn.type,
          headers: { Referer: sn.referer, 'User-Agent': 'Mozilla/5.0' },
          needParse: false,
          sniffed: { from: rawUrl, type: sn.type, tookMs: sn.tookMs, bytes: sn.bytes },
          tookMs: Date.now() - started,
        };
      }
      return {
        ...resolvePlayUrl(rawUrl, this.site),
        site: this.site.key,
        flag: route.flag,
        title: episode.name,
        url: rawUrl,
        type: 'unknown',
        needParse: true,
        parse: 1,
        sniffed: { ok: false, reason: sn.reason },
        message: `该线路返回的是网页地址，服务端嗅探未命中（${sn.reason}），需要 WebView 解析接口`,
        tookMs: Date.now() - started,
      };
    }

    const resolved = resolvePlayUrl(rawUrl, this.site);
    return {
      ...resolved,
      site: this.site.key,
      flag: route.flag,
      title: episode.name,
      rawUrl,
      tookMs: Date.now() - started,
    };
  }
}
