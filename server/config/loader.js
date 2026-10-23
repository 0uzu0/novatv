import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { http } from '../util/http.js';
import { parseJsonc, stripJsonc } from '../util/jsonc.js';
import { listZipEntries, classifySpider } from '../util/zipinfo.js';
import { ossFor } from './oss-spiders.js';

const CACHE_FILE = path.join(process.cwd(), 'data', 'config-cache.json');
const SNAPSHOT_SCHEMA = 4; // 归类/支持集逻辑变化时 +1，自动失效旧快照（4: 接入开源替代映射）

/**
 * 饭太硬这类"藏图接口"的通用解码器。
 * 已知形态：HTTP 返回 application/zip 或 image/*，实际是 图片(或伪装图片) + 尾部 base64(JSONC)。
 * 策略链：原文 JSONC → JPEG EOI 之后取尾 → 纯 base64 → hex → 末尾 8 字符盐剥离。
 */
export function decodeConfigPayload(buf) {
  const head = buf.slice(0, 4).toString('latin1');
  const text = buf.toString('utf8').trim();

  // 1) 直接是 JSON / JSONC
  if (text.startsWith('{')) {
    return { config: parseJsonc(text), carrier: 'plain-json' };
  }

  // 2) 图片 + 尾部载荷：定位最后一个 JPEG EOI(FFD9)
  let tailStart = -1;
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
      tailStart = i + 2;
      break;
    }
  }
  if (tailStart > 0 && tailStart < buf.length) {
    const carrierKind = head.startsWith('\xff\xd8') ? 'jpeg+base64' : 'bin+base64';
    const parsed = tryBase64Tail(buf.slice(tailStart));
    if (parsed) return { config: parsed, carrier: carrierKind, payloadOffset: tailStart };
  }

  // 3) 整体就是 base64（有些站点直接吐 base64 文本）
  const whole = tryBase64Tail(buf);
  if (whole) return { config: whole, carrier: 'base64-text' };

  throw new Error(`无法识别的配置载体（head=${head.replace(/[^\x20-\x7e]/g, '.')}）`);
}

function tryBase64Tail(tail) {
  const s = tail.toString('latin1');
  // 载荷前通常有 2~16 字节盐/标记（饭太硬当前为 8 字节 "CCtSiKQ*"）
  for (let salt = 0; salt <= 16; salt++) {
    const body = s.slice(salt);
    const idx = body.search(/[A-Za-z0-9+/=]/);
    if (idx < 0) continue;
    const b64 = body.slice(idx).replace(/[^A-Za-z0-9+/=]/g, '');
    if (b64.length < 64 || b64.length % 4 !== 0) continue;
    let decoded;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      continue;
    }
    const brace = decoded.indexOf('{');
    if (brace < 0) continue;
    const jsonText = decoded.slice(brace);
    try {
      const parsed = parseJsonc(jsonText);
      if (parsed && typeof parsed === 'object' && (parsed.sites || parsed.lives || parsed.spider)) {
        return parsed;
      }
    } catch {
      /* 继续尝试下一个盐值 */
    }
  }
  return null;
}

/** 站点运行时判定：TVBox 的 type 语义 + api 形态 */
export function classifySite(site) {
  const api = String(site.api || '');
  const type = Number(site.type ?? 3);
  if (/^csp_/i.test(api)) return { runtime: 'jar-spider', reason: '调用 spider jar 中的 csp_* 类（Android 加固包，需 Android 侧车）' };
  if (/\.(js|mjs)(\?|$)/i.test(api)) return { runtime: 'js-spider', reason: 'drpy/hipy 系 JS 源，由内置 Node JS 运行时（drpy2 兼容层）执行' };
  if (type === 4) return { runtime: 'remote-spider', reason: '远程 spider 服务' };
  if (api.startsWith('http')) {
    if (type === 0 || /\.xml(\?|$)/i.test(api) || /\/xml\//i.test(api)) return { runtime: 'cms-xml', reason: 'type=0 XML 采集接口' };
    return { runtime: 'cms-json', reason: 'type=1 JSON 采集接口' };
  }
  if (type === 3) return { runtime: 'jar-spider', reason: 'type=3 需要 jar spider' };
  return { runtime: 'unknown', reason: '无法识别的站点类型' };
}

// 能直接在服务端跑的运行时：
//   cms-*    → 纯 HTTP 采集，原生支持
//   js-spider → 内置 Node JS 运行时（drpy2 兼容层）
//   jar-spider → 只有配置了侧车地址才算可用（Android 容器或 JVM 侧车）
const BRIDGE = process.env.SPIDER_BRIDGE_URL || process.env.SPIDER_JVM_URL || process.env.SPIDER_ANDROID_URL || '';
const SUPPORTED = new Set(['cms-json', 'cms-xml', 'js-spider']);
if (BRIDGE) SUPPORTED.add('jar-spider');

export class ConfigStore {
  constructor({ url, ttl = 30 * 60 * 1000 } = {}) {
    this.url = url || process.env.CONFIG_URL || 'http://www.饭太硬.cc/tv';
    this.ttl = ttl;
    this.cache = null;
    this.loading = null;
    this.spiderInfo = null;
  }

  async get({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < this.ttl) return this.cache;
    if (this.loading) return this.loading;
    this.loading = this.#load(force).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async #load(force) {
    if (!force) {
      const disk = await this.#readDisk();
      if (disk && Date.now() - disk.fetchedAt < this.ttl) {
        this.cache = disk;
        return disk;
      }
    }
    const started = Date.now();
    const res = await http.raw(this.url, {
      ua: 'okhttp/3.15',
      timeout: 20000,
      retry: 2,
      headers: { Accept: '*/*' },
    });
    const { config, carrier, payloadOffset } = decodeConfigPayload(res.buffer);
    // 可选：聚合额外配置（CONFIG_URLS=a,b），主配置的 spider 源跑不动时用它补充同内容的 CMS 源
    const extras = String(process.env.CONFIG_URLS || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const merged = [...(config.sites || [])];
    const extraLog = [];
    for (const u of extras) {
      try {
        const r = await http.raw(u, { ua: 'okhttp/3.15', timeout: 15000, retry: 1, headers: { Accept: '*/*' } });
        const d = decodeConfigPayload(r.buffer);
        const keys = new Set(merged.map((x) => x.key));
        for (const site of d.config.sites || []) {
          const key = keys.has(site.key) ? `${site.key}@${new URL(u).host}` : site.key;
          keys.add(key);
          merged.push({ ...site, key, __from: u });
        }
        extraLog.push({ url: u, ok: true, sites: (d.config.sites || []).length });
      } catch (e) {
        extraLog.push({ url: u, ok: false, error: e.message });
      }
    }
    const sites = merged.map((s) => {
      const cls = classifySite(s);
      // 加固源若有开源同名实现（oss-spiders.jar），改走 JVM 侧车 —— 这是纯增益：
      // 原路径必须 Android，替换后纯服务端可跑。详见 server/config/oss-spiders.js
      const oss = cls.runtime === 'jar-spider' ? ossFor(s.api) : null;
      const runtime = oss ? 'jar-spider' : cls.runtime;
      return {
        ...s,
        ...(oss ? { api: oss.api, spiderJar: oss.spiderJar, ossCls: oss.cls } : {}),
        runtime,
        runtimeReason: oss
          ? `开源实现（${oss.cls}，FongMi/CatVodSpider），由 JVM 侧车执行`
          : cls.reason,
        supported: SUPPORTED.has(runtime),
      };
    });
    const snapshot = {
      schema: SNAPSHOT_SCHEMA,
      fetchedAt: Date.now(),
      tookMs: Date.now() - started,
      source: this.url,
      http: { status: res.status, contentType: res.headers['content-type'], bytes: res.buffer.length },
      carrier,
      payloadOffset: payloadOffset ?? null,
      spider: config.spider || null,
      wallpaper: config.wallpaper || '',
      logo: config.logo || '',
      hosts: config.hosts || [],
      flags: config.flags || {},
      parses: config.parses || [],
      sites,
      lives: (config.lives || []).map((l, i) => ({ ...l, index: i })),
      raw: config,
      stats: summarize(sites),
      extraConfigs: extraLog,
    };
    this.cache = snapshot;
    await this.#writeDisk(snapshot);
    return snapshot;
  }

  async #readDisk() {
    try {
      const txt = await fs.readFile(CACHE_FILE, 'utf8');
      const data = JSON.parse(txt);
      if (!data?.sites) return null;
      if (data.schema !== SNAPSHOT_SCHEMA) return null;
      return data;
    } catch {
      return null;
    }
  }

  async #writeDisk(snapshot) {
    try {
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      const { raw, ...persisted } = snapshot;
      await fs.writeFile(CACHE_FILE, JSON.stringify(persisted));
    } catch {
      /* 缓存写失败不影响主流程 */
    }
  }

  /** 下载 spider 包并"验尸"：普通 jar 还是 Android 加固包 */
  async inspectSpider({ force = false } = {}) {
    if (!force && this.spiderInfo) return this.spiderInfo;
    const cfg = await this.get();
    const spider = cfg.spider;
    if (!spider) return (this.spiderInfo = { kind: 'none', reason: '配置未声明 spider' });

    const [urlPart, hashPart, expectMd5] = String(spider).split(';');
    const started = Date.now();
    try {
      const buf = await http.buffer(urlPart, { ua: 'okhttp/3.15', timeout: 30000, retry: 1 });
      const md5 = crypto.createHash('md5').update(buf).digest('hex');
      const entries = listZipEntries(buf);
      const cls = classifySpider(entries);
      this.spiderInfo = {
        url: urlPart,
        bytes: buf.length,
        md5,
        expectMd5: expectMd5 || null,
        md5Ok: expectMd5 ? md5 === expectMd5.trim().toLowerCase() : null,
        hashTag: hashPart || null,
        entries,
        ...cls,
        tookMs: Date.now() - started,
        runnable: cls.kind === 'jvm-jar',
        verdict:
          cls.kind === 'android-hardened'
            ? 'Android 加固 spider：classes.dex + 原生 .so + 加密 guard 资源，服务端无法在标准 JVM/Node 中加载'
            : cls.kind === 'jvm-jar'
              ? '标准 JVM jar：可桥接 JVM 侧车运行'
              : '未知包结构',
      };
    } catch (e) {
      this.spiderInfo = { url: urlPart, error: e.message, kind: 'unreachable' };
    }
    return this.spiderInfo;
  }
}

function summarize(sites) {
  const byRuntime = {};
  for (const s of sites) byRuntime[s.runtime] = (byRuntime[s.runtime] || 0) + 1;
  return {
    total: sites.length,
    supported: sites.filter((s) => s.supported).length,
    byRuntime,
    searchable: sites.filter((s) => Number(s.searchable) === 1).length,
  };
}

export { stripJsonc };
