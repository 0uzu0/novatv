import { http } from '../util/http.js';

/** macCMS / 苹果CMS 采集接口适配器（TVBox type=1 的 JSON、type=0 的 XML） */
export class CmsAdapter {
  constructor(site, ctx) {
    this.site = site;
    this.ctx = ctx;
    this.client = ctx.client;
    this.base = normalizeBase(site.api);
    this.format = site.runtime === 'cms-xml' ? 'xml' : 'json';
  }

  async request(params) {
    const url = this.base + (this.base.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
    const started = Date.now();
    const res = await this.client.raw(url, { timeout: (this.site.timeout || 12) * 1000, retry: 1 });
    const text = decodeMaybeGbk(res.buffer, res.headers);
    return { text, url, http: res.status, tookMs: Date.now() - started };
  }

  async home() {
    return this.category({ tid: '', pg: 1 });
  }

  async category({ tid = '', pg = 1 } = {}) {
    const { text, tookMs, url } = await this.request({ ac: 'videolist', ...(tid ? { t: tid } : {}), pg });
    const items = this.format === 'xml' ? parseXmlList(text) : parseJsonList(text);
    return { site: this.site.key, items, page: pg, tookMs, url, classes: this.format === 'json' ? parseClasses(text) : [] };
  }

  async search(wd, pg = 1) {
    const { text, tookMs, url } = await this.request({ ac: 'videolist', wd, pg });
    const items = this.format === 'xml' ? parseXmlList(text) : parseJsonList(text);
    return { site: this.site.key, items, page: pg, tookMs, url };
  }

  async detail(id) {
    const { text, tookMs, url } = await this.request({ ac: 'videolist', ids: id });
    const items = this.format === 'xml' ? parseXmlList(text) : parseJsonList(text);
    const item = items[0];
    if (!item) throw new Error(`详情为空（id=${id}）`);
    const playFrom = item.playFrom || '';
    const playUrl = item.playUrl || '';
    const routes = buildRoutes(playFrom, playUrl);
    return { site: this.site.key, item, routes, tookMs, url };
  }

  async play({ id, flag, ep }) {
    const { routes } = await this.detail(id);
    const route = routes.find((r) => r.flag === flag) || routes[0];
    if (!route) throw new Error('该影片没有可播放地址');
    const episode = route.episodes[Number(ep) || 0] || route.episodes[0];
    if (!episode) throw new Error('剧集不存在');
    const resolved = resolvePlayUrl(episode.url, this.site);
    return {
      site: this.site.key,
      flag: route.flag,
      title: episode.name,
      ...resolved,
    };
  }
}

function normalizeBase(api) {
  if (/provide\/vod\/?$/.test(api) && !api.endsWith('/')) return api + '/';
  return api;
}

function decodeMaybeGbk(buf, headers) {
  const ct = headers['content-type'] || '';
  if (/charset=(gbk|gb2312)/i.test(ct)) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      /* noop */
    }
  }
  return buf.toString('utf8');
}

function parseJsonList(text) {
  let j;
  try {
    j = JSON.parse(text.trim());
  } catch {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    j = s >= 0 ? JSON.parse(text.slice(s, e + 1)) : { list: [] };
  }
  const list = j.list || j.data || [];
  return (Array.isArray(list) ? list : []).map(normalizeItem).filter((x) => x.name);
}

function parseClasses(text) {
  try {
    const j = JSON.parse(text.trim());
    return (j.class || []).map((c) => ({ id: String(c.type_id), name: c.type_name }));
  } catch {
    return [];
  }
}

function normalizeItem(v) {
  const name = v.vod_name || v.name || v.title || '';
  return {
    id: String(v.vod_id ?? v.id ?? ''),
    name: String(name).trim(),
    pic: v.vod_pic || v.pic || v.vod_pic_slide || '',
    remarks: v.vod_remarks || v.note || '',
    year: String(v.vod_year || v.year || ''),
    area: v.vod_area || '',
    typeName: v.vod_class || v.type_name || '',
    actor: v.vod_actor || '',
    director: v.vod_director || '',
    score: v.vod_score ? String(v.vod_score) : '',
    content: stripTags(v.vod_content || v.vod_blurb || v.des || ''),
    playFrom: v.vod_play_from || '',
    playUrl: v.vod_play_url || '',
  };
}

/** macCMS XML 版：<video><id>..</id><name>..</name><dl><dd flag="x">名$地址#...</dd></dl></video> */
function parseXmlList(text) {
  const out = [];
  const videoRe = /<video>([\s\S]*?)<\/video>/gi;
  let m;
  while ((m = videoRe.exec(text))) {
    const body = m[1];
    const get = (tag) => {
      const mm = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return mm ? cdata(mm[1]).trim() : '';
    };
    const dds = [...body.matchAll(/<dd[^>]*flag="([^"]*)"[^>]*>([\s\S]*?)<\/dd>/gi)].map((d) => ({
      flag: d[1],
      url: cdata(d[2]).trim(),
    }));
    out.push(
      normalizeItem({
        vod_id: get('id'),
        vod_name: get('name'),
        vod_pic: get('pic'),
        vod_remarks: get('note') || get('remarks'),
        vod_year: get('year'),
        vod_area: get('area'),
        vod_class: get('type'),
        vod_actor: get('actor'),
        vod_director: get('director'),
        vod_content: get('des'),
        vod_play_from: dds.map((d) => d.flag).join('$$$'),
        vod_play_url: dds.map((d) => d.url).join('$$$'),
      }),
    );
  }
  return out;
}

const cdata = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '');
const stripTags = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** "from1$$$from2" + "url1$$$url2" → [{flag, episodes:[{name,url}]}] */
export function buildRoutes(playFrom, playUrl) {
  if (!playUrl) return [];
  const flags = String(playFrom).split('$$$');
  const groups = String(playUrl).split('$$$');
  return groups.map((group, gi) => {
    const episodes = group
      .split('#')
      .map((seg, idx) => {
        const i = seg.indexOf('$');
        const name = i > 0 ? seg.slice(0, i) : `第${idx + 1}集`;
        const url = i > 0 ? seg.slice(i + 1) : seg;
        return url ? { name: name.trim(), url: url.trim() } : null;
      })
      .filter(Boolean);
    return { flag: flags[gi] || `线路${gi + 1}`, label: prettyFlag(flags[gi]), episodes };
  }).filter((r) => r.episodes.length);
}

function prettyFlag(flag = '') {
  const f = String(flag).toLowerCase();
  if (f.includes('m3u8')) return 'HLS';
  if (f.includes('mp4')) return 'MP4';
  return String(flag || '默认');
}

/** 判断地址是否需要"解析"（TVBox 的 parses 环节）或在浏览器可直接播 */
export function resolvePlayUrl(rawUrl, site) {
  let url = String(rawUrl || '').trim();
  // 有些源用 "线路名$地址" 的二次包裹 / 前置标记
  url = url.replace(/^(push|jjk|parse):\/\//i, (m) => (m.toLowerCase().startsWith('jjk') ? '' : m));
  const clean = url.split('|')[0];
  const headers = {};
  const pipe = url.split('|');
  if (pipe[1]) {
    for (const kv of pipe.slice(1)) {
      const [k, v] = kv.split('=');
      if (k && v) headers[k.trim()] = v.trim();
    }
  }
  const lower = clean.toLowerCase();
  const isDirect =
    /\.(m3u8|mp4|flv|mkv|ts|mp3|m4a)(\?|$)/.test(lower) ||
    lower.includes('m3u8') ||
    lower.startsWith('rtmp') ||
    lower.startsWith('rtsp');
  const type = /\.m3u8|m3u8/.test(lower) ? 'hls' : /\.flv/.test(lower) ? 'flv' : /\.(mp3|m4a)/.test(lower) ? 'audio' : 'mp4';
  return {
    url: clean,
    type: isDirect ? type : 'unknown',
    headers,
    needParse: !isDirect,
    message: isDirect ? undefined : '该地址不是直链，需要配置解析接口（TVBox parses）才能播放',
    referer: headers.Referer || headers.referer || site?.ext?.referer || undefined,
  };
}
