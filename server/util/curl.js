/**
 * fetch 的兜底实现：直连失败时改用 curl 重试
 *
 * 为什么要这一层：
 *   - Node 内置的 fetch（undici）**不读** HTTP_PROXY / HTTPS_PROXY 环境变量，
 *     而 curl 读。NAS 上很多源必须走代理才通，只靠 fetch 会直接 "fetch failed"。
 *   - 但代理本身也可能是坏的/只对部分域名有效，所以策略是「先直连，失败再走 curl」，
 *     而不是一上来就全量走代理。
 *
 * 返回结构与 Response 对齐（status / ok / headers.get / arrayBuffer / text），
 * 调用方不用关心底层是谁。
 */
import { execFile, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

let curlChecked = null;

/** curl 是否存在（只查一次） */
export function hasCurl() {
  if (curlChecked !== null) return curlChecked;
  try {
    const r = spawnSync('curl', ['--version'], { timeout: 3000 });
    curlChecked = r.status === 0;
  } catch {
    curlChecked = false;
  }
  return curlChecked;
}

function proxyEnv() {
  const e = process.env;
  return e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy || e.ALL_PROXY || e.all_proxy || '';
}

function noProxyMatch(url) {
  const no = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!no) return false;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return no
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => rule === '*' || host === rule || host.endsWith(rule.startsWith('.') ? rule : '.' + rule));
}

function wrapFetch(res) {
  return {
    status: res.status,
    ok: res.ok,
    url: res.url,
    via: 'fetch',
    rawHeaders: Object.fromEntries(res.headers.entries()),
    headers: { get: (k) => res.headers.get(k) },
    arrayBuffer: () => res.arrayBuffer(),
    text: () => res.text(),
  };
}

function wrapCurl(r) {
  const map = new Map(Object.entries(r.headers || {}));
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 400,
    url: r.url,
    via: 'curl',
    rawHeaders: r.headers || {},
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    arrayBuffer: async () => r.buffer,
    text: async () => r.buffer.toString('utf8'),
  };
}

/** 用 curl 发一次请求，返回 {status, headers, buffer, url} */
export async function curlRequest(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 30000,
    redirect = 'follow',
    range,
    ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  } = opts;

  const id = crypto.randomBytes(6).toString('hex');
  const tmp = os.tmpdir();
  const hdrFile = path.join(tmp, `nova-h-${id}.txt`);
  const bodyFile = path.join(tmp, `nova-b-${id}.bin`);
  const uploadFile = path.join(tmp, `nova-u-${id}.bin`);

  const args = [
    '-sS',
    '--compressed',
    '--max-time',
    String(Math.max(1, Math.ceil(timeout / 1000))),
    '-A',
    ua,
    '-D',
    hdrFile,
    '-o',
    bodyFile,
  ];
  if (redirect === 'follow') args.push('-L');
  if (redirect === 'manual') args.push('--max-redirs', '0');
  if (range) args.push('-H', `Range: ${range}`);
  if (noProxyMatch(url) || !proxyEnv()) args.push('--noproxy', '*');
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    args.push('-H', `${k}: ${v}`);
  }
  if (method !== 'GET') args.push('-X', method);
  if (body !== undefined && body !== null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    await fs.writeFile(uploadFile, buf);
    args.push('--data-binary', `@${uploadFile}`);
  }
  args.push(url);

  try {
    await new Promise((resolve, reject) => {
      execFile('curl', args, { timeout: timeout + 5000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 200)));
        else resolve();
      });
    });

    // -L 时会留下多段响应头，只取最后一段
    const rawHdr = await fs.readFile(hdrFile, 'utf8').catch(() => '');
    const blocks = rawHdr.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
    const last = blocks.length ? blocks[blocks.length - 1] : '';
    const lines = last.split(/\r?\n/).filter(Boolean);
    const status = Number((lines[0] || '').split(' ')[1] || 0);
    const h = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const buffer = await fs.readFile(bodyFile).catch(() => Buffer.alloc(0));
    return { status, headers: h, buffer, url };
  } finally {
    for (const f of [hdrFile, bodyFile, uploadFile]) fs.rm(f, { force: true }).catch(() => {});
  }
}

/**
 * 直连优先、失败回落 curl 的统一请求入口
 * @param {string} url
 * @param {object} opts 传给 fetch 的同名字段 + { timeout, range }
 */
export async function fetchx(url, opts = {}) {
  const { timeout = 30000, ...rest } = opts;
  const fetchOpts = { ...rest, signal: AbortSignal.timeout(timeout) };

  // 没配代理时，curl 和 fetch 走的是同一条路，直连失败也基本救不回来；
  // 但仍有意义（curl 的 TLS/证书处理更宽容），所以照样兜底。
  try {
    const res = await fetch(url, fetchOpts);
    return wrapFetch(res);
  } catch (e) {
    if (!hasCurl()) throw e;
    const r = await curlRequest(url, { ...rest, timeout });
    // curl 也没拿到状态码 → 原始错误更有信息量
    if (!r.status) throw e;
    return wrapCurl(r);
  }
}
