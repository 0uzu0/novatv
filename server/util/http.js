// 统一 HTTP 客户端：UA 伪装、超时、重试、Referer、TVBox hosts 域名重写
import { fetchx } from './curl.js';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** TVBox config.hosts: ["a.com=b.com"] 形式的主机替换表 */
export function buildHostMap(hosts) {
  const map = new Map();
  for (const line of hosts || []) {
    if (typeof line !== 'string') continue;
    const [from, to] = line.split('=').map((s) => s && s.trim());
    if (from && to && !to.startsWith('ip')) map.set(from.toLowerCase(), to);
  }
  return map;
}

export class HttpClient {
  constructor({ timeout = 12000, retry = 1, hostMap = new Map() } = {}) {
    this.timeout = timeout;
    this.retry = retry;
    this.hostMap = hostMap;
  }

  withHosts(hosts) {
    return new HttpClient({ timeout: this.timeout, retry: this.retry, hostMap: buildHostMap(hosts) });
  }

  async raw(url, opts = {}) {
    const {
      method = 'GET',
      headers = {},
      body,
      timeout = this.timeout,
      retry = this.retry,
      referer,
      ua = DEFAULT_UA,
      redirect = 'follow',
    } = opts;

    let target = url;
    let hostOverride = null;
    try {
      const u = new URL(url);
      const mapped = this.hostMap.get(u.hostname.toLowerCase());
      if (mapped) {
        hostOverride = u.hostname;
        u.hostname = mapped;
        target = u.toString();
      }
    } catch {
      throw new Error(`非法 URL: ${url}`);
    }

    const h = {
      'User-Agent': ua,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    };
    if (referer) h.Referer = referer;
    if (hostOverride) h.Host = hostOverride;

    let lastErr;
    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        // fetchx 内部：直连失败自动用 curl 重试（curl 读 HTTPS_PROXY）
        const res = await fetchx(target, { method, headers: h, body, redirect, timeout });
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          status: res.status,
          ok: res.ok,
          headers: res.rawHeaders || {},
          buffer: buf,
          url: res.url || target,
        };
      } catch (e) {
        lastErr = e;
        if (attempt === retry) break;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw new Error(`${lastErr?.name === 'AbortError' ? '请求超时' : '请求失败'}: ${url}`);
  }

  async text(url, opts = {}) {
    const charset = opts.charset;
    const res = await this.raw(url, opts);
    if (charset === 'gbk' || charset === 'gb2312') {
      try {
        return new TextDecoder('gbk').decode(res.buffer);
      } catch {
        /* 忽略：部分运行时不支持 gbk */
      }
    }
    const ct = res.headers['content-type'] || '';
    if (/charset=(gbk|gb2312)/i.test(ct)) {
      try {
        return new TextDecoder('gbk').decode(res.buffer);
      } catch {
        /* noop */
      }
    }
    return res.buffer.toString('utf8');
  }

  async json(url, opts = {}) {
    const txt = await this.text(url, opts);
    const trimmed = txt.trim().replace(/^\uFEFF/, '');
    try {
      return JSON.parse(trimmed);
    } catch {
      // 有些接口返回 JSONP 或带前缀，做一次宽松提取
      const s = trimmed.indexOf('{');
      const e = trimmed.lastIndexOf('}');
      if (s >= 0 && e > s) return JSON.parse(trimmed.slice(s, e + 1));
      throw new Error(`响应不是 JSON: ${trimmed.slice(0, 120)}`);
    }
  }

  async buffer(url, opts = {}) {
    return (await this.raw(url, opts)).buffer;
  }
}

export const http = new HttpClient();
