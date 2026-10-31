(() => {
  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const WL = globalThis.EYHWatchLaterCore;
  const watchedCache = new Map();
  const progressCache = new Map();
  let directWatchSeconds = 5;
  let watchedDisplayMode = 'dim';
  let watchedMinProgressPct = 0;
  let watchedThumbnailOpacityPct = 65;
  let watchedThumbnailGrayscale = false;
  let watchedLinkCardInfo = false;
  let pendingHistory = new Map();
  const pendingWatchLater = new Map();
  const watchLaterAutoAttempted = new Map();
  let watchLaterAutoCleanupEnabled = false;
  let watchLaterCleanupMinProgressPct = 60;
  let watchLaterCleanupInFlight = null;
  let lastAutoPageCleanupKey = '';
  let headerMountTimer = null;
  let lastCleanupSummary = null;
  let scanTimer = null;
  let currentVideoId = null;
  let currentVideoEl = null;
  let currentVideoHandlers = null;
  let directTimer = null;
  let directRecorded = false;
  let lastProgressSent = null;
  let activeSyncInFlight = null;
  let lastActiveSyncRequestAt = 0;

  function normalizeProgressPct(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function currentVideoProgressPct(el = currentVideoEl) {
    const duration = Number(el?.duration || 0);
    const current = Number(el?.currentTime || 0);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(current) || current < 0) return null;
    return normalizeProgressPct((current / duration) * 100);
  }

  async function syncServerWhileActive({ force = false } = {}) {
    if (document.visibilityState === 'hidden') return null;
    const now = Date.now();
    if (!force && now - lastActiveSyncRequestAt < 60_000) return null;
    if (activeSyncInFlight) return activeSyncInFlight;
    lastActiveSyncRequestAt = now;
    activeSyncInFlight = chrome.runtime.sendMessage({ type: 'ACTIVE_YOUTUBE_SYNC', force })
      .then(result => {
        if (Number(result?.pulled?.imported || 0) > 0) {
          watchedCache.clear();
          progressCache.clear();
          scheduleScan();
        }
        return result;
      })
      .catch(() => null)
      .finally(() => { activeSyncInFlight = null; });
    return activeSyncInFlight;
  }

  async function loadDisplaySettings() {
    const v = await chrome.storage.local.get({
      directWatchSeconds: 5,
      watchedDisplayMode: 'dim',
      watchedMinProgressPct: 0,
      watchedThumbnailOpacityPct: 65,
      watchedThumbnailGrayscale: false,
      watchedLinkCardInfo: false,
      watchLaterAutoCleanupEnabled: false,
      watchLaterCleanupMinProgressPct: 60
    });
    directWatchSeconds = Math.max(1, Math.min(120, Number(v.directWatchSeconds) || 5));
    watchedDisplayMode = ['dim','hide','none'].includes(v.watchedDisplayMode) ? v.watchedDisplayMode : 'dim';
    watchedMinProgressPct = Math.max(0, Math.min(100, Number(v.watchedMinProgressPct) || 0));
    watchedThumbnailOpacityPct = Math.max(10, Math.min(100, Number(v.watchedThumbnailOpacityPct) || 65));
    watchedThumbnailGrayscale = Boolean(v.watchedThumbnailGrayscale);
    watchedLinkCardInfo = Boolean(v.watchedLinkCardInfo);
    watchLaterAutoCleanupEnabled = Boolean(v.watchLaterAutoCleanupEnabled);
    watchLaterCleanupMinProgressPct = Math.max(1, Math.min(100, Number(v.watchLaterCleanupMinProgressPct) || 60));
    document.documentElement.style.setProperty('--eyh-watched-opacity', String(watchedThumbnailOpacityPct / 100));
    updateHeaderControls();
  }

  function nativeProgressPct(container) {
    if (!container?.querySelector) return null;
    const progressEl = container.querySelector(
      'ytd-thumbnail-overlay-resume-playback-renderer #progress, ' +
      'yt-thumbnail-overlay-progress-bar-view-model [style*="width"], ' +
      '[class*="progress"][style*="width"], [id*="progress"][style*="width"], progress'
    );
    if (!progressEl) return null;
    const aria = normalizeProgressPct(progressEl.getAttribute?.('aria-valuenow'));
    if (aria != null) return aria;
    if (progressEl.tagName === 'PROGRESS') {
      const value = Number(progressEl.value);
      const max = Number(progressEl.max || 100);
      if (Number.isFinite(value) && Number.isFinite(max) && max > 0) return normalizeProgressPct((value / max) * 100);
    }
    const style = progressEl.getAttribute?.('style') || '';
    const m = style.match(/width\s*:\s*([0-9.]+)%/i);
    if (m) return normalizeProgressPct(m[1]);
    const width = parseFloat(getComputedStyle(progressEl).width);
    const parentWidth = parseFloat(getComputedStyle(progressEl.parentElement).width);
    if (Number.isFinite(width) && Number.isFinite(parentWidth) && parentWidth > 0) return normalizeProgressPct((width / parentWidth) * 100);
    return null;
  }

  function videoIdFromUrl(raw = location.href) {
    try {
      const u = new URL(raw, location.origin);
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v');
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
      }
      const m = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
      return m?.[1] || null;
    } catch { return null; }
  }

  function titleAndChannel() {
    const title = document.querySelector('h1 yt-formatted-string, h1.title, #title h1')?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, '').trim() || null;
    const channelName = document.querySelector('ytd-watch-metadata #channel-name a, #owner #channel-name a, ytd-channel-name a')?.textContent?.trim() || null;
    const channelHref = document.querySelector('ytd-watch-metadata #channel-name a, #owner #channel-name a, ytd-channel-name a')?.getAttribute('href') || '';
    const channelId = channelHref.match(/^\/channel\/(UC[A-Za-z0-9_-]+)/)?.[1] || null;
    return { title, channelName, channelId };
  }

  async function recordDirectWatch(videoId) {
    if (!videoId || videoId !== videoIdFromUrl() || directRecorded) return;
    directRecorded = true;
    const meta = titleAndChannel();
    const watchedAt = Date.now();
    const progressPct = currentVideoProgressPct();
    await chrome.runtime.sendMessage({
      type: 'UPSERT_WATCH',
      records: [{ videoId, ...meta, source: 'pc-direct', preciseWatchedAt: watchedAt, discoveredAt: watchedAt, historyDateLabel: null, maxProgressPct: progressPct }],
      events: [{ eventId: `pc-direct:${crypto.randomUUID()}`, videoId, ...meta, source: 'pc-direct', watchedAt, discoveredAt: watchedAt, historyDateLabel: null }]
    });
    watchedCache.set(videoId, true);
    if (progressPct != null) { progressCache.set(videoId, progressPct); lastProgressSent = progressPct; }
    scheduleScan();
  }

  function unbindVideoWatcher() {
    clearTimeout(directTimer);
    directTimer = null;
    if (currentVideoEl && currentVideoHandlers) {
      currentVideoEl.removeEventListener('timeupdate', currentVideoHandlers.onTime);
      currentVideoEl.removeEventListener('playing', currentVideoHandlers.onTime);
      currentVideoEl.removeEventListener('ended', currentVideoHandlers.onEnded);
    }
    currentVideoHandlers = null;
  }

  async function bindVideoWatcher() {
    const vid = videoIdFromUrl();
    if (!vid) {
      unbindVideoWatcher();
      currentVideoId = null; currentVideoEl = null; directRecorded = false; lastProgressSent = null;
      return;
    }
    const el = document.querySelector('video.html5-main-video, video');
    if (!el || (currentVideoId === vid && currentVideoEl === el && currentVideoHandlers)) return;

    // YouTube commonly reuses the same <video> element across SPA navigations. Always detach the
    // previous handlers before binding the new video id so long sessions cannot accumulate inert
    // timeupdate/playing/ended closures on one media element.
    unbindVideoWatcher();
    currentVideoId = vid; currentVideoEl = el; directRecorded = false; lastProgressSent = null;

    const maybeRecord = async () => {
      if (currentVideoId !== vid || currentVideoEl !== el) return;
      if (!el.paused && Number(el.currentTime || 0) >= directWatchSeconds) await recordDirectWatch(vid).catch(() => {});
      if (directRecorded) {
        const pct = currentVideoProgressPct(el);
        if (pct != null && (lastProgressSent == null || pct >= lastProgressSent + 5 || pct >= 99.5)) {
          lastProgressSent = pct;
          progressCache.set(vid, Math.max(progressCache.get(vid) ?? 0, pct));
          chrome.runtime.sendMessage({ type: 'UPDATE_PROGRESS', entries: [{ videoId: vid, progressPct: pct }] }).catch(() => {});
          maybeAutoRemoveCurrentFromWatchLater(vid, pct).catch(() => {});
        }
      }
    };
    const onTime = () => maybeRecord().catch(() => {});
    const onEnded = () => {
      if (currentVideoId === vid && currentVideoEl === el) {
        lastProgressSent = 100; progressCache.set(vid, 100);
        chrome.runtime.sendMessage({ type: 'UPDATE_PROGRESS', entries: [{ videoId: vid, progressPct: 100 }] }).catch(() => {});
        maybeAutoRemoveCurrentFromWatchLater(vid, 100).catch(() => {}); scheduleScan();
      }
    };
    currentVideoHandlers = { onTime, onEnded };
    el.addEventListener('timeupdate', onTime, { passive: true });
    el.addEventListener('playing', onTime, { passive: true });
    el.addEventListener('ended', onEnded, { passive: true });
    directTimer = setTimeout(() => maybeRecord().catch(() => {}), 7000);
  }

  function idFromAnchor(a) {
    const href = a?.getAttribute?.('href');
    if (!href) return null;
    return videoIdFromUrl(new URL(href, location.origin).href);
  }

  function candidateContainer(a) {
    return a.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-rich-grid-media, ytd-thumbnail') || a.parentElement;
  }

  async function scanAndMark() {
    scanTimer = null;
    const map = new Map();
    for (const a of document.querySelectorAll('a[href*="watch?v="], a[href^="/shorts/"]')) {
      const id = idFromAnchor(a); if (!id) continue; if (!map.has(id)) map.set(id, []); map.get(id).push(a);
    }
    const unknown = [...map.keys()].filter(id => !watchedCache.has(id));
    if (unknown.length) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: unknown });
        for (const id of unknown) { watchedCache.set(id, Boolean(resp?.watched?.[id])); progressCache.set(id, normalizeProgressPct(resp?.progress?.[id])); }
      } catch {}
    }
    for (const [id, anchors] of map) {
      const watched = watchedCache.get(id) === true;
      for (const a of anchors) {
        const c = candidateContainer(a); if (!c) continue;
        const storedProgress = normalizeProgressPct(progressCache.get(id));
        // Native progress probing can fall back to getComputedStyle(), which may require layout.
        // Skip it completely when no threshold is configured, or when the cached ledger progress
        // already satisfies the threshold. Presentation remains identical in both cases.
        const needsNativeProgress = watchedMinProgressPct > 0 && (storedProgress == null || storedProgress < watchedMinProgressPct);
        const cardProgress = needsNativeProgress ? nativeProgressPct(c) : null;
        const effectiveProgress = storedProgress == null ? cardProgress : (cardProgress == null ? storedProgress : Math.max(storedProgress, cardProgress));
        const matchesProgress = watchedMinProgressPct <= 0 || (effectiveProgress != null && effectiveProgress >= watchedMinProgressPct);
        const matches = watched && matchesProgress && watchedDisplayMode !== 'none';
        const dimmed = matches && watchedDisplayMode === 'dim';
        c.classList.toggle('eyh-watched', dimmed); c.classList.toggle('eyh-watched-linked', dimmed && watchedLinkCardInfo);
        c.classList.toggle('eyh-watched-grayscale', dimmed && watchedThumbnailGrayscale); c.classList.toggle('eyh-hidden', matches && watchedDisplayMode === 'hide');
        c.dataset.eyhVideoId = id;
        if (effectiveProgress != null) c.dataset.eyhProgressPct = String(Math.round(effectiveProgress)); else delete c.dataset.eyhProgressPct;
      }
    }
    bindVideoWatcher().catch(() => {});
  }

  function scheduleScan() { if (document.visibilityState === 'hidden' || scanTimer) return; scanTimer = setTimeout(scanAndMark, 650); }

  function requestWatchLater(type, payload = {}, timeoutMs = 600000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pendingWatchLater.delete(requestId); reject(new Error('Watch Later 요청 시간이 초과되었습니다. YouTube 페이지를 새로고침한 뒤 다시 시도하세요.')); }, timeoutMs);
      pendingWatchLater.set(requestId, { resolve, reject, timeout, type });
      window.postMessage({ source: CONTENT, target: PAGE, type, requestId, ...payload }, '*');
    });
  }

  function isWatchLaterPage() { return Boolean(WL?.isWatchLaterUrl?.(location.href)) && location.pathname === '/playlist'; }
  function displayModeLabel(mode) { return mode === 'hide' ? '숨김' : mode === 'none' ? '표시' : '흐림'; }

  function setHeaderStatus(text, kind = '') {
    const status = document.querySelector('#eyh-header-status'); if (!status) return;
    status.textContent = text || ''; status.dataset.kind = kind || '';
    if (text) { const token = String(Date.now()); status.dataset.token = token; setTimeout(() => { if (status.dataset.token === token) status.textContent = ''; }, kind === 'error' ? 12000 : 7000); }
  }

  function updateHeaderControls() {
    const root = document.querySelector('#eyh-header-controls'); if (!root) return;
    // v0.10.13+ gives pc-stability-controller sole ownership of the visible quick-mode state.
    // Avoid redundant class/ARIA churn from the legacy renderer once that controller is resident.
    if (document.documentElement.dataset.eyhProfileController !== '1') {
      for (const b of root.querySelectorAll('button[data-eyh-mode]')) {
        const active = b.dataset.eyhMode === watchedDisplayMode;
        b.classList.toggle('eyh-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    const cleanup = root.querySelector('#eyh-watch-later-cleanup');
    if (cleanup) { cleanup.hidden = !isWatchLaterPage(); cleanup.textContent = `${watchLaterCleanupMinProgressPct}%+ 정리`; cleanup.title = `Eternal 진행률 ${watchLaterCleanupMinProgressPct}% 이상인 나중에 볼 동영상 제거`; }
    const auto = root.querySelector('#eyh-watch-later-auto');
    if (auto) { auto.hidden = !isWatchLaterPage(); auto.textContent = watchLaterAutoCleanupEnabled ? '자동✓' : '자동'; auto.classList.toggle('eyh-active', watchLaterAutoCleanupEnabled); auto.title = watchLaterAutoCleanupEnabled ? `자동 정리 켜짐 (${watchLaterCleanupMinProgressPct}% 이상)` : '나중에 볼 동영상 자동 정리 켜기'; }
  }

  function findHeaderMount() { return document.querySelector('ytd-masthead #end, ytd-masthead #buttons, #masthead-container #end, #masthead #end'); }

  function ensureHeaderControls() {
    let root = document.querySelector('#eyh-header-controls'); const mount = findHeaderMount(); if (!mount) return false;
    if (root && root.parentElement !== mount) root.remove(); root = document.querySelector('#eyh-header-controls');
    if (!root) {
      root = document.createElement('div'); root.id = 'eyh-header-controls'; root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Eternal YouTube History');
      const brand = document.createElement('span'); brand.className = 'eyh-header-brand'; brand.textContent = 'Eternal'; root.appendChild(brand);
      for (const [mode, label] of [['none','표시'], ['dim','흐림'], ['hide','숨김']]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'eyh-header-button'; b.dataset.eyhMode = mode; b.textContent = label; b.title = `시청 영상 ${label}`;
        b.addEventListener('click', () => { watchedDisplayMode = mode; chrome.storage.local.set({ watchedDisplayMode: mode }).catch(() => {}); updateHeaderControls(); scheduleScan(); }); root.appendChild(b);
      }
      const auto = document.createElement('button'); auto.type = 'button'; auto.id = 'eyh-watch-later-auto'; auto.className = 'eyh-header-button eyh-wl-only';
      auto.addEventListener('click', async () => { watchLaterAutoCleanupEnabled = !watchLaterAutoCleanupEnabled; await chrome.storage.local.set({ watchLaterAutoCleanupEnabled }).catch(() => {}); lastAutoPageCleanupKey = ''; updateHeaderControls(); setHeaderStatus(watchLaterAutoCleanupEnabled ? 'Watch Later 자동 정리 켜짐' : '자동 정리 꺼짐'); if (watchLaterAutoCleanupEnabled) maybeAutoCleanupWatchLaterPage().catch(() => {}); }); root.appendChild(auto);
      const cleanup = document.createElement('button'); cleanup.type = 'button'; cleanup.id = 'eyh-watch-later-cleanup'; cleanup.className = 'eyh-header-button eyh-cleanup-button eyh-wl-only'; cleanup.addEventListener('click', () => cleanupWatchLater({ manual: true }).catch(error => setHeaderStatus(`정리 실패: ${error.message}`, 'error'))); root.appendChild(cleanup);
      const status = document.createElement('span'); status.id = 'eyh-header-status'; status.setAttribute('aria-live', 'polite'); root.appendChild(status); mount.prepend(root);
    }
    updateHeaderControls(); return true;
  }

  function scheduleHeaderMount() { if (headerMountTimer) return; headerMountTimer = setTimeout(() => { headerMountTimer = null; ensureHeaderControls(); }, 250); }

  async function readProgressForIds(ids) {
    const progress = {}, watched = {}; const clean = [...new Set((ids || []).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id || '')) )];
    for (let i = 0; i < clean.length; i += 400) { const chunk = clean.slice(i, i + 400); const result = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: chunk }); Object.assign(progress, result?.progress || {}); Object.assign(watched, result?.watched || {}); }
    return { progress, watched };
  }

  async function cleanupWatchLater({ manual = false } = {}) {
    if (watchLaterCleanupInFlight) return watchLaterCleanupInFlight;
    watchLaterCleanupInFlight = (async () => {
      setHeaderStatus('Watch Later 확인 중…'); await syncServerWhileActive({ force: true }).catch(() => null);
      const listed = await requestWatchLater('EYH_WL_LIST_REQUEST', { maxPages: 100 }); const entries = listed.entries || []; const ledger = await readProgressForIds(entries.map(e => e.videoId)); const progress = {};
      for (const e of entries) if (ledger.watched?.[e.videoId] === true) progress[e.videoId] = ledger.progress?.[e.videoId];
      const qualified = WL?.qualifyCleanup?.(entries, progress, watchLaterCleanupMinProgressPct) || [];
      lastCleanupSummary = { at: Date.now(), threshold: watchLaterCleanupMinProgressPct, scanned: entries.length, qualified: qualified.length, removed: 0, manual, pages: listed.pages || 0 };
      if (!qualified.length) { setHeaderStatus(`${entries.length}개 확인 · ${watchLaterCleanupMinProgressPct}%+ 대상 없음`); return { ...lastCleanupSummary, failures: [] }; }
      if (manual) {
        const preview = qualified.slice(0, 5).map(e => `${e.videoId} (${Math.round(e.progressPct)}%)`).join('\n'); const more = qualified.length > 5 ? `\n외 ${qualified.length - 5}개` : '';
        if (!confirm(`Eternal 진행률 ${watchLaterCleanupMinProgressPct}% 이상인 나중에 볼 동영상 ${qualified.length}개를 제거할까요?\n\n${preview}${more}`)) { setHeaderStatus('정리를 취소했습니다.'); return { ...lastCleanupSummary, cancelled: true, failures: [] }; }
      }
      setHeaderStatus(`${qualified.length}개 정리 중…`);
      const result = await requestWatchLater('EYH_WL_REMOVE_REQUEST', { entries: qualified.map(({ videoId, setVideoId }) => ({ videoId, setVideoId })) });
      lastCleanupSummary.removed = Number(result.removed || 0); lastCleanupSummary.failures = result.failures || []; const failCount = lastCleanupSummary.failures.length;
      setHeaderStatus(failCount ? `${lastCleanupSummary.removed}개 제거 · ${failCount}개 실패` : `${lastCleanupSummary.removed}개 제거 완료`, failCount ? 'error' : ''); scheduleScan(); return { ...lastCleanupSummary };
    })().finally(() => { watchLaterCleanupInFlight = null; updateHeaderControls(); });
    return watchLaterCleanupInFlight;
  }

  async function maybeAutoCleanupWatchLaterPage() {
    if (!watchLaterAutoCleanupEnabled || !isWatchLaterPage()) return;
    const key = `${location.pathname}?list=WL:${watchLaterCleanupMinProgressPct}`; if (lastAutoPageCleanupKey === key) return; lastAutoPageCleanupKey = key;
    try { await cleanupWatchLater({ manual: false }); } catch (error) { lastAutoPageCleanupKey = ''; setHeaderStatus(`자동 정리 실패: ${error.message}`, 'error'); }
  }

  async function maybeAutoRemoveCurrentFromWatchLater(videoId, progressPct) {
    if (!watchLaterAutoCleanupEnabled || !WL) return; const id = WL.normalizeVideoId(videoId); const pct = WL.normalizeProgressPct(progressPct); if (!id || pct == null || pct < watchLaterCleanupMinProgressPct) return;
    const previous = watchLaterAutoAttempted.get(id) || 0; if (Date.now() - previous < 30 * 60 * 1000) return; watchLaterAutoAttempted.set(id, Date.now());
    try { const result = await requestWatchLater('EYH_WL_REMOVE_ONE_REQUEST', { videoId: id }, 120000); if (Number(result.removed || 0) > 0) setHeaderStatus(`Watch Later에서 제거 (${Math.round(pct)}%)`); }
    catch (error) { watchLaterAutoAttempted.delete(id); console.debug('[Eternal] Watch Later auto-remove deferred:', error); }
  }

  async function getPageDiagnostics() {
    const bridge = await requestWatchLater('EYH_WL_DIAGNOSTIC_REQUEST', {}, 15000).catch(error => ({ ok: false, error: error.message }));
    return { version: '0.8.0', url: location.href, visibility: document.visibilityState, watchedDisplayMode, watchedMinProgressPct, watchedCacheSize: watchedCache.size, progressCacheSize: progressCache.size, watchLaterAutoCleanupEnabled, watchLaterCleanupMinProgressPct, isWatchLaterPage: isWatchLaterPage(), headerMounted: Boolean(document.querySelector('#eyh-header-controls')), headerMountFound: Boolean(findHeaderMount()), cleanupInFlight: Boolean(watchLaterCleanupInFlight), lastCleanupSummary, bridge: bridge?.diagnostics || bridge };
  }

  function normalizeHistoryDateLabel(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim(); if (!s) return null; const now = new Date(); const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (/^오늘$/i.test(s)) return ymd(now); if (/^어제$/i.test(s)) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); return ymd(d); }
    let m = s.match(/(?:(\d{4})\s*[.\-/년]\s*)?(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/); if (!m) return s;
    let year = m[1] ? Number(m[1]) : now.getFullYear(); const month = Number(m[2]); const day = Number(m[3]); if (!m[1]) { const candidate = new Date(year, month - 1, day); if (candidate.getTime() > now.getTime() + 7 * 86400000) year -= 1; }
    if (month < 1 || month > 12 || day < 1 || day > 31) return s; return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  function historyDateLabelFromCard(card) {
    const section = card?.closest?.('ytd-item-section-renderer'); const candidates = [section?.querySelector?.('ytd-item-section-header-renderer #title'), section?.querySelector?.('ytd-item-section-header-renderer yt-formatted-string'), section?.querySelector?.('#header ytd-item-section-header-renderer'), section?.querySelector?.(':scope > #header #title')];
    for (const el of candidates) { const t = el?.textContent?.trim(); if (t) return normalizeHistoryDateLabel(t); } return null;
  }

  function historyDomRecordFromCard(card) {
    if (!card?.querySelector) return null;
    const a = card.querySelector('a#thumbnail[href*="watch?v="], a[href*="watch?v="], a[href*="/shorts/"]'); const videoId = idFromAnchor(a); if (!videoId) return null;
    const title = card.querySelector('#video-title, a#video-title, yt-formatted-string#video-title, h3 a, .yt-lockup-metadata-view-model__title')?.textContent?.trim() || a?.getAttribute('title')?.trim() || null;
    const channelAnchor = card.querySelector('ytd-channel-name a, #channel-name a, #metadata a[href^="/@"], #metadata a[href^="/channel/"]'); const channelName = channelAnchor?.textContent?.trim() || null; const channelHref = channelAnchor?.getAttribute('href') || ''; const channelId = channelHref.match(/^\/channel\/(UC[A-Za-z0-9_-]+)/)?.[1] || null;
    return { videoId, title, channelName, channelId, historyDateLabel: historyDateLabelFromCard(card), maxProgressPct: nativeProgressPct(card) };
  }

  function scrapeHistoryDom() {
    if (!location.pathname.startsWith('/feed/history')) return []; const out = []; const seen = new Set(); const root = document.querySelector('ytd-browse[page-subtype="history"], ytd-browse') || document;
    const cards = root.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-rich-item-renderer');
    for (const card of cards) { const rec = historyDomRecordFromCard(card); if (!rec || seen.has(rec.videoId)) continue; seen.add(rec.videoId); out.push(rec); }
    for (const a of root.querySelectorAll('a#thumbnail[href*="watch?v="], a[href*="watch?v="], a[href*="/shorts/"]')) {
      const videoId = idFromAnchor(a); if (!videoId || seen.has(videoId)) continue; seen.add(videoId); const card = candidateContainer(a);
      out.push({ videoId, title: card?.querySelector?.('#video-title, a#video-title, h3 a')?.textContent?.trim() || a.getAttribute('title')?.trim() || null, channelName: card?.querySelector?.('ytd-channel-name a, #channel-name a')?.textContent?.trim() || null, channelId: null, historyDateLabel: historyDateLabelFromCard(card), maxProgressPct: nativeProgressPct(card) });
    }
    return out;
  }

  function domSignature(records) { return (records || []).slice(0, 8).map(r => r.videoId).join('|'); }

  async function waitForHistoryDom(timeoutMs = 10000) {
    const started = Date.now(); let last = []; let lastSig = ''; let lastChangedAt = started; let firstNonEmptyAt = null;
    while (Date.now() - started < timeoutMs) {
      const current = scrapeHistoryDom(); const sig = domSignature(current); if (current.length && firstNonEmptyAt == null) firstNonEmptyAt = Date.now();
      if (sig && sig !== lastSig) { last = current; lastSig = sig; lastChangedAt = Date.now(); } else if (current.length) last = current;
      if (last.length && firstNonEmptyAt != null && Date.now() - firstNonEmptyAt >= 3500 && Date.now() - lastChangedAt >= 1000) break;
      await new Promise(r => setTimeout(r, 250));
    }
    return { records: last, waitedMs: Date.now() - started, signature: lastSig };
  }

  function requestHistory(maxPages, { useLoadedPage = false } = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pendingHistory.delete(requestId); reject(new Error('History 동기화 응답 시간이 초과되었습니다. YouTube 탭을 새로고침한 뒤 다시 시도하세요.')); }, 600000);
      pendingHistory.set(requestId, { resolve, reject, timeout }); window.postMessage({ source: CONTENT, target: PAGE, type: 'EYH_REQUEST_HISTORY', requestId, maxPages, useLoadedPage }, '*');
    });
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return; const msg = event.data; if (!msg || msg.source !== PAGE || msg.target !== CONTENT) return;
    if (msg.type === 'EYH_WL_PROGRESS') { if (msg.stage === 'list') setHeaderStatus(`Watch Later ${Number(msg.count || 0)}개 확인 중…`); if (msg.stage === 'remove') setHeaderStatus(`${Number(msg.removed || 0)}/${Number(msg.total || 0)}개 제거 중…`); return; }
    if (msg.type === 'EYH_WL_RESULT') { const p = pendingWatchLater.get(msg.requestId); if (!p) return; pendingWatchLater.delete(msg.requestId); clearTimeout(p.timeout); if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'Watch Later 요청 실패')); return; }
    if (msg.type === 'EYH_HISTORY_PROGRESS') { chrome.runtime.sendMessage({ type: 'HISTORY_PROGRESS', pages: msg.pages, count: msg.count }).catch(() => {}); return; }
    if (msg.type === 'EYH_HISTORY_RESULT') { const p = pendingHistory.get(msg.requestId); if (!p) return; pendingHistory.delete(msg.requestId); clearTimeout(p.timeout); if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'History 동기화 실패')); }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'SYNC_HISTORY') {
      (async () => {
        const useLoadedPage = Boolean(msg.useLoadedPage); const dom = useLoadedPage && location.pathname.startsWith('/feed/history') ? await waitForHistoryDom(10000) : { records: [], waitedMs: 0, signature: '' }; const result = await requestHistory(msg.maxPages || 3, { useLoadedPage }); const merged = new Map();
        for (const r of dom.records || []) if (!merged.has(r.videoId)) merged.set(r.videoId, r); for (const r of result.records || []) if (!merged.has(r.videoId)) merged.set(r.videoId, r);
        const latestRecord = dom.records?.[0] || result.latestRecord || [...merged.values()][0] || null; let latestAlreadyKnown = null;
        if (latestRecord?.videoId) { const before = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: [latestRecord.videoId] }).catch(() => null); latestAlreadyKnown = Boolean(before?.watched?.[latestRecord.videoId]); }
        const now = Date.now(); const records = [...merged.values()].map(r => ({ ...r, source: 'youtube-history', preciseWatchedAt: null, discoveredAt: now })); const stored = await chrome.runtime.sendMessage({ type: 'UPSERT_RECORDS', records });
        for (const r of records) { watchedCache.set(r.videoId, true); if (normalizeProgressPct(r.maxProgressPct) != null) progressCache.set(r.videoId, normalizeProgressPct(r.maxProgressPct)); } scheduleScan();
        return { ok: true, pages: result.pages, hasMore: result.hasMore, fetched: records.length, apiFetched: (result.records || []).length, domFetched: (dom.records || []).length, stored: stored?.stored || 0, inserted: stored?.inserted || 0, latestRecord, latestAlreadyKnown, loopDetected: Boolean(result.loopDetected), stopReason: result.stopReason || null, pageStats: result.pageStats || [], diagnostics: { pageUrl: location.href, domWaitedMs: dom.waitedMs || 0, domTop: (dom.records || []).slice(0, 3).map(r => ({ videoId: r.videoId, title: r.title || null })), apiTop: (result.records || []).slice(0, 3).map(r => ({ videoId: r.videoId, title: r.title || null })), firstApiResponseSource: result.pageStats?.[0]?.responseSource || null } };
      })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) })); return true;
    }
    if (msg?.type === 'GET_PAGE_DIAGNOSTICS') { getPageDiagnostics().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
    if (msg?.type === 'RUN_WATCH_LATER_CLEANUP') { cleanupWatchLater({ manual: Boolean(msg.manual) }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
    if (msg?.type === 'RESCAN') { watchedCache.clear(); progressCache.clear(); scheduleScan(); sendResponse({ ok: true }); }
  });

  loadDisplaySettings().then(() => { scheduleScan(); scheduleHeaderMount(); maybeAutoCleanupWatchLaterPage().catch(() => {}); }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.directWatchSeconds) {
      directWatchSeconds = Math.max(1, Math.min(120, Number(changes.directWatchSeconds.newValue) || 5));
    }
    if (changes.watchedDisplayMode || changes.watchedMinProgressPct || changes.watchedThumbnailOpacityPct || changes.watchedThumbnailGrayscale || changes.watchedLinkCardInfo || changes.watchLaterAutoCleanupEnabled || changes.watchLaterCleanupMinProgressPct) {
      // Presentation/settings changes do not invalidate the watched/progress ledger cache. Reusing
      // those maps avoids a background CHECK_WATCHED round-trip for every visible card on each click.
      loadDisplaySettings().then(() => scheduleScan()).catch(() => {});
    }
  });

  const observer = new MutationObserver(mutations => {
    if (document.visibilityState === 'hidden') return;
    for (const m of mutations) if (m.type === 'childList' && m.addedNodes.length) {
      // scanAndMark() already binds the active <video> after the debounced card pass; do not run an
      // extra document.querySelector('video') on every YouTube DOM mutation burst.
      scheduleScan(); scheduleHeaderMount(); break;
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });

  const onYoutubeNavigation = () => { scheduleScan(); scheduleHeaderMount(); updateHeaderControls(); bindVideoWatcher().catch(() => {}); syncServerWhileActive().then(() => maybeAutoCleanupWatchLaterPage()).catch(() => {}); };
  window.addEventListener('yt-navigate-finish', onYoutubeNavigation, true); window.addEventListener('popstate', onYoutubeNavigation, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { scheduleScan(); scheduleHeaderMount(); bindVideoWatcher().catch(() => {}); syncServerWhileActive().then(() => maybeAutoCleanupWatchLaterPage()).catch(() => {}); } }, true);
  scheduleScan(); scheduleHeaderMount(); bindVideoWatcher().catch(() => {}); syncServerWhileActive().then(() => maybeAutoCleanupWatchLaterPage()).catch(() => {});
})();
