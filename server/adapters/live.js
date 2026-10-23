import { http } from '../util/http.js';

/**
 * 直播源适配器：TVBox lives 里的 m3u / txt(组播文本) 播放列表。
 * 支持 #EXTINF 属性：tvg-name / tvg-logo / group-title
 */
export class LiveAdapter {
  constructor(entry, ctx) {
    this.entry = entry;
    this.client = ctx.client || http;
    this.cacheKey = `live:${entry.name}:${entry.url}`;
  }

  async load() {
    const cached = this.client.__liveCache?.get(this.cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;

    const ua = this.entry.ua || 'okhttp/3.15';
    const res = await http.raw(this.entry.url, { ua, timeout: 20000, retry: 1 });
    const text = res.buffer.toString('utf8');
    const channels = text.includes('#EXTM3U') || text.includes('#EXTINF') ? parseM3u(text) : parseTxt(text);
    const value = {
      name: this.entry.name,
      url: this.entry.url,
      count: channels.length,
      groups: groupChannels(channels),
      http: res.status,
      bytes: res.buffer.length,
      fetchedAt: Date.now(),
    };
    if (!this.client.__liveCache) this.client.__liveCache = new Map();
    this.client.__liveCache.set(this.cacheKey, { at: Date.now(), value });
    return value;
  }
}

export function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let pending = null;
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(l))) attrs[m[1]] = m[2];
      const tail = l.split(',').pop() || '';
      pending = {
        name: (attrs['tvg-name'] || tail || '未命名').trim(),
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '未分组',
      };
      continue;
    }
    if (l.startsWith('#')) continue;
    if (pending) {
      out.push({ ...pending, url: l });
      pending = null;
    } else if (/^(https?|rtmp|rtsp|mms):\/\//i.test(l)) {
      out.push({ name: l.split('/').pop() || l, logo: '', group: '未分组', url: l });
    }
  }
  return out;
}

/** txt 直播源格式：分组行 "频道分类,#genre#" 后跟 "频道名,地址" */
export function parseTxt(text) {
  const out = [];
  let group = '未分组';
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    if (l.includes('#genre#')) {
      group = l.split(',')[0] || group;
      continue;
    }
    const seg = l.split(',');
    if (seg.length < 2) continue;
    const url = seg.find((s) => /^(https?|rtmp|rtsp|mms):\/\//i.test(s.trim()));
    if (!url) continue;
    out.push({ name: seg[0].trim(), group, logo: '', url: url.trim() });
  }
  return out;
}

function groupChannels(channels) {
  const map = new Map();
  for (const c of channels) {
    if (!map.has(c.group)) map.set(c.group, []);
    map.get(c.group).push(c);
  }
  return [...map.entries()].map(([name, list]) => ({ name, count: list.length, channels: list }));
}
