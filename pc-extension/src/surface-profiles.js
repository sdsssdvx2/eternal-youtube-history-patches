(() => {
  const LABELS = {
    home: '홈', shorts: 'Shorts', watch: '영상 상세 · 관련 영상', subscriptions: '구독',
    channel: '채널', search: '검색 결과', watch_later: '나중에 볼 동영상', liked: '좋아요',
    playlists: '재생목록', playlist_detail: '재생목록 상세', history: '시청 기록',
    library: '내 페이지 · 라이브러리', other: '기타'
  };
  let settings = null;
  let scanTimer = null;
  let panel = null;
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

  function legacyProfile(v) {
    const mode = ['dim', 'hide', 'none'].includes(v.watchedDisplayMode) ? v.watchedDisplayMode : 'dim';
    const threshold = clamp(v.watchedMinProgressPct);
    return normalizeProfile({
      dimEnabled: mode === 'dim', hideEnabled: mode === 'hide', linkedThresholds: true,
      sharedThreshold: threshold, dimThreshold: threshold, hideThreshold: threshold
    });
  }

  async function loadSettings() {
    const v = await chrome.storage.local.get({
      watchedDisplayMode: 'dim', watchedMinProgressPct: 0,
      watchedThumbnailOpacityPct: 65, watchedThumbnailGrayscale: false, watchedLinkCardInfo: false,
      watchedSurfaceDefaultProfile: null, watchedSurfaceProfiles: {}
    });
    let defaultProfile = v.watchedSurfaceDefaultProfile ? normalizeProfile(v.watchedSurfaceDefaultProfile) : null;
    if (!defaultProfile) {
      defaultProfile = legacyProfile(v);
      await chrome.storage.local.set({ watchedSurfaceDefaultProfile: defaultProfile });
    }
    // The legacy content script still owns sync/Watch Later/History. Disable only its old global
    // card styling after preserving that styling as the default profile above.
    if (v.watchedDisplayMode !== 'none') await chrome.storage.local.set({ watchedDisplayMode: 'none' });
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

  function currentProfile() {
    const key = surfaceKey();
    return normalizeProfile(settings?.profiles?.[key] || settings?.defaultProfile || {});
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
    if (m) return clamp(m[1]);
    return null;
  }

  function matchesThreshold(isWatched, pct, threshold) {
    if (!isWatched) return false;
    return threshold <= 0 || (pct != null && pct >= threshold);
  }

  async function scan() {
    scanTimer = null;
    if (!settings) await loadSettings().catch(() => {});
    if (!settings) return;
    const profile = currentProfile();
    const thresholds = effectiveThresholds(profile);
    const map = new Map();
    for (const a of document.querySelectorAll('a[href*="watch?v="], a[href^="/shorts/"]')) {
      const id = videoIdFromHref(a.getAttribute('href')); if (!id) continue;
      if (!map.has(id)) map.set(id, []); map.get(id).push(a);
    }
    const missing = [...map.keys()].filter(id => !watched.has(id));
    for (let i = 0; i < missing.length; i += 400) {
      const ids = missing.slice(i, i + 400);
      try {
        const r = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids });
        for (const id of ids) {
          watched.set(id, Boolean(r?.watched?.[id]));
          const n = Number(r?.progress?.[id]); progress.set(id, Number.isFinite(n) ? clamp(n) : null);
        }
      } catch {}
    }
    for (const [id, anchors] of map) {
      for (const a of anchors) {
        const c = containerFor(a); if (!c) continue;
        const stored = progress.get(id); const native = nativeProgressPct(c);
        const pct = stored == null ? native : native == null ? stored : Math.max(stored, native);
        const isWatched = watched.get(id) === true;
        const hide = profile.hideEnabled && matchesThreshold(isWatched, pct, thresholds.hide);
        const dim = !hide && profile.dimEnabled && matchesThreshold(isWatched, pct, thresholds.dim);
        c.classList.toggle('eyh-hidden', hide);
        c.classList.toggle('eyh-watched', dim);
        c.classList.toggle('eyh-watched-linked', dim && settings.linkedCardInfo);
        c.classList.toggle('eyh-watched-grayscale', dim && settings.grayscale);
        c.dataset.eyhSurface = surfaceKey();
        c.dataset.eyhVideoId = id;
        if (pct != null) c.dataset.eyhProgressPct = String(Math.round(pct)); else delete c.dataset.eyhProgressPct;
      }
    }
    decorateHeader();
  }

  function scheduleScan(delay = 120) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, delay);
  }

  function decorateHeader() {
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return;
    for (const b of root.querySelectorAll('button[data-eyh-mode]')) b.hidden = true;
    const key = surfaceKey();
    const brand = root.querySelector('.eyh-header-brand'); if (brand) brand.textContent = `Eternal · ${LABELS[key] || LABELS.other}`;
    let button = root.querySelector('#eyh-surface-settings');
    if (!button) {
      button = document.createElement('button'); button.id = 'eyh-surface-settings'; button.type = 'button';
      button.className = 'eyh-header-button eyh-active'; button.addEventListener('click', openPanel);
      root.insertBefore(button, root.querySelector('.eyh-wl-only') || root.querySelector('#eyh-header-status'));
    }
    const p = currentProfile(), t = effectiveThresholds(p);
    const states = [];
    if (p.dimEnabled) states.push(`흐림 ${t.dim}%`);
    if (p.hideEnabled) states.push(`숨김 ${t.hide}%`);
    button.textContent = states.length ? states.join(' · ') : '표시 변경 없음';
    button.title = `${LABELS[key] || LABELS.other} 페이지 표시 설정`;
  }

  function field(label, input) {
    const row = document.createElement('label'); row.className = 'eyh-surface-row';
    const span = document.createElement('span'); span.textContent = label; row.append(span, input); return row;
  }
  function checkbox(checked) { const x = document.createElement('input'); x.type = 'checkbox'; x.checked = checked; return x; }
  function number(value) { const x = document.createElement('input'); x.type = 'number'; x.min = '0'; x.max = '100'; x.step = '5'; x.value = String(clamp(value)); return x; }

  function closePanel() { panel?.remove(); panel = null; }
  function openPanel() {
    closePanel();
    const key = surfaceKey(), p = currentProfile();
    panel = document.createElement('div'); panel.id = 'eyh-surface-panel';
    const title = document.createElement('strong'); title.textContent = `Eternal · ${LABELS[key] || LABELS.other}`; panel.append(title);
    const note = document.createElement('div'); note.className = 'eyh-surface-note'; note.textContent = '이 PC의 이 페이지에만 저장됩니다. 두 조건을 모두 만족하면 숨김이 우선합니다.'; panel.append(note);
    const dim = checkbox(p.dimEnabled), hide = checkbox(p.hideEnabled), linked = checkbox(p.linkedThresholds);
    const shared = number(p.sharedThreshold), dimPct = number(p.dimThreshold), hidePct = number(p.hideThreshold);
    panel.append(field('흐리게', dim), field('숨기기', hide), field('진행률 기준 같이 사용', linked));
    const sharedRow = field('공통 최소 진행률 (%)', shared), dimRow = field('흐림 최소 진행률 (%)', dimPct), hideRow = field('숨김 최소 진행률 (%)', hidePct);
    panel.append(sharedRow, dimRow, hideRow);
    const refreshRows = () => { sharedRow.hidden = !linked.checked; dimRow.hidden = linked.checked; hideRow.hidden = linked.checked; };
    linked.addEventListener('change', refreshRows); refreshRows();
    const actions = document.createElement('div'); actions.className = 'eyh-surface-actions';
    const reset = document.createElement('button'); reset.textContent = '기본값';
    const cancel = document.createElement('button'); cancel.textContent = '취소';
    const save = document.createElement('button'); save.textContent = '적용'; save.className = 'primary';
    actions.append(reset, cancel, save); panel.append(actions); document.body.append(panel);
    cancel.addEventListener('click', closePanel);
    reset.addEventListener('click', async () => {
      const profiles = { ...(settings.profiles || {}) }; delete profiles[key];
      await chrome.storage.local.set({ watchedSurfaceProfiles: profiles }); settings.profiles = profiles; closePanel(); watched.clear(); progress.clear(); scheduleScan(0);
    });
    save.addEventListener('click', async () => {
      const profile = normalizeProfile({ dimEnabled: dim.checked, hideEnabled: hide.checked, linkedThresholds: linked.checked, sharedThreshold: shared.value, dimThreshold: dimPct.value, hideThreshold: hidePct.value });
      const profiles = { ...(settings.profiles || {}), [key]: profile };
      await chrome.storage.local.set({ watchedSurfaceProfiles: profiles }); settings.profiles = profiles; closePanel(); watched.clear(); progress.clear(); scheduleScan(0);
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.watchedSurfaceProfiles || changes.watchedSurfaceDefaultProfile || changes.watchedThumbnailOpacityPct || changes.watchedThumbnailGrayscale || changes.watchedLinkCardInfo) {
      loadSettings().then(() => { watched.clear(); progress.clear(); scheduleScan(0); }).catch(() => {});
    }
  });
  const observer = new MutationObserver(mutations => {
    if (mutations.some(m => m.type === 'childList' && m.addedNodes.length)) scheduleScan();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });
  const nav = () => { closePanel(); watched.clear(); progress.clear(); scheduleScan(0); setTimeout(decorateHeader, 350); };
  window.addEventListener('yt-navigate-finish', nav, true); window.addEventListener('popstate', nav, true);
  document.addEventListener('click', e => { if (panel && !panel.contains(e.target) && e.target?.id !== 'eyh-surface-settings') closePanel(); }, true);
  loadSettings().then(() => scheduleScan(0)).catch(() => {});
})();
