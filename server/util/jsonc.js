// JSONC 解析：TVBox 配置文件里带 // 注释、尾逗号，标准 JSON.parse 会失败
export function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // 去掉尾逗号
  return out.replace(/,\s*([}\]])/g, '$1');
}

export function parseJsonc(text) {
  const clean = stripJsonc(text).replace(/^\uFEFF/, '').trim();
  return JSON.parse(clean);
}
