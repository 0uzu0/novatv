/**
 * 服务端"轻量嗅探"：解决 TVBox 里 parse=1（返回网页地址，靠客户端 WebView 嗅探）的情况
 *
 * 不启动浏览器，只做两件事：抓页面 + 在 HTML/JSON 里找直链。
 * 覆盖常见形态：JSON 转义的 \u002F、反斜杠转义、HLS/FLV/MP4 直链字段。
 * 找不到就如实返回 null，由上层标记"需要解析接口"，不猜。
 */
import { reqSync } from './http-sync.js';

const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36';

const PATTERNS = [
  { type: 'hls', re: /https?:\/\/[^\s"'\\<>]+?\.m3u8[^\s"'\\<>]*/i },
  { type: 'flv', re: /https?:\/\/[^\s"'\\<>]+?\.flv[^\s"'\\<>]*/i },
  { type: 'mp4', re: /https?:\/\/[^\s"'\\<>]+?\.mp4[^\s"'\\<>]*/i },
];

export function sniffStream(pageUrl, { referer = '', timeout = 12000 } = {}) {
  const started = Date.now();
  let res;
  try {
    res = reqSync(pageUrl, {
      timeout,
      headers: { 'User-Agent': UA_MOBILE, ...(referer ? { Referer: referer } : {}) },
    });
  } catch (e) {
    return { ok: false, reason: `抓取失败: ${e.message}`, tookMs: Date.now() - started };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `HTTP ${res.status}`, tookMs: Date.now() - started };
  }
  const raw = String(res.content || '');
  const text = raw.replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    const url = m[0].replace(/&amp;/g, '&');
    return {
      ok: true,
      url,
      type: p.type,
      referer: referer || new URL(pageUrl).origin + '/',
      pageUrl,
      bytes: raw.length,
      tookMs: Date.now() - started,
    };
  }
  return { ok: false, reason: `页面 ${raw.length}B 内未发现直链`, tookMs: Date.now() - started };
}

/** 页面型地址（需要嗅探）vs 直链 */
export function looksLikePage(url) {
  return !/\.(m3u8|mp4|flv|mkv|ts|mp3|m4a)(\?|$)/i.test(String(url || ''));
}
