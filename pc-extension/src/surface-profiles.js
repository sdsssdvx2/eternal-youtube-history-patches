(() => {
  const LABELS = {
    home: '홈', shorts: 'Shorts', watch: '영상 상세 · 관련 영상', subscriptions: '구독',
    channel: '채널', search: '검색 결과', watch_later: '나중에 볼 동영상', liked: '좋아요',
    playlists: '재생목록', playlist_detail: '재생목록 상세', history: '시청 기록',
    library: '내 페이지 · 라이브러리', other: '기타'
  };
  const CLASSES = [
    'eyh-surface-watched', 'eyh-surface-hidden',
    'eyh-surface-watched-linked', 'eyh-surface-watched-grayscale'
  ];
  let settings = null;
  let scanTimer = null;
  let scanGeneration = 0;
  let panel = null;
  let panelRestoreProfile = null;
  const watched = new Map();
  const progress = new Map();

  const clamp = v => Math.max(0, Math.min(100, Number(v) || 0));
  const normalizeProfile = p => ({
    dimEnabled: Boolean(p?.dimEnabled),
    hideEnabled: Boolean(p?.hideEnabled),
    linkedThresholds: p?.linkedThresholds !== false,
    sharedThreshold: clamp(p?.sharedThreshold),
    dimThreshold: clamp(p?.dimThreshold),
    hideThreshold: clamp(p?.hideThreshold)
  });

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }

  async function storageGet(defaults) {
    if (!extensionAlive()) return defaults;
    try { return await chrome.storage.local.get(defaults); } catch { return defaults; }
  }

  async function storageSet(values) {
    if (!extensionAlive()) return false;
    try { await chrome.storage.local.set(values); return true; } catch { return false; }
  }

  async function runtimeMessage(message) {
    if (!extensionAlive()) return null;
    try { return await chrome.runtime.sendMessage(message); } catch { return null; }
  }

  function legacyProfile(v) {
    const mode = ['dim', 'hide', 'none'].includes(v.watchedDisplayMode) ? v.watchedDisplayMode : 'dim';
    const threshold = clamp(v.watchedMinProgressPct);
    return normalizeProfile({
      dimEnabled: mode === 'dim', hideEnabled: mode === 'hide', linkedThresholds: true,
      sharedThreshold: threshold, dimThreshold: threshold, hideThreshold: threshold
    });
  }

  async function loadSettings() {
    const defaults = {
      watchedDisplayMode: 'dim', watchedMinProgressPct: 0,
      watchedThumbnailOpacityPct: 65, watchedThumbnailGrayscale: false, watchedLinkCardInfo: false,
      watchedSurfaceDefaultProfile: null, watchedSurfaceProfiles: {}
    };
    const v = await storageGet(defaults);
    let defaultProfile = v.watchedSurfaceDefaultProfile ? normalizeProfile(v.watchedSurfaceDefaultProfile) : null;
    if (!defaultProfile) {
      defaultProfile = legacyProfile(v);
      await storageSet({ watchedSurfaceDefaultProfile: defaultProfile });
    }
    // Keep the stable legacy content script for History/Watch Later/sync duties, but disable only
    // its old card renderer. surface-profiles.js owns presentation with its own CSS class namespace.
    if (v.watchedDisplayMode !== 'none') await storageSet({ watchedDisplayMode: 'none' });
    settings = {
      defaultProfile,
      profiles: v.watchedSurfaceProfiles && typeof v.watchedSurfaceProfiles === 'object' ? v.watchedSurfaceProfiles : {},
      opacity: Math.max(10, Math.min(100, Number(v.watchedThumbnailOpacityPct) || 65)),
      grayscale: Boolean(v.watchedThumbnailGrayscale),
      linkedCardInfo: Boolean(v.watchedLinkCardInfo)
    };
    document.documentElement.style.setProperty('--eyh-watched-opacity', String(settings.opacity / 100));
  }

  function surfaceKey() {
    const p = location.pathname;
    const q = new URLSearchParams(location.search);
    if (p.startsWith('/shorts/')) return 'shorts';
    if (p === '/watch') return 'watch';
    if (p === '/results') return 'search';
    if (p.startsWith('/feed/subscriptions')) return 'subscriptions';
    if (p.startsWith('/feed/history')) return 'history';
    if (p.startsWith('/feed/playlists')) return 'playlists';
    if (p === '/feed/you' || p.startsWith('/feed/library')) return 'library';
    if (p === '/playlist') {
      const list = q.get('list') || '';
      if (list === 'WL') return 'watch_later';
      if (list === 'LL') return 'liked';
      return 'playlist_detail';
    }
    if (/^\/(?:@[^/]+|channel\/|c\/|user\/)/.test(p)) return 'channel';
    if (p === '/' || p === '') return 'home';
    return 'other';
  }

  function hasOverride(key = surfaceKey()) {
    return Boolean(settings?.profiles && Object.prototype.hasOwnProperty.call(settings.profiles, key));
  }

  function currentProfile(key = surfaceKey()) {
    return normalizeProfile(hasOverride(key) ? settings.profiles[key] : settings?.defaultProfile || {});
  }

  function effectiveThresholds(profile) {
    return {
      dim: profile.linkedThresholds ? profile.sharedThreshold : profile.dimThreshold,
      hide: profile.linkedThresholds ? profile.sharedThreshold : profile.hideThreshold
    };
  }

  function videoIdFromHref(href) {
    try {
      const u = new URL(href, location.origin);
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v');
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
      }
      const m = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
      return m?.[1] || null;
    } catch { return null; }
  }

  function containerFor(a) {
    return a.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-rich-grid-media, ytd-thumbnail') || a.parentElement;
  }

  function nativeProgressPct(container) {
    if (!container?.querySelector) return null;
    const el = container.querySelector('ytd-thumbnail-overlay-resume-playback-renderer #progress, yt-thumbnail-overlay-progress-bar-view-model [style*="width"], [class*="progress"][style*="width"], [id*="progress"][style*="width"], progress');
    if (!el) return null;
    const aria = Number(el.getAttribute?.('aria-valuenow'));
    if (Number.isFinite(aria)) return clamp(aria);
    if (el.tagName === 'PROGRESS') {
      const value = Number(el.value), max = Number(el.max || 100);
      if (Number.isFinite(value) && Number.isFinite(max) && max > 0) return clamp(value / max * 100);
    }
    const m = (el.getAttribute?.('style') || '').match(/width\s*:\s*([0-9.]+)%/i);
    return m ? clamp(m[1]) : null;
  }

  function matchesThreshold(isWatched, pct, threshold) {
    return isWatched && (threshold <= 0 || (pct != null && pct >= threshold));
  }

  function clearManagedElement(el) {
    for (const cls of CLASSES) el.classList.remove(cls);
    delete el.dataset.eyhSurfaceManaged;
    delete el.dataset.eyhSurface;
  }

  function clearAllManaged() {
    for (const el of document.querySelectorAll('[data-eyh-surface-managed="1"]')) clearManagedElement(el);
  }

  async function scan() {
    scanTimer = null;
    const generation = ++scanGeneration;
    if (!settings) await loadSettings().catch(() => {});
    if (!settings || generation !== scanGeneration) return;

    const key = surfaceKey();
    // The full-screen Shorts player has no recommendation-card surface that benefits from Eternal
    // dim/hide presentation. Keep the page completely untouched and remove any style left by the
    // preceding SPA surface before rendering the compact header state.
    if (key === 'shorts') {
      clearAllManaged();
      closePanel({ restorePreview: true });
      decorateHeader();
      return;
    }

    const profile = currentProfile(key);
    const thresholds = effectiveThresholds(profile);
    const map = new Map();
    const managedNow = new Set();
    for (const a of document.querySelectorAll('a[href*="watch?v="], a[href^="/shorts/"]')) {
      const id = videoIdFromHref(a.getAttribute('href')); if (!id) continue;
      if (!map.has(id)) map.set(id, []); map.get(id).push(a);
    }
    const missing = [...map.keys()].filter(id => !watched.has(id));
    for (let i = 0; i < missing.length; i += 400) {
      const ids = missing.slice(i, i + 400);
      const r = await runtimeMessage({ type: 'CHECK_WATCHED', ids });
      if (generation !== scanGeneration || key !== surfaceKey()) { scheduleScan(0); return; }
      for (const id of ids) {
        watched.set(id, Boolean(r?.watched?.[id]));
        const n = Number(r?.progress?.[id]); progress.set(id, Number.isFinite(n) ? clamp(n) : null);
      }
    }

    if (generation !== scanGeneration || key !== surfaceKey()) return;
    for (const [id, anchors] of map) {
      for (const a of anchors) {
        const c = containerFor(a); if (!c) continue;
        managedNow.add(c);
        const stored = progress.get(id); const native = nativeProgressPct(c);
        const pct = stored == null ? native : native == null ? stored : Math.max(stored, native);
        const isWatched = watched.get(id) === true;
        const hide = profile.hideEnabled && matchesThreshold(isWatched, pct, thresholds.hide);
        const dim = !hide && profile.dimEnabled && matchesThreshold(isWatched, pct, thresholds.dim);
        c.classList.toggle('eyh-surface-hidden', hide);
        c.classList.toggle('eyh-surface-watched', dim);
        c.classList.toggle('eyh-surface-watched-linked', dim && settings.linkedCardInfo);
        c.classList.toggle('eyh-surface-watched-grayscale', dim && settings.grayscale);
        c.dataset.eyhSurfaceManaged = '1';
        c.dataset.eyhSurface = key;
        c.dataset.eyhVideoId = id;
        if (pct != null) c.dataset.eyhProgressPct = String(Math.round(pct)); else delete c.dataset.eyhProgressPct;
      }
    }
    for (const old of document.querySelectorAll('[data-eyh-surface-managed="1"]')) {
      if (!managedNow.has(old)) clearManagedElement(old);
    }
    decorateHeader();
  }

  function scheduleScan(delay = 80) {
    if (document.visibilityState === 'hidden') return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  function decorateHeader() {
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return;
    for (const b of root.querySelectorAll('button[data-eyh-mode]')) b.hidden = true;
    const brand = root.querySelector('.eyh-header-brand'); if (brand) brand.hidden = true;

    const key = surfaceKey();
    let button = root.querySelector('#eyh-surface-settings');
    if (key === 'shorts') {
      button?.remove();
      closePanel({ restorePreview: true });
      return;
    }

    if (!button) {
      button = document.createElement('button');
      button.id = 'eyh-surface-settings'; button.type = 'button';
      button.className = 'eyh-header-button eyh-active eyh-surface-compact';
      button.textContent = '⚙';
      button.addEventListener('click', () => { if (extensionAlive()) openPanel(); });
      root.insertBefore(button, root.querySelector('.eyh-wl-only') || root.querySelector('#eyh-header-status'));
    }
    const p = currentProfile(key), t = effectiveThresholds(p);
    const states = [];
    if (p.dimEnabled) states.push(`흐림 ${t.dim}%`);
    if (p.hideEnabled) states.push(`숨김 ${t.hide}%`);
    button.textContent = '⚙';
    button.title = `${LABELS[key] || LABELS.other} 설정 · ${hasOverride(key) ? '개별 설정' : '공통 기본값 사용'} · ${states.join(' / ') || '표시 변경 없음'}`;
    button.setAttribute('aria-label', button.title);
  }

  function field(label, input) {
    const row = document.createElement('label'); row.className = 'eyh-surface-row';
    const span = document.createElement('span'); span.textContent = label; row.append(span, input); return row;
  }
  function checkbox(checked) { const x = document.createElement('input'); x.type = 'checkbox'; x.checked = checked; return x; }
  function number(value) { const x = document.createElement('input'); x.type = 'number'; x.min = '0'; x.max = '100'; x.step = '1'; x.value = String(clamp(value)); return x; }

  function closePanel({ restorePreview = false } = {}) {
    if (restorePreview && panelRestoreProfile && settings) {
      const { key, hadOverride, profile } = panelRestoreProfile;
      const profiles = { ...(settings.profiles || {}) };
      if (hadOverride) profiles[key] = profile; else delete profiles[key];
      settings.profiles = profiles;
      scanGeneration++;
      scheduleScan(0);
    }
    panel?.remove(); panel = null; panelRestoreProfile = null;
  }

  function previewProfile(key, profile) {
    settings.profiles = { ...(settings.profiles || {}), [key]: normalizeProfile(profile) };
    scanGeneration++;
    scheduleScan(0);
  }

  function openPanel() {
    closePanel({ restorePreview: true });
    if (!settings) return;
    const key = surfaceKey();
    if (key === 'shorts') return;
    const initial = currentProfile(key), hadOverride = hasOverride(key);
    panelRestoreProfile = { key, hadOverride, profile: initial };
    panel = document.createElement('div'); panel.id = 'eyh-surface-panel';
    const title = document.createElement('strong'); title.textContent = LABELS[key] || LABELS.other; panel.append(title);
    const note = document.createElement('div'); note.className = 'eyh-surface-note';
    note.textContent = hadOverride
      ? '이 페이지의 개별 설정입니다. 두 조건을 모두 만족하면 숨김이 우선합니다.'
      : '현재 공통 기본값을 미리 보여줍니다. 적용하면 이 페이지의 개별 설정이 됩니다.';
    panel.append(note);

    const dim = checkbox(initial.dimEnabled), hide = checkbox(initial.hideEnabled), linked = checkbox(initial.linkedThresholds);
    const shared = number(initial.sharedThreshold), dimPct = number(initial.dimThreshold), hidePct = number(initial.hideThreshold);
    panel.append(field('흐리게', dim), field('숨기기', hide), field('진행률 기준 같이 사용', linked));
    const sharedRow = field('공통 최소 진행률 (%)', shared), dimRow = field('흐림 최소 진행률 (%)', dimPct), hideRow = field('숨김 최소 진행률 (%)', hidePct);
    panel.append(sharedRow, dimRow, hideRow);
    const refreshRows = () => { sharedRow.hidden = !linked.checked; dimRow.hidden = linked.checked; hideRow.hidden = linked.checked; };
    const readForm = () => normalizeProfile({
      dimEnabled: dim.checked, hideEnabled: hide.checked, linkedThresholds: linked.checked,
      sharedThreshold: shared.value, dimThreshold: dimPct.value, hideThreshold: hidePct.value
    });
    const preview = () => { refreshRows(); previewProfile(key, readForm()); };
    linked.addEventListener('change', preview); dim.addEventListener('change', preview); hide.addEventListener('change', preview);
    for (const input of [shared, dimPct, hidePct]) input.addEventListener('input', preview);
    refreshRows();

    const actions = document.createElement('div'); actions.className = 'eyh-surface-actions';
    const reset = document.createElement('button'); reset.textContent = '기본값 사용';
    const cancel = document.createElement('button'); cancel.textContent = '취소';
    const save = document.createElement('button'); save.textContent = '적용'; save.className = 'primary';
    actions.append(reset, cancel, save); panel.append(actions); document.body.append(panel);
    cancel.addEventListener('click', () => closePanel({ restorePreview: true }));
    reset.addEventListener('click', async () => {
      const profiles = { ...(settings.profiles || {}) }; delete profiles[key];
      if (await storageSet({ watchedSurfaceProfiles: profiles })) settings.profiles = profiles;
      closePanel(); watched.clear(); progress.clear(); scanGeneration++; scheduleScan(0);
    });
    save.addEventListener('click', async () => {
      const profile = readForm();
      const profiles = { ...(settings.profiles || {}), [key]: profile };
      if (await storageSet({ watchedSurfaceProfiles: profiles })) settings.profiles = profiles;
      closePanel(); watched.clear(); progress.clear(); scanGeneration++; scheduleScan(0);
    });
  }

  if (extensionAlive()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.watchedSurfaceProfiles || changes.watchedSurfaceDefaultProfile || changes.watchedThumbnailOpacityPct || changes.watchedThumbnailGrayscale || changes.watchedLinkCardInfo) {
        loadSettings().then(() => { watched.clear(); progress.clear(); scanGeneration++; scheduleScan(0); }).catch(() => {});
      }
    });
  }

  const observer = new MutationObserver(mutations => {
    if (mutations.some(m => m.type === 'childList' && m.addedNodes.length)) scheduleScan();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });
  const nav = () => {
    closePanel({ restorePreview: true });
    clearAllManaged(); watched.clear(); progress.clear(); scanGeneration++;
    scheduleScan(0); setTimeout(decorateHeader, 250);
  };
  window.addEventListener('yt-navigate-finish', nav, true);
  window.addEventListener('popstate', nav, true);
  document.addEventListener('click', e => {
    if (panel && !panel.contains(e.target) && e.target?.id !== 'eyh-surface-settings') closePanel({ restorePreview: true });
  }, true);
  loadSettings().then(() => scheduleScan(0)).catch(() => {});
})();