import { http } from './util/http.js';
import { CmsAdapter } from './adapters/cms.js';
import { SpiderBridgeAdapter } from './adapters/spider.js';
import { JsSpiderAdapter } from './adapters/js-spider.js';
import { LiveAdapter } from './adapters/live.js';

export function createContext(store) {
  const client = http;
  return { store, client };
}

export function adapterFor(site, ctx) {
  if (!site) throw new Error('未找到该源');
  if (site.runtime === 'cms-json' || site.runtime === 'cms-xml') return new CmsAdapter(site, ctx);
  if (site.runtime === 'js-spider') return new JsSpiderAdapter(site, ctx);
  return new SpiderBridgeAdapter(site, ctx);
}

export function liveAdapterFor(entry, ctx) {
  return new LiveAdapter(entry, ctx);
}

export function publicSite(s) {
  return {
    key: s.key,
    name: s.name,
    runtime: s.runtime,
    runtimeReason: s.runtimeReason,
    supported: s.supported,
    searchable: Number(s.searchable ?? 0) === 1,
    quickSearch: Number(s.quickSearch ?? 0) === 1,
    style: s.style || null,
    api: s.api,
  };
}
