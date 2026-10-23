#!/usr/bin/env node
/**
 * 无头截图（含播放器）：
 * 通过 Chrome DevTools Protocol 打开页面、执行交互，再截图。
 * 用法: node scripts/shot.mjs <url> <out.png> [js表达式] [等待ms]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, out, expr = '', waitMs = '4000'] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法: node scripts/shot.mjs <url> <out.png> [js] [waitMs]');
  process.exit(1);
}

const port = 9333;
const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  `--remote-debugging-port=${port}`,
  '--window-size=1600,1000',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/novatv-shot-profile',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 未能启动');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));

const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (args) console.log('  [console]', args);
  }
  if (m.method === 'Log.entryAdded') console.log('  [log]', m.params.entry.level, m.params.entry.text);
});
await send('Page.navigate', { url });
await sleep(Number(waitMs));
if (expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, userGesture: true, returnByValue: true });
  if (r?.exceptionDetails) console.error('JS 异常:', r.exceptionDetails.text);
  if (r?.result?.value !== undefined) console.log('  [eval]', JSON.stringify(r.result.value).slice(0, 800));
  await sleep(5000);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
console.log('已保存', out);
ws.close();
child.kill();
process.exit(0);
