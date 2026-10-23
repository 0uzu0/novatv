/* NovaTV 前端：hash 路由 + 视图渲染（无框架，零构建） */
(function () {
  const view = document.getElementById('view');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = {
    sources: null,
    config: null,
    search: { wd: '', data: null, active: 'all', loading: false },
    live: { index: -1, data: null, group: '全部', kw: '', loading: false, error: '' },
    detail: {},
  };

  /* ---------------- 基础工具 ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICO = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.9 6.2.9-4.5 4.4 1 6.3-5.5-3-5.5 3 1-6.3L3 9.8l6.2-.9z"/></svg>',
    tv: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="m8 2 4 4 4-4"/></svg>',
    fire: '<svg viewBox="0 0 24 24"><path d="M12 3c3 4 5 6 5 9a5 5 0 0 1-10 0c0-3 2-5 5-9z"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/></svg>',
    empty: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 15h5l2 2h4l2-2h5"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  };

  async function api(path) {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok && !data.items) throw new Error(data.error || `请求失败 ${r.status}`);
    return data;
  }

  function toast(msg, kind) {
    const wrap = document.getElementById('toastWrap');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'err' ? ' err' : '');
    el.innerHTML = (kind === 'err' ? ICO.alert : ICO.info) + '<span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      setTimeout(() => el.remove(), 320);
    }, 2400);
  }
  document.addEventListener('novatv:toast', (e) => toast(e.detail));

  // 图片地址：外链走代理（绕 CORS / 防盗链），站内静态资源直接用
  const picUrl = (p) => (p && /^https?:/i.test(p) ? '/api/proxy?url=' + encodeURIComponent(p) : p || '');

  const skeleton = (n = 12) =>
    `<div class="grid">${Array.from({ length: n }, () => '<div class="card skel"><div class="card-poster"></div><div class="card-body"><div></div><div style="width:45%"></div></div></div>').join('')}</div>`;

  /* ---------- 收藏（localStorage 本地模式，不依赖后端） ---------- */
  const favAll = () => {
    try {
      return JSON.parse(localStorage.getItem('novatv:favs') || '{}');
    } catch {
      return {};
    }
  };
  const isFav = (site, id) => Boolean(favAll()[site + ':' + id]);
  function toggleFav(item) {
    const all = favAll();
    const k = item.site + ':' + item.id;
    if (all[k]) delete all[k];
    else all[k] = { ...item, at: Date.now() };
    localStorage.setItem('novatv:favs', JSON.stringify(all));
  }
  function renderFav() {
    const box = $('#favSection');
    if (!box) return;
    const list = Object.values(favAll()).sort((a, b) => b.at - a.at);
    if (!list.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="section-head"><h2>我的收藏</h2><span class="hint">${list.length} 部</span></div>
      <div class="grid">${list
        .map(
          (f) => `<a class="card" href="#/detail?site=${encodeURIComponent(f.site)}&id=${encodeURIComponent(f.id)}">
          <div class="card-poster">${f.poster ? `<img src="${picUrl(f.poster)}" loading="lazy" />` : `<div class="card-fallback">${esc((f.title || '?').slice(0, 2))}</div>`}
            ${f.remarks ? `<span class="card-tag">${esc(f.remarks)}</span>` : ''}</div>
          <div class="card-body"><div class="card-title">${esc(f.title)}</div>
          <div class="card-sub">${esc(f.year || '')}</div></div></a>`,
        )
        .join('')}</div>`;
  }

  function card(item, site) {
    const img = item.pic
      ? `<img src="${picUrl(item.pic)}" alt="${esc(item.name)}" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" />
         <div class="card-fallback" style="display:none">${esc((item.name || '?').slice(0, 2))}</div>`
      : `<div class="card-fallback">${esc((item.name || '?').slice(0, 2))}</div>`;
    const sub = [item.year, item.typeName || item.area].filter(Boolean).join(' · ');
    return `<a class="card" href="#/detail?site=${encodeURIComponent(site)}&id=${encodeURIComponent(item.id)}">
      <div class="card-poster">
        ${img}
        ${item.remarks ? `<span class="card-tag">${esc(item.remarks)}</span>` : ''}
        ${item.score ? `<span class="card-score">${esc(item.score)}</span>` : ''}
        <div class="card-play"><span>${ICO.play}</span></div>
      </div>
      <div class="card-body">
        <div class="card-title" title="${esc(item.name)}">${esc(item.name)}</div>
        <div class="card-sub">${sub ? esc(sub) : '<em>—</em>'}</div>
      </div>
    </a>`;
  }

  function setNav(nav) {
    $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === nav));
  }

  /* ---------------- 首页 ---------------- */
  async function renderHome() {
    setNav('home');
    view.innerHTML = `<div class="hero" id="hero"><div class="hero-bg"></div>
      <div class="hero-inner"><div class="hero-copy"><span class="hero-badge">${ICO.fire}载入中</span>
      <h1 class="hero-title">正在读取接口配置…</h1><p class="hero-desc">首次加载会解析「饭太硬」接口的图片载体配置，请稍候。</p></div></div></div>
      <div class="section">${skeleton(10)}</div>`;

    let src, cat;
    try {
      src = state.sources || (state.sources = await api('/api/sources'));
      state.config = await api('/api/config');
    } catch (e) {
      return renderFatal(e.message);
    }

    const demo = src.sites.find((s) => s.demo) || src.sites.find((s) => s.supported);
    try {
      cat = demo ? await api(`/api/category?site=${encodeURIComponent(demo.key)}&pg=1`) : { items: [] };
    } catch {
      cat = { items: [] };
    }

    const items = cat.items || [];
    const heroItems = items.slice(0, 3);
    const cfg = state.config || {};
    const stats = src.stats || {};

    view.innerHTML = `
      ${heroHtml(heroItems, demo, items)}
      <div class="section">
        <div class="stat-row">
          <div class="stat"><div class="k">接口源总数</div><div class="v">${stats.total ?? src.sites.length} <small>个</small></div></div>
          <div class="stat"><div class="k">可用运行时</div><div class="v">${(stats.supported ?? 0) + 1} <small>/ ${(stats.total ?? 0) + 1}</small></div></div>
          <div class="stat"><div class="k">直播源</div><div class="v">${src.lives.length} <small>组</small></div></div>
          <div class="stat"><div class="k">配置载入</div><div class="v">${cfg.tookMs ?? '—'} <small>ms</small></div></div>
        </div>
      </div>

      <div class="section" id="continueSection" hidden></div>
      <div class="section" id="favSection" hidden></div>

      <div class="section">
        <div class="section-head">
          <h2>演示片单</h2>
          <span class="hint">用于验证「搜索 → 详情 → 多线路 → 播放」完整链路</span>
          <a class="more" href="#/sources">全部源 ${ICO.arrow}</a>
        </div>
        <div class="grid">${items.map((i) => card(i, demo?.key || 'nova-demo')).join('') || emptyHtml('该源暂无内容')}</div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2>直播预览</h2>
          <span class="hint" id="liveHint">来自接口 lives 配置</span>
          <a class="more" href="#/live">进入直播 ${ICO.arrow}</a>
        </div>
        <div id="livePreview"><div class="chips">${Array.from({ length: 8 }, () => '<span class="chip">…</span>').join('')}</div></div>
      </div>

      <div class="section">
        <div class="section-head"><h2>运行时概览</h2><span class="hint">TVBox type 语义 → 服务端适配器</span></div>
        <div class="chips">
          ${Object.entries(stats.byRuntime || {}).map(([k, v]) => `<span class="chip"><i class="dot-badge ${k.includes('jar') || k.includes('js') ? 'warn' : 'ok'}"></i>${runtimeLabel(k)}<span class="n">${v}</span></span>`).join('')}
          <span class="chip"><i class="dot-badge ok"></i>cms-json（演示源）<span class="n">1</span></span>
        </div>
        <div class="notice" style="margin-top:14px">${ICO.info}
          <div>该接口的 ${stats.byRuntime?.['jar-spider'] ?? 0} 个点播源全部指向同一个 <b>Android 加固 spider</b>（classes.dex + 原生 .so + 加密 guard），服务端无法直接复用；平台已实现蜘蛛运行时抽象层，配置 <code>SPIDER_BRIDGE_URL</code> 即可接入自建侧车。详见 <a href="#/diag" style="color:var(--accent)">诊断页</a>。</div>
        </div>
      </div>`;

    initHero(heroItems, demo);
    renderContinue();
    renderFav();
    renderLivePreview(src);
  }

  function runtimeLabel(k) {
    return {
      'cms-json': 'CMS JSON',
      'cms-xml': 'CMS XML',
      'jar-spider': 'Jar Spider',
      'js-spider': 'JS Spider',
      'remote-spider': 'Remote Spider',
      unknown: '未知',
    }[k] || k;
  }

  function heroHtml(items, demo, all) {
    if (!items.length) {
      return `<div class="hero"><div class="hero-bg" style="background-image:linear-gradient(120deg,#241a4d,#0d2b3d)"></div>
        <div class="hero-inner"><div class="hero-copy"><span class="hero-badge">${ICO.info}NovaTV</span>
        <h1 class="hero-title">接口已接入，等待可播的源</h1>
        <p class="hero-desc">当前接口的源均为 TVBox 加固 spider，服务端运行时不可用。你可以接入自建 CMS 接口，或配置 spider 侧车后启用。</p>
        <div class="hero-actions"><a class="btn-primary" href="#/diag">${ICO.info}查看诊断</a></div>
        </div></div></div>`;
    }
    const first = items[0];
    const bg = first.pic ? `${picUrl(first.pic)}` : '';
    return `<div class="hero" id="hero">
      <div class="hero-bg" style="background-image:url('${bg}')"></div>
      <div class="hero-inner">
        <div class="hero-copy" id="heroCopy">
          <span class="hero-badge">${ICO.fire}本周热播</span>
          <h1 class="hero-title">${esc(first.name)}</h1>
          <div class="hero-meta">
            ${first.score ? `<span class="score">★ ${esc(first.score)}</span><i class="sep"></i>` : ''}
            <span>${esc(first.year || '—')}</span><i class="sep"></i>
            <span>${esc(first.typeName || '影片')}</span><i class="sep"></i>
            <span>${esc(first.remarks || '正片')}</span>
          </div>
          <p class="hero-desc">${esc(first.content || '暂无简介')}</p>
          <div class="hero-actions">
            <button class="btn-primary" onclick="location.hash='#/detail?site=${encodeURIComponent(demo.key)}&id=${encodeURIComponent(first.id)}'">${ICO.play}立即播放</button>
            <a class="btn-ghost" href="#/detail?site=${encodeURIComponent(demo.key)}&id=${encodeURIComponent(first.id)}">${ICO.info}查看详情</a>
          </div>
        </div>
        <div class="hero-poster" id="heroPoster">
          <span class="rank">TOP 1</span>
          ${first.pic ? `<img src="${picUrl(first.pic)}" alt="" />` : ''}
        </div>
      </div>
      <div class="hero-dots" id="heroDots">${items.map((_, i) => `<button class="${i === 0 ? 'on' : ''}" data-i="${i}"></button>`).join('')}</div>
    </div>`;
  }

  function initHero(items, demo) {
    if (!items.length) return;
    let idx = 0;
    const bg = $('#hero .hero-bg');
    const copy = $('#heroCopy');
    const poster = $('#heroPoster');
    const dots = $$('#heroDots button');
    const paint = (i) => {
      const it = items[i];
      idx = i;
      if (bg) bg.style.backgroundImage = it.pic ? `url('${picUrl(it.pic)}')` : '';
      if (copy) {
        copy.innerHTML = `
          <span class="hero-badge">${ICO.fire}本周热播</span>
          <h1 class="hero-title">${esc(it.name)}</h1>
          <div class="hero-meta">
            ${it.score ? `<span class="score">★ ${esc(it.score)}</span><i class="sep"></i>` : ''}
            <span>${esc(it.year || '—')}</span><i class="sep"></i>
            <span>${esc(it.typeName || '影片')}</span><i class="sep"></i>
            <span>${esc(it.remarks || '正片')}</span>
          </div>
          <p class="hero-desc">${esc(it.content || '暂无简介')}</p>
          <div class="hero-actions">
            <button class="btn-primary" onclick="location.hash='#/detail?site=${encodeURIComponent(demo.key)}&id=${encodeURIComponent(it.id)}'">${ICO.play}立即播放</button>
            <a class="btn-ghost" href="#/detail?site=${encodeURIComponent(demo.key)}&id=${encodeURIComponent(it.id)}">${ICO.info}查看详情</a>
          </div>`;
      }
      if (poster) {
        poster.innerHTML = `<span class="rank">TOP ${i + 1}</span>${it.pic ? `<img src="${picUrl(it.pic)}" alt="" />` : ''}`;
      }
      dots.forEach((d, k) => d.classList.toggle('on', k === i));
    };
    dots.forEach((d) => (d.onclick = () => paint(Number(d.dataset.i))));
    if (items.length > 1) {
      clearInterval(window.__heroTimer);
      window.__heroTimer = setInterval(() => paint((idx + 1) % items.length), 7000);
    }
  }

  function renderContinue() {
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem('novatv:history') || '{}');
    } catch { /* noop */ }
    const list = Object.values(all).sort((a, b) => b.at - a.at).slice(0, 6);
    const box = $('#continueSection');
    if (!box) return;
    if (!list.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="section-head"><h2>继续观看</h2><span class="hint">本地记录 · ${list.length} 条</span></div>
      <div class="grid">${list
        .map(
          (h) => `<a class="card" href="#/detail?site=${encodeURIComponent(h.site)}&id=${encodeURIComponent(h.id)}">
        <div class="card-poster">${h.poster ? `<img src="${picUrl(h.poster)}" loading="lazy" />` : `<div class="card-fallback">${esc((h.title || '?').slice(0, 2))}</div>`}
          <span class="card-tag">看到 ${Math.round(((h.position || 0) / (h.duration || 1)) * 100)}%</span></div>
        <div class="card-body"><div class="card-title">${esc(h.title)}</div>
        <div class="card-sub">${ICO.clock}<em>第 ${(h.epIndex || 0) + 1} 集</em></div></div></a>`,
        )
        .join('')}</div>`;
  }

  async function renderLivePreview(src) {
    const box = $('#livePreview');
    if (!box || !src.lives.length) return;
    const target = src.lives.findIndex((l) => /虎牙/.test(l.name)) >= 0 ? src.lives.findIndex((l) => /虎牙/.test(l.name)) : 0;
    try {
      const data = await api(`/api/live?index=${target}`);
      const chs = data.groups.flatMap((g) => g.channels).slice(0, 10);
      box.innerHTML = `<div class="live-grid">${chs
        .map(
          (c, i) => `<button class="live-item" data-live="${target}" data-ch="${i}">
          <span class="ico">${ICO.tv}</span><span>${esc(c.name)}</span></button>`,
        )
        .join('')}</div>`;
      $$('[data-live]', box).forEach((b) => {
        b.onclick = () => {
          const ch = data.groups.flatMap((g) => g.channels)[Number(b.dataset.ch)];
          playLive(ch, data.name);
        };
      });
      const hint = $('#liveHint');
      if (hint) hint.textContent = `${data.name} · ${data.count} 个频道`;
    } catch (e) {
      box.innerHTML = `<div class="notice">${ICO.alert}<div>直播源加载失败：${esc(e.message)}</div></div>`;
    }
  }

  /* ---------------- 搜索 ---------------- */
  async function renderSearch(wd, sitesParam) {
    setNav('search');
    const q = wd || state.search.wd || '';
    const scope = (sitesParam || '').split(',').filter(Boolean);
    view.innerHTML = `
      <div style="max-width:760px;margin:18px auto 0">
        <form class="searchbar" id="bigSearch" style="max-width:none;height:52px">
          <span class="ico">${ICO.search}</span>
          <input id="bigInput" type="search" placeholder="输入片名，聚合搜索所有可用源…" value="${esc(q)}" autocomplete="off" />
          <kbd>Enter</kbd>
        </form>
        <div class="chips" style="margin-top:12px">
          ${scope.length
            ? `<span class="chip on">仅在 ${esc(scope.join(','))} 中搜索</span><a class="chip" href="#/search?wd=${encodeURIComponent(q)}">搜索全部源</a>`
            : ['星际', '流光', '深海', '山海'].map((k) => `<button class="chip" data-kw="${k}">${k}</button>`).join('')}
        </div>
      </div>
      <div id="searchResult" class="section">${q ? skeleton(10) : emptyHtml('输入关键词开始聚合搜索', '当前接口中可用的 CMS 源会被并发请求，其余源会以"运行时缺失"标记跳过')}</div>`;

    $('#bigSearch').onsubmit = (e) => {
      e.preventDefault();
      const v = $('#bigInput').value.trim();
      if (v) location.hash = '#/search?wd=' + encodeURIComponent(v);
    };
    $$('[data-kw]').forEach((b) => (b.onclick = () => (location.hash = '#/search?wd=' + encodeURIComponent(b.dataset.kw))));
    if (!q) return;

    state.search.wd = q;
    state.search.loading = true;
    const started = Date.now();
    try {
      const qs = '/api/search?wd=' + encodeURIComponent(q) + (scope.length ? '&sites=' + encodeURIComponent(scope.join(',')) : '');
      const data = await api(qs);
      state.search.data = data;
      state.search.active = 'all';
      renderSearchResult(q, data, Date.now() - started);
    } catch (e) {
      $('#searchResult').innerHTML = `<div class="notice">${ICO.alert}<div>搜索失败：${esc(e.message)}</div></div>`;
    }
  }

  function renderSearchResult(wd, data, took) {
    const okGroups = data.groups.filter((g) => g.items.length);
    const failed = data.groups.filter((g) => !g.items.length);
    const skel = failed.filter((g) => g.skipped);
    const box = $('#searchResult');

    if (!okGroups.length) {
      box.innerHTML = `
        <div class="empty">${ICO.empty}<h3>没有找到「${esc(wd)}」</h3>
        <p>共 ${data.groups.length} 个源参与检索，其中 ${skel.length} 个因运行时缺失被跳过、${failed.length - skel.length} 个请求失败。</p></div>
        ${noticeRuntime(skel)}`;
      return;
    }

    const active = state.search.active;
    const shown = active === 'all' ? okGroups : okGroups.filter((g) => g.site === active);

    box.innerHTML = `
      <div class="section-head" style="margin-top:26px">
        <h2>搜索结果</h2>
        <span class="hint">「${esc(wd)}」· ${data.total} 条 · ${okGroups.length} 个源命中 · ${took}ms</span>
      </div>
      <div class="chips" style="margin-bottom:16px">
        <button class="chip ${active === 'all' ? 'on' : ''}" data-tab="all">全部<span class="n">${data.total}</span></button>
        ${okGroups.map((g) => `<button class="chip ${active === g.site ? 'on' : ''}" data-tab="${esc(g.site)}">${esc(g.name)}<span class="n">${g.items.length}</span></button>`).join('')}
      </div>
      ${shown
        .map(
          (g) => `<div class="section" style="margin-top:${active === 'all' ? '0' : '8px'}">
          ${active === 'all' ? `<div class="section-head"><h2 style="font-size:15px">${esc(g.name)}</h2><span class="hint">${g.tookMs ?? 0}ms</span></div>` : ''}
          <div class="grid">${g.items.map((i) => card(i, g.site)).join('')}</div></div>`,
        )
        .join('')}
      ${skel.length ? noticeRuntime(skel) : ''}`;

    $$('[data-tab]').forEach((b) => {
      b.onclick = () => {
        state.search.active = b.dataset.tab;
        renderSearchResult(wd, data, took);
      };
    });
  }

  function noticeRuntime(skel) {
    if (!skel.length) return '';
    const jar = skel.filter((s) => s.runtime === 'jar-spider').length;
    const js = skel.filter((s) => s.runtime === 'js-spider').length;
    return `<div class="notice" style="margin-top:22px">${ICO.alert}<div>
      <b>${skel.length} 个源被跳过</b>：其中 ${jar} 个需要 jar spider（Android 加固包）、${js} 个需要 QuickJS 运行时。
      这是 TVBox 生态的通用限制——spider 逻辑跑在客户端壳里，服务端要复用得自建侧车。
      详见 <a href="#/diag" style="color:var(--accent)">运行时诊断</a>。</div></div>`;
  }

  /* ---------------- 详情 ---------------- */
  async function renderDetail(siteKey, id) {
    setNav(null);
    view.innerHTML = `<div class="detail-hero"><div class="bg"></div><div class="detail-inner">
      <div class="detail-poster skel" style="border-radius:14px"></div>
      <div class="detail-info"><h1 style="opacity:.4">载入中…</h1><div class="chips"><span class="chip">…</span></div></div>
    </div></div>`;

    try {
      const d = await api(`/api/detail?site=${encodeURIComponent(siteKey)}&id=${encodeURIComponent(id)}`);
      const it = d.item;
      const site = state.sources?.sites.find((s) => s.key === siteKey) || d.site;
      state.detail = { site: siteKey, id, data: d };
      const routes = d.routes || [];
      const firstRoute = routes[0];

      view.innerHTML = `
        <div class="detail-hero">
          <div class="bg" style="background-image:url('${picUrl(it.pic)}')"></div>
          <div class="detail-inner">
            <div class="detail-poster">${it.pic ? `<img src="${picUrl(it.pic)}" />` : `<div class="card-fallback">${esc(it.name.slice(0, 2))}</div>`}</div>
            <div class="detail-info">
              <div class="hero-meta"><a href="#/home" style="color:var(--text-3)">首页</a><i class="sep"></i><span>${esc(site?.name || siteKey)}</span></div>
              <h1>${esc(it.name)}</h1>
              <div class="detail-tags">
                ${it.score ? `<span class="t" style="color:var(--gold)">★ ${esc(it.score)}</span>` : ''}
                ${it.year ? `<span class="t">${esc(it.year)}</span>` : ''}
                ${it.area ? `<span class="t">${esc(it.area)}</span>` : ''}
                ${it.typeName ? `<span class="t">${esc(it.typeName)}</span>` : ''}
                ${it.remarks ? `<span class="t">${esc(it.remarks)}</span>` : ''}
                ${it.director ? `<span class="t">导演 ${esc(it.director)}</span>` : ''}
                ${it.actor ? `<span class="t">主演 ${esc(it.actor)}</span>` : ''}
              </div>
              <p class="detail-desc clamp" id="desc">${esc(it.content || '暂无简介')}</p>
              <button class="link-more" id="descMore" hidden>展开简介</button>
              <div class="hero-actions" style="margin-top:18px">
                ${firstRoute ? `<button class="btn-primary" id="playFirst">${ICO.play}播放第 1 集</button>` : ''}
                <button class="btn-ghost" id="favBtn">${ICO.star}收藏</button>
                <a class="btn-ghost" href="#/sources">${ICO.link}查看全部源</a>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-head"><h2>播放列表</h2><span class="hint">${routes.length} 条线路 · ${routes.reduce((s, r) => s + r.episodes.length, 0)} 个剧集</span></div>
          <div class="route-tabs" id="routeTabs">
            ${routes.map((r, i) => `<button class="route-tab ${i === 0 ? 'on' : ''}" data-route="${i}">${esc(r.flag)}<span class="n">${r.episodes.length}</span></button>`).join('')}
          </div>
          <div class="eps" id="epBox"></div>
        </div>`;

      const paintEps = (ri) => {
        const r = routes[ri];
        $('#epBox').innerHTML = r.episodes
          .map((e, i) => `<button class="ep" data-ep="${i}">${esc(e.name || '第' + (i + 1) + '集')}</button>`)
          .join('');
        $$('#epBox .ep').forEach((b) => {
          b.onclick = () => {
            $$('#epBox .ep').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
            player.open({
              title: it.name, site: siteKey, id, flag: r.flag, epIndex: Number(b.dataset.ep),
              routes, poster: it.pic, siteName: site?.name || siteKey,
            });
          };
        });
      };
      paintEps(0);
      $$('#routeTabs .route-tab').forEach((b) => {
        b.onclick = () => {
          $$('#routeTabs .route-tab').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          paintEps(Number(b.dataset.route));
        };
      });
      if (firstRoute) {
        $('#playFirst').onclick = () =>
          player.open({
            title: it.name, site: siteKey, id, flag: firstRoute.flag, epIndex: 0,
            routes, poster: it.pic, siteName: site?.name || siteKey,
          });
      }
      $('#descMore').onclick = () => {
        const d2 = $('#desc');
        d2.classList.toggle('clamp');
        $('#descMore').textContent = d2.classList.contains('clamp') ? '展开简介' : '收起简介';
      };
      // 简介没溢出就不显示"展开"
      requestAnimationFrame(() => {
        const d2 = $('#desc');
        const btn = $('#descMore');
        if (btn && d2.scrollHeight <= d2.clientHeight + 2) btn.hidden = true;
      });
      // 收藏
      const favBtn = $('#favBtn');
      const paintFav = () => {
        const on = isFav(siteKey, id);
        favBtn.style.color = on ? 'var(--gold)' : '';
        favBtn.style.borderColor = on ? 'rgba(255,195,92,.45)' : '';
        favBtn.innerHTML = `${ICO.star}${on ? '已收藏' : '收藏'}`;
      };
      paintFav();
      favBtn.onclick = () => {
        toggleFav({ site: siteKey, id, title: it.name, poster: it.pic, year: it.year, remarks: it.remarks });
        paintFav();
        toast(isFav(siteKey, id) ? '已加入收藏' : '已取消收藏');
      };
      if (!routes.length) {
        $('#epBox').innerHTML = `<div class="notice">${ICO.alert}<div>该影片没有返回播放地址（可能源站数据缺失）。</div></div>`;
      }
    } catch (e) {
      view.innerHTML = `<div class="section"><div class="notice">${ICO.alert}<div>
        <b>无法加载详情</b><br/>${esc(e.message)}<br/>
        <a href="#/sources" style="color:var(--accent)">返回源列表</a></div></div></div>`;
    }
  }

  /* ---------------- 直播 ---------------- */
  async function renderLive(keep) {
    setNav('live');
    const src = state.sources || (state.sources = await api('/api/sources'));
    const lives = src.lives;
    view.innerHTML = `
      <div class="section" style="margin-top:18px">
        <div class="section-head"><h2>电视直播</h2><span class="hint">${lives.length} 组源 · 来自接口 lives 配置</span></div>
        <div class="chips" id="liveSrcChips">${lives
          .map((l, i) => `<button class="chip ${i === (state.live.index >= 0 ? state.live.index : 0) ? 'on' : ''}" data-src="${i}">${esc(l.name)}</button>`)
          .join('')}</div>
      </div>
      <div id="liveBody" class="section">${skeleton(8)}</div>`;

    const load = async (i) => {
      state.live.index = i;
      $$('#liveSrcChips .chip').forEach((c) => c.classList.toggle('on', Number(c.dataset.src) === i));
      $('#liveBody').innerHTML = skeleton(8);
      try {
        const data = await api(`/api/live?index=${i}`);
        state.live.data = data;
        state.live.group = '全部';
        state.live.kw = '';
        paintLive();
      } catch (e) {
        $('#liveBody').innerHTML = `<div class="notice">${ICO.alert}<div>该直播源加载失败：${esc(e.message)}<br/>可能源站已失效，试试其他源。</div></div>`;
      }
    };
    $$('#liveSrcChips .chip').forEach((c) => (c.onclick = () => load(Number(c.dataset.src))));
    await load(keep ?? (state.live.index >= 0 ? state.live.index : 0));
  }

  function paintLive() {
    const data = state.live.data;
    if (!data) return;
    const groups = data.groups || [];
    const cur = state.live.group;
    const channels = (cur === '全部' ? groups.flatMap((g) => g.channels) : (groups.find((g) => g.name === cur)?.channels || [])).filter(
      (c) => !state.live.kw || c.name.toLowerCase().includes(state.live.kw.toLowerCase()),
    );
    $('#liveBody').innerHTML = `
      <div class="live-toolbar">
        <label class="live-search">${ICO.search}<input id="liveKw" placeholder="搜索频道" value="${esc(state.live.kw)}" /></label>
        <span class="hint" style="color:var(--text-3);font-size:12.5px">${data.name} · ${data.count} 个频道</span>
      </div>
      <div class="chips" style="margin-bottom:14px">
        <button class="chip ${cur === '全部' ? 'on' : ''}" data-g="全部">全部<span class="n">${data.count}</span></button>
        ${groups.map((g) => `<button class="chip ${cur === g.name ? 'on' : ''}" data-g="${esc(g.name)}">${esc(g.name)}<span class="n">${g.count}</span></button>`).join('')}
      </div>
      <div class="live-grid">${channels
        .slice(0, 400)
        .map(
          (c, i) => `<button class="live-item" data-ci="${groups.flatMap((g) => g.channels).indexOf(c)}">
          <span class="ico">${ICO.tv}</span><span title="${esc(c.name)}">${esc(c.name)}</span></button>`,
        )
        .join('') || emptyHtml('没有匹配的频道')}</div>`;

    $$('#liveBody [data-g]').forEach((b) => {
      b.onclick = () => {
        state.live.group = b.dataset.g;
        paintLive();
      };
    });
    const kw = $('#liveKw');
    if (kw) {
      kw.oninput = () => {
        state.live.kw = kw.value.trim();
        const pos = kw.selectionStart;
        paintLive();
        const nk = $('#liveKw');
        nk.focus();
        nk.setSelectionRange(pos, pos);
      };
    }
    $$('#liveBody [data-ci]').forEach((b) => {
      b.onclick = () => {
        const all = data.groups.flatMap((g) => g.channels);
        playLive(all[Number(b.dataset.ci)], data.name);
      };
    });
  }

  function playLive(ch, sourceName) {
    if (!ch) return;
    player.open({
      title: ch.name,
      siteName: sourceName,
      sub: sourceName,
      live: true,
      direct: '/api/proxy?url=' + encodeURIComponent(ch.url),
      rawUrl: ch.url,
    });
  }

  /* ---------------- 源列表 ---------------- */
  async function renderSources() {
    setNav('sources');
    const src = state.sources || (state.sources = await api('/api/sources'));
    const cfg = state.config || (state.config = await api('/api/config'));
    const sites = src.sites;
    const ok = sites.filter((s) => s.supported);
    const bad = sites.filter((s) => !s.supported);

    view.innerHTML = `
      <div class="section" style="margin-top:18px">
        <div class="section-head"><h2>播放源</h2><span class="hint">${sites.length} 个源 · 接口 ${esc(cfg.carrier || 'json')}</span></div>
        <div class="stat-row">
          <div class="stat"><div class="k">可直接使用</div><div class="v" style="color:var(--ok)">${ok.length}</div></div>
          <div class="stat"><div class="k">需要额外运行时</div><div class="v" style="color:var(--warn)">${bad.length}</div></div>
          <div class="stat"><div class="k">可搜索</div><div class="v">${sites.filter((s) => s.searchable).length}</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>可用源</h2><span class="hint">服务端适配器已就绪</span></div>
        <div class="src-list">${ok
          .map(
            (s) => `<div class="src-row">
            <div class="src-name"><i class="dot-badge ok"></i>
              <div style="min-width:0"><strong>${esc(s.name)}</strong><div class="api">${esc(s.demo ? '内置演示接口 · 苹果CMS 协议' : s.api)}</div></div>
            </div>
            <span class="badge ok">${runtimeLabel(s.runtime)}</span>
            <a class="ghost-btn" href="#/search?wd=${encodeURIComponent('星际')}&sites=${encodeURIComponent(s.key)}">用该源搜索</a>
          </div>`,
          )
          .join('')}</div>
      </div>

      <div class="section">
        <div class="section-head"><h2>需要运行时</h2><span class="hint">点击查看原因</span></div>
        <div class="src-list">${bad
          .map(
            (s) => `<div class="src-row">
            <div class="src-name"><i class="dot-badge warn"></i>
              <div style="min-width:0"><strong>${esc(s.name)}</strong>
                <div class="api">${esc(String(s.api).slice(0, 70))}</div>
                <div class="api" style="color:var(--text-3);margin-top:3px">${esc(s.runtimeReason || '')}</div>
              </div>
            </div>
            <span class="badge ${s.runtime === 'jar-spider' ? 'err' : 'warn'}">${runtimeLabel(s.runtime)}</span>
            <a class="ghost-btn" href="#/diag">诊断</a>
          </div>`,
          )
          .join('')}</div>
      </div>`;
  }

  /* ---------------- 诊断 ---------------- */
  async function renderDiag() {
    setNav('diag');
    view.innerHTML = `<div class="section"><div class="section-head"><h2>运行时诊断</h2><span class="hint">正在验尸 spider 包…</span></div>${skeleton(6)}</div>`;
    let d;
    let rt = null;
    try {
      [d, rt] = await Promise.all([api('/api/diag'), api('/api/runtime').catch(() => null)]);
    } catch (e) {
      view.innerHTML = `<div class="section"><div class="notice">${ICO.alert}<div>诊断失败：${esc(e.message)}</div></div></div>`;
      return;
    }
    const sp = d.spider || {};
    const cfg = d.config || {};
    const runtimeHtml = rt
      ? `
      <div class="section" style="margin-top:18px">
        <div class="section-head"><h2>运行时能力矩阵</h2><span class="hint">每个源靠什么跑、缺什么、怎么补</span></div>
        <div class="src-list">
          ${(rt.runtimes || [])
            .map(
              (r) => `<div class="src-row" style="grid-template-columns:1fr auto">
              <div class="src-name"><i class="dot-badge ${r.available ? 'ok' : 'err'}"></i>
                <div style="min-width:0"><strong>${esc(r.label)}</strong>
                  <div class="api">${esc(r.engine)} · ${esc((r.supportedTypes || []).join(' / '))}</div>
                  <div class="api" style="color:var(--text-3);margin-top:4px">${esc(r.note)}</div>
                </div>
              </div>
              <span class="badge ${r.available ? 'ok' : 'err'}">${r.available ? '可用' : '不可用'}</span>
            </div>`,
            )
            .join('')}
        </div>
        <div class="notice" style="margin-top:12px">${ICO.info}<div>
          当前配置里 <b>${(rt.config?.stats?.byRuntime?.['jar-spider'] || 0)}</b> 个源依赖 spider jar，
          <b>${(rt.config?.stats?.byRuntime?.['js-spider'] || 0)}</b> 个是 JS 源（已在服务端运行）。
          jar 源能不能跑取决于侧车：JVM 侧车只吃未加固 jar，加固包必须走 Android 容器。
        </div></div>
      </div>`
      : '';

    view.innerHTML = `
      ${runtimeHtml}
      <div class="section" style="margin-top:18px">
        <div class="section-head"><h2>配置载体</h2><span class="hint">DecoTV/TVBox 接口的下载与解码</span></div>
        <div class="stat-row">
          <div class="stat"><div class="k">接口地址</div><div class="v" style="font-size:14px;word-break:break-all">${esc(cfg.url)}</div></div>
          <div class="stat"><div class="k">载体类型</div><div class="v" style="font-size:20px">${esc(cfg.carrier)}</div></div>
          <div class="stat"><div class="k">HTTP / 字节</div><div class="v" style="font-size:18px">${cfg.http?.status} · ${cfg.http?.bytes}</div></div>
          <div class="stat"><div class="k">解码耗时</div><div class="v">${cfg.tookMs} <small>ms</small></div></div>
        </div>
        <div class="notice" style="margin-top:14px">${ICO.info}<div>
          该接口不是普通 JSON：HTTP 以 <code>${esc(cfg.http?.contentType || '?')}</code> 返回一张图片，
          JSON 配置 Base64 后追加在 JPEG 结束标记（偏移 ${cfg.payloadOffset ?? '—'} 字节）之后，
          前面还带 8 字节盐。平台内置解码器会自动剥离盐值、Base64 解码、去掉 <code>//</code> 注释后解析。
        </div></div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Spider 包验尸</h2><span class="hint">决定 type=3 源能否复用</span></div>
        <div class="src-row" style="grid-template-columns:1fr auto">
          <div class="src-name"><i class="dot-badge ${sp.runnable ? 'ok' : 'err'}"></i>
            <div style="min-width:0"><strong>${esc(sp.kind)}</strong><div class="api">${esc(sp.url || '')}</div></div>
          </div>
          <span class="badge ${sp.runnable ? 'ok' : 'err'}">${sp.runnable ? '可运行' : '不可运行'}</span>
        </div>
        <div class="notice" style="margin-top:12px">${ICO.alert}<div>${esc(sp.verdict || '无 spider 配置')}</div></div>
        <div class="src-list" style="margin-top:12px">
          ${(sp.entries || [])
            .map(
              (e) => `<div class="src-row" style="grid-template-columns:1fr auto auto">
              <div class="src-name"><i class="dot-badge ${/\.(dex|so)$/.test(e.name) ? 'err' : 'warn'}"></i>
                <div class="api" style="color:var(--text)">${esc(e.name)}</div></div>
              <span class="badge">${(e.size / 1024).toFixed(1)} KB</span>
              <span class="badge ${/dex|so/.test(e.name) ? 'err' : ''}">${/\.dex$/.test(e.name) ? 'Android DEX' : /\.so$/.test(e.name) ? 'Native' : /guard/.test(e.name) ? '加密载荷' : '资源'}</span>
            </div>`,
            )
            .join('')}
        </div>
        <div class="notice" style="margin-top:12px">${ICO.info}<div>
          MD5 校验：<b style="color:${sp.md5Ok ? 'var(--ok)' : 'var(--danger)'}">${sp.md5Ok ? '通过' : '未通过'}</b>
          （配置声明 <code>${esc(sp.expectMd5 || '—')}</code>）· 包大小 ${((sp.bytes || 0) / 1024 / 1024).toFixed(2)} MB
        </div></div>
      </div>

      <div class="section">
        <div class="section-head"><h2>运行时分布</h2><span class="hint">${Object.keys(d.runtimes || {}).length} 类</span></div>
        <div class="chips">
          ${Object.entries(d.runtimes || {}).map(([k, v]) => `<span class="chip"><i class="dot-badge ${k === 'cms-json' || k === 'cms-xml' ? 'ok' : 'warn'}"></i>${runtimeLabel(k)}<span class="n">${v}</span></span>`).join('')}
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>源逐个诊断</h2><span class="hint">${(d.sites || []).length} 条</span></div>
        <div class="src-list">${(d.sites || [])
          .map(
            (s) => `<div class="src-row">
            <div class="src-name"><i class="dot-badge ${s.supported ? 'ok' : 'warn'}"></i>
              <div style="min-width:0"><strong>${esc(s.name)}</strong><div class="api">${esc(String(s.api).slice(0, 72))}</div></div></div>
            <span class="badge ${s.supported ? 'ok' : 'warn'}">${runtimeLabel(s.runtime)}</span>
            <span class="badge">${esc(String(s.reason || '').slice(0, 18))}</span>
          </div>`,
          )
          .join('')}</div>
      </div>

      <div class="section">
        <div class="section-head"><h2>接入自建运行时</h2></div>
        <div class="notice">${ICO.link}<div>
          实现一个 <code>POST /spider</code> 的侧车服务（JVM 里加载 jar 或用 Android 容器），
          让它在 <code>{site, method, params}</code> 上调用 CatVod 的 home/category/search/detail/playerContent，
          然后启动时设置环境变量 <code>SPIDER_BRIDGE_URL=http://127.0.0.1:9000</code>，平台会自动接管这些 type=3 源。
        </div></div>
      </div>`;
  }

  function emptyHtml(title, desc) {
    return `<div class="empty">${ICO.empty}<h3>${esc(title)}</h3>${desc ? `<p>${esc(desc)}</p>` : ''}</div>`;
  }

  function renderFatal(msg) {
    view.innerHTML = `<div class="section"><div class="notice">${ICO.alert}<div>
      <b>无法连接后端</b><br/>${esc(msg)}<br/>请确认已运行 <code>npm start</code>。</div></div></div>`;
  }

  /* ---------------- 路由 ---------------- */
  function parseHash() {
    const h = location.hash.replace(/^#/, '') || '/home';
    const [path, qs] = h.split('?');
    return { path, q: new URLSearchParams(qs || '') };
  }

  async function route() {
    const { path, q } = parseHash();
    state.sources = state.sources || (await api('/api/sources').catch(() => null));
    if (path === '/' || path === '/home') return renderHome();
    if (path === '/search') return renderSearch(q.get('wd') || '', q.get('sites') || '');
    if (path === '/detail') return renderDetail(q.get('site'), q.get('id'));
    if (path === '/live') return renderLive();
    if (path === '/sources') return renderSources();
    if (path === '/diag') return renderDiag();
    return renderHome();
  }

  /* ---------------- 初始化 ---------------- */
  const player = new window.NovaPlayer(document.getElementById('playerLayer'));
  window.player = player;

  window.addEventListener('hashchange', () => {
    route();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.addEventListener('novatv:history', () => {
    if (parseHash().path === '/home') renderContinue();
  });

  $$('[data-nav]').forEach((b) => {
    b.onclick = () => {
      const n = b.dataset.nav;
      location.hash = '#/' + n;
    };
  });

  $('#searchForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#searchInput').value.trim();
    if (v) location.hash = '#/search?wd=' + encodeURIComponent(v);
  };

  $('#refreshBtn').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('spin');
    try {
      await api('/api/config?force=1');
      state.sources = await api('/api/sources');
      toast('接口配置已刷新：' + new Date().toLocaleTimeString());
      route();
    } catch (err) {
      toast('刷新失败：' + err.message, 'err');
    } finally {
      btn.classList.remove('spin');
    }
  };

  const themeBtn = $('#themeBtn');
  const savedTheme = localStorage.getItem('novatv:theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  themeBtn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('novatv:theme', next);
  };

  window.addEventListener('scroll', () => {
    $('.topbar')?.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  route();
})();
