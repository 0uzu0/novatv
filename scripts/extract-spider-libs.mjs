#!/usr/bin/env node
/**
 * 从 TVBox 加固 spider 包里抽出 native 库，落到 Host APK 的 jniLibs 目录。
 *
 * 为什么必须这么做：
 *   加固壳（如 ftyguard / wexguard）在运行时用 System.loadLibrary("ftyguard_v8")
 *   去找 libftyguard_v8.so —— 搜索路径是 APK 的 lib/<abi>/，不是 jar 里的 assets/。
 *   jar 内的 assets/*.so 永远不会被 DexClassLoader 解压到可加载位置。
 *   所以必须在打包 APK 之前，把 .so 从包里取出来、按 ABI 改名放好。
 *
 * ABI 判定不靠文件名，直接读 ELF header 的 e_machine（文件名可能是 v7/v8 之类
 * 厂商自定义后缀，不可靠）。
 *
 * 用法：
 *   node scripts/extract-spider-libs.mjs --url "https://.../xx.jpg" --md5 "abc..."
 *   node scripts/extract-spider-libs.mjs --file /tmp/spider.bin
 *   node scripts/extract-spider-libs.mjs --config "http://www.饭太硬.cc/tv"   # 自动从配置里取 spider
 *
 * 输出：
 *   sidecar/android/host-apk/app/src/main/jniLibs/arm64-v8a/libftyguard_v8.so
 *   sidecar/android/host-apk/app/src/main/jniLibs/armeabi-v7a/libftyguard_v7.so
 *   + libs-manifest.json（记录来源 md5、条目、ABI，供 CI 与排查用）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listZipEntries } from '../server/util/zipinfo.js';
import { decodeConfigPayload } from '../server/config/loader.js';
import { fetchx } from '../server/util/curl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JNI_DIR = path.join(ROOT, 'sidecar', 'android', 'host-apk', 'app', 'src', 'main', 'jniLibs');

const EM = {
  0x03: 'x86',
  0x06: 'x86',
  0x28: 'armeabi-v7a',
  0x3e: 'x86_64',
  0xb7: 'arm64-v8a',
  0x08: 'mips',
  0xf3: 'riscv64',
};

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** 读 ELF header 的 e_machine → Android ABI 名 */
function abiOf(buf) {
  if (buf.length < 20) return null;
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return null;
  const machine = buf.readUInt16LE(18);
  const bits = buf[4] === 2 ? 64 : 32;
  return { abi: EM[machine] || `unknown(0x${machine.toString(16)})`, bits, machine };
}

/** 用极简 ZIP 读取器取单个条目内容（只支持 stored/deflate） */
async function readZipEntry(buf, want) {
  const zlib = await import('node:zlib');
  // 复用中央目录解析：拿到偏移量需要额外读 local header，这里单独实现
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法 zip');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === want) {
      // local header 长度可变，必须重读
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 内找不到 ${want}`);
}

async function resolveSpiderSource() {
  const file = arg('file');
  if (file) return { buf: await fs.readFile(file), from: file, md5: '' };

  let url = arg('url');
  let md5 = arg('md5');

  if (!url) {
    const cfgUrl = arg('config', process.env.CONFIG_URL || '');
    if (!cfgUrl) {
      throw new Error('必须提供 --file / --url 或 --config');
    }
    console.log(`[1/4] 读取配置 ${cfgUrl}`);
    const res = await fetchx(cfgUrl, { headers: { 'User-Agent': 'okhttp/3.15', Accept: '*/*' }, timeout: 25000 });
    const cfgBuf = Buffer.from(await res.arrayBuffer());
    const { config, carrier } = decodeConfigPayload(cfgBuf);
    console.log(`      载体=${carrier}  spider=${config.spider || '(无)'}`);
    if (!config.spider) throw new Error('配置里没有声明 spider');
    const [u, h] = String(config.spider).split(';md5;');
    url = u.trim();
    md5 = (h || '').trim();
  }

  console.log(`[1/4] 下载 spider 包 ${url}`);
  const res = await fetchx(url, { headers: { 'User-Agent': 'okhttp/3.15', Accept: '*/*' }, timeout: 60000 });
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, from: url, md5 };
}

async function main() {
  const { buf, from, md5 } = await resolveSpiderSource();
  const actual = crypto.createHash('md5').update(buf).digest('hex');
  console.log(`[2/4] 包大小 ${buf.length} B  md5=${actual}`);
  if (md5 && md5.toLowerCase() !== actual) {
    throw new Error(`MD5 不匹配：期望 ${md5}，实际 ${actual}`);
  }

  const entries = listZipEntries(buf);
  const soNames = entries.map((e) => e.name).filter((n) => /\.so$/i.test(n));
  console.log(`[3/4] zip 条目 ${entries.length} 个，native 库 ${soNames.length} 个`);
  if (!soNames.length) {
    throw new Error('包内没有 .so —— 这个包不是加固包，请直接用 JVM 侧车（sidecar/jvm）');
  }

  await fs.rm(JNI_DIR, { recursive: true, force: true });
  const manifest = { from, md5: actual, bytes: buf.length, extractedAt: new Date().toISOString(), libs: [] };

  for (const name of soNames) {
    const data = await readZipEntry(buf, name);
    const info = abiOf(data);
    if (!info) {
      console.warn(`      ! ${name} 不是 ELF，跳过`);
      continue;
    }
    // 壳用 System.loadLibrary("<bname>")，所以文件名必须是 lib<bname>.so
    const base = path.basename(name).replace(/\.so$/i, '');
    const outName = base.startsWith('lib') ? `${base}.so` : `lib${base}.so`;
    const dir = path.join(JNI_DIR, info.abi);
    await fs.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, outName);
    await fs.writeFile(outPath, data);
    manifest.libs.push({
      entry: name,
      abi: info.abi,
      bits: info.bits,
      bytes: data.length,
      out: path.relative(ROOT, outPath).replace(/\\/g, '/'),
    });
    console.log(`      ✓ ${name} → ${info.abi}/${outName} (${data.length} B)`);
  }

  const abis = [...new Set(manifest.libs.map((l) => l.abi))];
  manifest.abis = abis;
  await fs.writeFile(path.join(JNI_DIR, 'libs-manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`[4/4] 完成，ABI = ${abis.join(', ')}`);
  console.log(`      jniLibs → ${path.relative(ROOT, JNI_DIR)}`);
  if (!abis.some((a) => a.startsWith('arm'))) {
    console.warn('      ! 没有 ARM 库，Host APK 在 x86 模拟器上会因为 ABI 不匹配装不上');
  }
  if (!abis.includes('x86_64') && process.env.NOVATV_REQUIRE_X86 === '1') {
    throw new Error('要求 x86_64 库但包内没有 —— 无法在 x86_64 redroid 上原生运行');
  }
}

main().catch((e) => {
  console.error('\n[失败]', e.message);
  process.exit(1);
});
