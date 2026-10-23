/* NovaTV 播放器：HLS(hls.js) / FLV(mpegts.js) / MP4(native) 三引擎自适应
   设计参考 TVBox 的"多线路 + 多解析"思路：地址先探测类型，再选引擎，失败自动降级 */
(function () {
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return (h > 0 ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
  };

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m17 9 5 6M22 9l-5 6"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/></svg>',
    exitFull: '<svg viewBox="0 0 24 24"><path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M5 5l10 7-10 7z" fill="currentColor" stroke="none"/><path d="M19 5v14"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M19 5 9 12l10 7z" fill="currentColor" stroke="none"/><path d="M5 5v14"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"/></svg>',
  };

  class NovaPlayer {
    constructor(layer) {
      this.layer = layer;
      this.state = null;
      this.idleTimer = null;
      this.volume = Number(localStorage.getItem('novatv:volume') || 0.8);
      this.rate = 1;
      this.build();
      document.addEventListener('keydown', (e) => this.onKey(e));
    }

    build() {
      this.layer.innerHTML = `
        <div class="player-backdrop"></div>
        <div class="player-box" id="pBox">
          <video id="pVideo" playsinline crossorigin="anonymous"></video>
          <div class="p-top">
            <button class="p-icon-btn" id="pBack" title="返回">${ICON.back}</button>
            <div style="min-width:0">
              <div class="t" id="pTitle">—</div>
              <div class="sub" id="pSub"></div>
            </div>
            <button class="p-icon-btn p-close" id="pClose" title="关闭 (Esc)">${ICON.close}</button>
          </div>
          <div class="p-msg" id="pMsg"><div class="inner"><div class="spin"></div><p>正在加载…</p></div></div>
          <div class="p-bottom">
            <div class="p-progress" id="pProgress">
              <div class="track"><div class="buf" id="pBuf"></div><div class="fill" id="pFill"></div></div>
              <div class="knob" id="pKnob"></div>
            </div>
            <div class="p-controls">
              <button class="p-icon-btn" id="pPlay" title="播放/暂停 (空格)">${ICON.play}</button>
              <button class="p-icon-btn" id="pPrev" title="上一集">${ICON.prev}</button>
              <button class="p-icon-btn" id="pNext" title="下一集">${ICON.next}</button>
              <span class="time" id="pTime">00:00 / 00:00</span>
              <div class="spacer"></div>
              <button class="p-icon-btn" id="pMute">${ICON.volume}</button>
              <select class="p-select" id="pRate" title="倍速">
                ${[0.75, 1, 1.25, 1.5, 2].map((r) => `<option value="${r}" ${r === 1 ? 'selected' : ''}>${r}×</option>`).join('')}
              </select>
              <button class="p-icon-btn" id="pList" title="剧集">${ICON.list}</button>
              <button class="p-icon-btn" id="pFull" title="全屏 (F)">${ICON.full}</button>
            </div>
          </div>
          <div class="p-episodes" id="pEps"><h5>选集</h5><div class="p-ep-list" id="pEpList"></div></div>
        </div>`;

      const $ = (id) => this.layer.querySelector('#' + id);
      this.el = {
        box: $('pBox'), video: $('pVideo'), title: $('pTitle'), sub: $('pSub'), msg: $('pMsg'),
        progress: $('pProgress'), fill: $('pFill'), buf: $('pBuf'), knob: $('pKnob'), time: $('pTime'),
        play: $('pPlay'), mute: $('pMute'), full: $('pFull'), eps: $('pEps'), epList: $('pEpList'),
        rate: $('pRate'), list: $('pList'), next: $('pNext'), prev: $('pPrev'), back: $('pBack'), close: $('pClose'),
      };
      const v = this.el.video;
      v.volume = this.volume;

      this.el.back.onclick = () => this.close();
      this.el.close.onclick = () => this.close();
      this.layer.querySelector('.player-backdrop').onclick = () => this.close();
      this.el.play.onclick = () => this.toggle();
      v.onclick = () => this.toggle();
      v.ondblclick = () => this.toggleFull();
      this.el.mute.onclick = () => this.toggleMute();
      this.el.full.onclick = () => this.toggleFull();
      this.el.list.onclick = () => this.el.eps.classList.toggle('open');
      this.el.rate.onchange = () => {
        this.rate = Number(this.el.rate.value);
        v.playbackRate = this.rate;
      };
      this.el.next.onclick = () => this.step(1);
      this.el.prev.onclick = () => this.step(-1);

      v.addEventListener('timeupdate', () => this.syncProgress());
      v.addEventListener('progress', () => this.syncBuffer());
      v.addEventListener('durationchange', () => this.syncProgress());
      v.addEventListener('play', () => {
        this.el.play.innerHTML = ICON.pause;
        this.startIdle();
      });
      v.addEventListener('pause', () => {
        this.el.play.innerHTML = ICON.play;
        this.clearIdle();
        this.saveProgress();
      });
      v.addEventListener('ended', () => this.step(1));
      v.addEventListener('error', () => {
        if (this.state && !this.state.live) this.showMsg('播放出错', '该地址可能已失效，试试切换线路或选集', true);
      });
      v.addEventListener('waiting', () => this.showMsg(null));
      v.addEventListener('loadedmetadata', () => this.showMsg(null));
      v.addEventListener('canplay', () => this.showMsg(null));
      v.addEventListener('playing', () => {
        this.showMsg(null);
        this.el.box.classList.remove('idle');
      });

      this.el.progress.onclick = (e) => {
        if (!this.state || this.state.live) return;
        const r = this.el.progress.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        this.el.video.currentTime = p * (this.el.video.duration || 0);
      };
      this.layer.onmousemove = () => this.startIdle();
    }

    /* ---------- 对外入口 ---------- */
    async open(payload) {
      // payload: { title, sub, site, id, flag, routes, epIndex, poster, live }
      this.state = { ...payload, epIndex: payload.epIndex || 0 };
      this.layer.hidden = false;
      document.body.style.overflow = 'hidden';
      this.renderEpisodes();
      this.el.title.textContent = payload.title || '正在播放';
      this.el.sub.textContent = payload.sub || '';
      await this.load();
    }

    renderEpisodes() {
      const s = this.state;
      const hasEp = s.routes && s.routes.length;
      this.el.list.style.display = hasEp ? '' : 'none';
      this.el.next.style.display = hasEp ? '' : 'none';
      this.el.prev.style.display = hasEp ? '' : 'none';
      if (!hasEp) return;
      const eps = this.currentEpisodes();
      this.el.epList.innerHTML = eps
        .map((e, i) => `<button class="p-ep ${i === s.epIndex ? 'on' : ''}" data-i="${i}">${escapeHtml(e.name || '第' + (i + 1) + '集')}</button>`)
        .join('');
      this.el.epList.querySelectorAll('.p-ep').forEach((b) => {
        b.onclick = () => {
          this.state.epIndex = Number(b.dataset.i);
          this.renderEpisodes();
          this.load();
        };
      });
    }

    currentEpisodes() {
      const s = this.state;
      if (!s?.routes?.length) return [];
      const r = s.routes.find((x) => x.flag === s.flag) || s.routes[0];
      s.flag = r.flag;
      return r.episodes || [];
    }

    async step(dir) {
      const eps = this.currentEpisodes();
      const i = this.state.epIndex + dir;
      if (i < 0 || i >= eps.length) {
        if (dir > 0) toast('已经是最后一集了');
        return;
      }
      this.state.epIndex = i;
      this.renderEpisodes();
      await this.load();
    }

    /* ---------- 加载与引擎选择 ---------- */
    async load() {
      const s = this.state;
      this.destroyEngine();
      this.showMsg('正在解析播放地址…', '', true);
      try {
        let url, type, title;
        if (s.direct) {
          url = s.direct;
          type = s.live ? 'live' : '';
        } else {
          const q = new URLSearchParams({ site: s.site, id: s.id, flag: s.flag || '', ep: String(s.epIndex) });
          const r = await fetch('/api/play?' + q).then((x) => x.json());
          if (r.error) throw new Error(r.error);
          url = r.proxyUrl || r.url;
          type = r.type;
          title = r.title;
          if (r.needParse) {
            this.showMsg('需要解析接口', r.message, true);
            return;
          }
        }

        const eps = this.currentEpisodes();
        const epName = eps[s.epIndex]?.name || title || '';
        this.el.sub.textContent = [s.siteName, s.flag, epName].filter(Boolean).join(' · ');

        if (!type || type === 'unknown' || s.live) {
          const probe = await fetch('/api/probe?url=' + encodeURIComponent(s.rawUrl || s.direct || '')).then((x) => x.json()).catch(() => ({}));
          if (probe.type && probe.type !== 'error') type = probe.type;
          else if (s.live) type = 'flv';
        }
        const isLive = Boolean(s.live);
        this.state.live = isLive || /live/.test(type || '');
        this.el.progress.style.visibility = this.state.live ? 'hidden' : '';

        await this.attach(url, type);
      } catch (e) {
        this.showMsg('播放失败', e.message, true);
      }
    }

    async attach(url, type) {
      const v = this.el.video;
      const hlsUrl = url.includes('/api/proxy') ? url : '/api/proxy?url=' + encodeURIComponent(url);

      if (type === 'hls' || /\.m3u8/i.test(url)) {
        if (window.Hls && window.Hls.isSupported()) {
          this.engine = new window.Hls({
            lowLatencyMode: true,
            maxBufferLength: this.state.live ? 20 : 40,
            manifestLoadingTimeOut: 15000,
          });
          this.engine.on(window.Hls.Events.ERROR, (_, d) => {
            if (d.fatal) this.showMsg('播放出错', 'HLS 加载失败：' + (d.details || '未知错误') + '，可换线路重试', true);
          });
          this.engine.loadSource(hlsUrl);
          this.engine.attachMedia(v);
          this.engine.on(window.Hls.Events.MANIFEST_PARSED, () => {
            this.showMsg(null);
            this.play();
          });
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
          v.src = hlsUrl;
          this.play();
        } else {
          this.showMsg('浏览器不支持 HLS', '请更换 Chrome/Edge 等现代浏览器', true);
        }
        return;
      }

      if (type === 'flv' || /\.flv/i.test(url)) {
        if (!window.mpegts || !window.mpegts.isSupported()) {
          this.showMsg('浏览器不支持 FLV', '该直播源是 FLV 流，需要 mpegts.js（已内置，若仍失败请换源）', true);
          return;
        }
        this.engine = window.mpegts.createPlayer(
          { type: 'flv', url: hlsUrl, isLive: true, hasAudio: true, hasVideo: true },
          { enableStashBuffer: false, liveBufferLatencyChasing: true, lazyLoad: false },
        );
        this.engine.attachMediaElement(v);
        this.engine.load();
        this.play();
        return;
      }

      v.src = hlsUrl;
      this.play();
    }

    play() {
      const v = this.el.video;
      v.playbackRate = this.rate;
      const p = v.play();
      if (p && p.catch) p.catch(() => this.showMsg('已暂停', '点击画面继续播放（浏览器可能拦截了自动播放）', true));
      // 续播
      const rec = readHistory(this.state.site, this.state.id);
      if (rec && !this.state.live && rec.epIndex === this.state.epIndex && rec.position > 15) {
        v.currentTime = rec.position;
        toast('已续播至 ' + fmt(rec.position));
      }
    }

    toggle() {
      const v = this.el.video;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }

    toggleMute() {
      const v = this.el.video;
      v.muted = !v.muted;
      this.el.mute.innerHTML = v.muted ? ICON.mute : ICON.volume;
    }

    toggleFull() {
      const box = this.el.box;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (box.requestFullscreen) box.requestFullscreen();
      setTimeout(() => {
        this.el.full.innerHTML = document.fullscreenElement ? ICON.exitFull : ICON.full;
      }, 120);
    }

    syncProgress() {
      const v = this.el.video;
      if (!v.duration || !isFinite(v.duration)) {
        this.el.time.textContent = this.state?.live ? 'LIVE' : '00:00 / 00:00';
        return;
      }
      const p = v.currentTime / v.duration;
      this.el.fill.style.width = p * 100 + '%';
      this.el.knob.style.left = p * 100 + '%';
      this.el.time.textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration);
    }

    syncBuffer() {
      const v = this.el.video;
      if (!v.buffered.length || !v.duration) return;
      const end = v.buffered.end(v.buffered.length - 1);
      this.el.buf.style.width = Math.min(100, (end / v.duration) * 100) + '%';
    }

    showMsg(title, text, spinner) {
      const m = this.el.msg;
      if (!title) {
        m.hidden = true;
        return;
      }
      m.hidden = false;
      m.innerHTML = `<div class="inner">${spinner ? '<div class="spin"></div>' : ''}<h4>${escapeHtml(title)}</h4>${text ? `<p>${escapeHtml(text)}</p>` : ''}</div>`;
    }

    /* ---------- 播放进度持久化 ---------- */
    saveProgress() {
      const v = this.el.video;
      const s = this.state;
      if (!s || s.live || !v.duration || !isFinite(v.duration) || v.currentTime < 5) return;
      if (v.currentTime / v.duration > 0.95) {
        clearHistory(s.site, s.id);
        return;
      }
      writeHistory(s.site, s.id, {
        title: s.title, poster: s.poster, site: s.site, id: s.id,
        flag: s.flag, epIndex: s.epIndex, position: v.currentTime, duration: v.duration, at: Date.now(),
      });
    }

    startIdle() {
      clearTimeout(this.idleTimer);
      this.el.box.classList.remove('idle');
      this.idleTimer = setTimeout(() => {
        if (!this.el.video.paused) this.el.box.classList.add('idle');
      }, 2800);
    }
    clearIdle() {
      clearTimeout(this.idleTimer);
      this.el.box.classList.remove('idle');
    }

    onKey(e) {
      if (this.layer.hidden) return;
      const v = this.el.video;
      if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
      else if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowRight') { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); }
      else if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - 10); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); }
      else if (e.key === 'f' || e.key === 'F') this.toggleFull();
      this.startIdle();
    }

    destroyEngine() {
      if (this.engine) {
        try {
          if (this.engine.destroy) this.engine.destroy();
        } catch { /* noop */ }
        this.engine = null;
      }
      const v = this.el.video;
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch { /* noop */ }
    }

    close() {
      this.saveProgress();
      this.destroyEngine();
      this.el.eps.classList.remove('open');
      this.layer.hidden = true;
      document.body.style.overflow = '';
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (this.state && !this.state.live) document.dispatchEvent(new CustomEvent('novatv:history'));
    }
  }

  /* ---------- 进度存取 ---------- */
  function readHistory(site, id) {
    try {
      const all = JSON.parse(localStorage.getItem('novatv:history') || '{}');
      return all[site + ':' + id] || null;
    } catch {
      return null;
    }
  }
  function writeHistory(site, id, data) {
    try {
      const all = JSON.parse(localStorage.getItem('novatv:history') || '{}');
      all[site + ':' + id] = data;
      const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 60);
      const trimmed = {};
      keys.forEach((k) => (trimmed[k] = all[k]));
      localStorage.setItem('novatv:history', JSON.stringify(trimmed));
    } catch { /* noop */ }
  }
  function clearHistory(site, id) {
    try {
      const all = JSON.parse(localStorage.getItem('novatv:history') || '{}');
      delete all[site + ':' + id];
      localStorage.setItem('novatv:history', JSON.stringify(all));
    } catch { /* noop */ }
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg) {
    document.dispatchEvent(new CustomEvent('novatv:toast', { detail: msg }));
  }

  window.NovaPlayer = NovaPlayer;
  window.__hist = { readHistory };
})();
