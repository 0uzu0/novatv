/**
 * 同步 HTTP（curl 后端）
 *
 * 为什么必须同步：TVBox 的 js spider（drpy2）里 `request()` 是这样写的
 *   let res = req(url, obj); let html = res.content;
 * 它假定宿主 `req` 是阻塞调用（QuickJS 里是 JNI 直调）。Node 的 fetch 是异步的，
 * 没法塞进这个调用栈。所以这里用 child_process 同步调 curl —— 语义与 TVBox 一致，
 * 同时顺手解决 GBK 解码、Cookie、重定向、二进制。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP = path.join(os.tmpdir(), 'novatv-jshost');
fs.mkdirSync(TMP, { recursive: true });

const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function tmpFile(ext = '') {
  return path.join(TMP, crypto.randomBytes(8).toString('hex') + ext);
}

function parseHeaderDump(text) {
  // -L 会产生多个响应头块，取最后一个
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
  const block = blocks.length ? blocks[blocks.length - 1] : text;
  const lines = block.split(/\r?\n/);
  const status = Number((lines[0] || '').match(/\s(\d{3})\s?/)?.[1] || 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  return { status, headers };
}

function decodeBody(buf, headers) {
  let label = (headers['content-type'] || '').match(/charset=([\w-]+)/i)?.[1];
  if (!label) {
    const head = buf.slice(0, 2048).toString('latin1');
    label = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  label = (label || 'utf-8').toLowerCase();
  if (/^(gb2312|gbk|gb18030)$/.test(label)) label = 'gb18030';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * @param {string} url
 * @param {object|string} opt  {method, headers, body, timeout, redirect, buffer, cookieJar}
 */
export function reqSync(url, opt = {}) {
  if (!url) return { content: '', headers: {}, status: 0 };
  if (typeof opt === 'string') {
    try {
      opt = { headers: JSON.parse(opt) };
    } catch {
      opt = {};
    }
  }
  if (!opt || typeof opt !== 'object') opt = {};

  const method = String(opt.method || 'GET').toUpperCase();
  const headers = { ...(opt.headers || {}) };
  const bodyFile = tmpFile('.body');
  const headFile = tmpFile('.head');
  const outFile = tmpFile('.out');

  const args = [
    '-sS',
    '-k',
    '--compressed',
    '--max-time',
    String(Math.max(1, Math.ceil((opt.timeout || 15000) / 1000))),
    '-A',
    String(headers['User-Agent'] || headers['user-agent'] || UA_DEFAULT),
    '-D',
    headFile,
    '-o',
    outFile,
  ];
  if (opt.redirect !== 0 && opt.redirect !== false) args.push('-L');
  if (opt.cookieJar) args.push('-c', opt.cookieJar, '-b', opt.cookieJar);
  if (method !== 'GET') args.push('-X', method);
  for (const [k, v] of Object.entries(headers)) {
    if (/^user-agent$/i.test(k) || v === undefined || v === null) continue;
    args.push('-H', `${k}: ${v}`);
  }
  if (opt.body != null && method !== 'GET') {
    fs.writeFileSync(bodyFile, typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body));
    args.push('--data-binary', '@' + bodyFile);
  }
  args.push(url);

  let ok = true;
  let errMsg = '';
  try {
    execFileSync('curl', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: (opt.timeout || 15000) + 5000 });
  } catch (e) {
    ok = false;
    errMsg = String(e.stderr || e.message || '').slice(0, 200);
  }

  let buf = Buffer.alloc(0);
  try {
    buf = fs.readFileSync(outFile);
  } catch {
    /* 请求失败时没有输出 */
  }
  const headText = (() => {
    try {
      return fs.readFileSync(headFile, 'utf8');
    } catch {
      return '';
    }
  })();
  for (const f of [bodyFile, headFile, outFile]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }

  const { status, headers: resHeaders } = parseHeaderDump(headText);
  if (!ok && !status) {
    return { content: '', headers: resHeaders, status: 0, error: errMsg || 'request failed' };
  }
  if (opt.buffer || opt.toBase64) {
    return { content: opt.toBase64 ? buf.toString('base64') : buf, headers: resHeaders, status };
  }
  return { content: decodeBody(buf, resHeaders), headers: resHeaders, status };
}

/** base64 图片直读（data: URI 场景用不到，但 spider 里偶见） */
export function fetchBinarySync(url, opt = {}) {
  return reqSync(url, { ...opt, buffer: true });
}
