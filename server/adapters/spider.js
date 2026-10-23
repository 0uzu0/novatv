/**
 * Spider 桥接适配器
 *
 * TVBox 的 type=3 站点由 jar 内的 spider 实现（CatVod Spider 接口）。
 * 服务端复用它的唯一办法是「外部运行时」，这里对接两种侧车：
 *
 *   jvm      → sidecar/jvm（未加固 jar，可加载 com.github.catvod.spider.*）
 *   android  → sidecar/android（加固包，只能在 Android 容器里跑）
 *
 * 协议一致：POST {bridge}/spider {site, method, params} → {ok, data}
 * data 是 spider 的原始返回值（TVBox 形态的 JSON 字符串），这里负责归一化。
 */
import { buildRoutes, resolvePlayUrl } from './cms.js';

/**
 * 候选侧车列表（按优先级）。
 *
 * 判定依据有两个，缺一不可：
 *   1. api 名以 Guard 结尾 —— 绝大多数加固包这么命名（csp_WexxxxGuard）
 *   2. 配置里 spider 包的实测结构（kind=android-hardened）—— 兜住命名不规范的包
 *
 * 顺序很重要：加固包投给 JVM 必然失败，所以 Android 必须排前面。
 * 但同时保留其余候选做兜底——单独一个 SPIDER_JVM_URL 默认值（127.0.0.1:8899）
 * 会让"没起 JVM 侧车"看起来像"配置了 JVM"，不兜底就会一直打空端口。
 */
function pickBridges(site, hardenedPkg = false) {
  const env = process.env;
  const api = String(site?.api || '');
  const hardened = hardenedPkg || /Guard$/i.test(api);

  const android =
    env.SPIDER_ANDROID_URL || (/android/i.test(env.SPIDER_BRIDGE_URL || '') ? env.SPIDER_BRIDGE_URL : '');
  const jvm =
    env.SPIDER_JVM_URL ||
    (env.SPIDER_BRIDGE_URL && !/android/i.test(env.SPIDER_BRIDGE_URL) ? env.SPIDER_BRIDGE_URL : '') ||
    'http://127.0.0.1:8899';
  const generic = env.SPIDER_BRIDGE_URL || '';

  const order = hardened ? [android, jvm, generic] : [jvm, android, generic];
  return [...new Set(order.filter(Boolean).map((u) => u.replace(/\/$/, '')))];
}

/** 只把"连不上"当成可回落的错误；业务错误必须原样抛出，否则会掩盖真实问题 */
function isConnectFailure(e) {
  const msg = String(e?.message || '');
  const code = e?.cause?.code || e?.code || '';
  return (
    /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up|aborted/i.test(msg) ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|UND_ERR/i.test(code)
  );
}

const asObj = (v) => {
  if (!v) return {};
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v;
};

function normalizeItem(v) {
  return {
    id: String(v.vod_id ?? v.id ?? ''),
    name: String(v.vod_name || v.name || '').trim(),
    pic: v.vod_pic || v.pic || '',
    remarks: v.vod_remarks || v.note || '',
    year: String(v.vod_year || ''),
    area: v.vod_area || '',
    typeName: v.vod_class || v.type_name || '',
    actor: v.vod_actor || '',
    director: v.vod_director || '',
    score: v.vod_score ? String(v.vod_score) : '',
    content: String(v.vod_content || v.des || '').replace(/<[^>]+>/g, ' ').trim(),
    playFrom: v.vod_play_from || '',
    playUrl: v.vod_play_url || '',
  };
}

export class SpiderBridgeAdapter {
  constructor(site, ctx) {
    this.site = site;
    this.ctx = ctx;
  }

  get available() {
    return pickBridges(this.site).length > 0;
  }

  /**
   * 配置里声明的 spider 包地址（形如 `http://x/y.jpg;md5;abc...`）
   * Android 侧车在手机上，主服务的本地路径对它没意义；
   * 带上 URL + MD5，手机端可以自己下载并按摘要校验，不用 adb push。
   */
  async #spiderSource() {
    try {
      const cfg = await this.ctx.store.get();
      const raw = String(cfg?.spider || '').trim();
      if (!raw) return {};
      const [url, md5] = raw.split(';md5;');
      return {
        spiderUrl: /^https?:/i.test(url.trim()) ? url.trim() : '',
        spiderMd5: (md5 || '').trim(),
      };
    } catch {
      return {};
    }
  }

  async #call(method, params = {}) {
    // api 名不带 Guard 时，用包的真实结构兜一层（有缓存，不会反复下载）
    let hardenedPkg = false;
    if (!/Guard$/i.test(String(this.site.api || ''))) {
      const diag = await this.ctx.store.inspectSpider().catch(() => ({}));
      hardenedPkg = diag.kind === 'android-hardened' || diag.kind === 'android-dex';
    }
    const bridges = pickBridges(this.site, hardenedPkg);

    if (!bridges.length) {
      const diag = await this.ctx.store.inspectSpider().catch(() => ({}));
      const err = new Error(
        `源「${this.site.name}」依赖 ${this.site.api}（${this.site.runtimeReason}），当前没有可用的 spider 侧车`,
      );
      err.code = 'SPIDER_RUNTIME_MISSING';
      err.detail = {
        site: this.site.key,
        api: this.site.api,
        spider: { kind: diag.kind, verdict: diag.verdict, guardBytes: diag.guardBytes },
        fix:
          diag.kind === 'android-hardened' || diag.kind === 'android-dex'
            ? '加固包必须跑在 Android 里：有 /dev/kvm 就用 docker compose -f docker-compose.nas.yml --profile android 起 KVM 模拟器，否则用真机；详见 docs/NAS-DEPLOY.md 第六节，再把 SPIDER_ANDROID_URL 指过去'
            : '普通 jar 可起 JVM 侧车：node scripts/jvm-sidecar.mjs，并设置 SPIDER_JVM_URL',
      };
      throw err;
    }

    const src = await this.#spiderSource();
    const tried = [];
    for (const base of bridges) {
      try {
        const data = await this.#request(base, method, params, src);
        this.engine = base;
        return data;
      } catch (e) {
        tried.push({ base, error: e.message });
        // 只有"连不上"才换下一个；侧车返回的业务错误直接抛，避免掩盖真问题
        if (isConnectFailure(e) && bridges.length > 1) {
          continue;
        }
        e.detail = { ...(e.detail || {}), tried };
        throw e;
      }
    }
    const diag = await this.ctx.store.inspectSpider().catch(() => ({}));
    const needAndroid = diag.kind === 'android-hardened' || diag.kind === 'android-dex';
    const err = new Error(
      needAndroid
        ? `该源是 Android 加固包，必须由 Android 侧车执行；当前侧车都连不上：${tried
            .map((t) => `${t.base} (${t.error})`)
            .join('；')}`
        : `所有 spider 侧车都连不上：${tried.map((t) => `${t.base} (${t.error})`).join('；')}`,
    );
    err.code = 'SPIDER_UNREACHABLE';
    err.detail = {
      tried,
      spiderKind: diag.kind,
      fix: needAndroid
        ? '先按 docs/NAS-DEPLOY.md 第六节起 Android 侧车（KVM 模拟器或真机），再把 SPIDER_ANDROID_URL 指过去'
        : '起 JVM 侧车 node scripts/jvm-sidecar.mjs，或检查 SPIDER_JVM_URL',
    };
    throw err;
  }

  async #request(base, method, params, src) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.SPIDER_TOKEN) headers['X-Nova-Token'] = process.env.SPIDER_TOKEN;
    const res = await fetch(base + '/spider', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        site: {
          key: this.site.key,
          name: this.site.name,
          api: this.site.api,
          ext: this.site.ext,
          spiderJar: this.site.spiderJar,
          ...src,
        },
        method,
        params,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const body = asObj(await res.json().catch(() => ({})));
    if (!body.ok) {
      const err = new Error(body.error || `侧车返回 ${res.status}`);
      err.code = 'SPIDER_BRIDGE_ERROR';
      err.detail = body;
      throw err;
    }
    return asObj(body.data);
  }

  async home() {
    return this.category({ tid: '', pg: 1 });
  }

  async category({ tid = '', pg = 1 } = {}) {
    const started = Date.now();
    const r = await this.#call('category', { tid, pg });
    return {
      site: this.site.key,
      items: (r.list || []).map(normalizeItem).filter((x) => x.name),
      classes: (r.class || []).map((c) => ({ id: String(c.type_id), name: String(c.type_name) })),
      page: Number(r.page || pg),
      tookMs: Date.now() - started,
      runtime: 'jar-spider',
      engine: this.engine || null,
    };
  }

  async search(wd) {
    const started = Date.now();
    const r = await this.#call('search', { wd });
    return {
      site: this.site.key,
      items: (r.list || []).map(normalizeItem).filter((x) => x.name),
      page: Number(r.page || 1),
      tookMs: Date.now() - started,
      runtime: 'jar-spider',
      engine: this.engine || null,
    };
  }

  async detail(id) {
    const started = Date.now();
    const r = await this.#call('detail', { id });
    const item = normalizeItem((r.list || [])[0] || {});
    const routes = buildRoutes(item.playFrom, item.playUrl);
    return { site: this.site.key, item, routes, tookMs: Date.now() - started, runtime: 'jar-spider' };
  }

  async play({ id, flag, ep }) {
    const { routes } = await this.detail(id);
    const route = routes.find((r) => r.flag === flag) || routes[0];
    if (!route) throw new Error('该影片没有可播放地址');
    const episode = route.episodes[Number(ep) || 0] || route.episodes[0];
    if (!episode) throw new Error('剧集不存在');
    const started = Date.now();
    const r = await this.#call('play', { flag: route.flag, ep: episode.url, id });
    const raw = String(r.url || r.playUrl || episode.url);
    const resolved = resolvePlayUrl(raw, this.site);
    return {
      ...resolved,
      site: this.site.key,
      flag: route.flag,
      title: episode.name,
      parse: Number(r.parse || 0),
      header: r.header || null,
      tookMs: Date.now() - started,
    };
  }
}
