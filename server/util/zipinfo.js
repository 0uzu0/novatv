// 极简 ZIP 目录解析：用来"验尸" TVBox spider jar（TVBoxOS 的 jar 即 zip）
// 只读中央目录，不依赖任何第三方库
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

export function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total && ptr + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    entries.push({ name, size, compSize, compression: method });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 判断 spider 包类型：普通 jar（含 .class）/ Android 加固包（dex + so + guard） */
export function classifySpider(entries) {
  const names = entries.map((e) => e.name);
  const dex = names.filter((n) => /\.dex$/i.test(n));
  const native = names.filter((n) => /\.so$/i.test(n));
  const guard = names.filter((n) => /\.(guard|bin|dat|pak)$/i.test(n));
  const classes = names.filter((n) => /\.class$/i.test(n));
  let kind = 'unknown';
  if (dex.length && native.length) kind = 'android-hardened';
  else if (classes.length) kind = 'jvm-jar';
  else if (dex.length) kind = 'android-dex';
  const guardBytes = entries
    .filter((e) => guard.includes(e.name))
    .reduce((s, e) => s + e.size, 0);
  return { kind, dex, native, guard, classes: classes.length, guardBytes };
}
