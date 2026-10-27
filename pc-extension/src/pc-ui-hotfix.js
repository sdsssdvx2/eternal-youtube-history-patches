(() => {
  'use strict';

  const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));
  let refreshQueued = false;

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }

  async function storageGet(defaults) {
    if (!extensionAlive()) throw new Error('EXTENSION_CONTEXT_INVALIDATED');
    return chrome.storage.local.get(defaults);
  }

  async function storageSet(values) {
    if (!extensionAlive()) throw new Error('EXTENSION_CONTEXT_INVALIDATED');
    return chrome.storage.local.set(values);
  }

  function surfaceKey() {
    const path = location.pathname;
    const query = new URLSearchParams(location.search);
    if (path.startsWith('/shorts/')) return 'shorts';
    if (path === '/watch') return 'watch';
    if (path === '/results') return 'search';
    if (path.startsWith('/feed/subscriptions')) return 'subscriptions';
    if (path.startsWith('/feed/history')) return 'history';
    if (path.startsWith('/feed/playlists')) return 'playlists';
    if (path === '/feed/you' || path.startsWith('/feed/library')) return 'library';
    if (path === '/playlist') {
      const list = query.get('list') || '';
      if (list === 'WL') return 'watch_later';
      if (list === 'LL') return 'liked';
      return 'playlist_detail';
    }
    if (/^\/(?:@[^/]+|channel\/|c\/|user\/)/.test(path)) return 'channel';
    if (path === '/' || path === '') return 'home';
    return 'other';
  }

  function normalizeProfile(profile) {
    return {
      dimEnabled: Boolean(profile?.dimEnabled),
      hideEnabled: Boolean(profile?.hideEnabled),
      linkedThresholds: profile?.linkedThresholds !== false,
      sharedThreshold: clamp(profile?.sharedThreshold),
      dimThreshold: clamp(profile?.dimThreshold),
      hideThreshold: clamp(profile?.hideThreshold)
    };
  }

  function legacyProfile(values) {
    const mode = ['dim', 'hide', 'none'].includes(values?.watchedDisplayMode)
      ? values.watchedDisplayMode
      : 'dim';
    const threshold = clamp(values?.watchedMinProgressPct);
    return normalizeProfile({
      dimEnabled: mode === 'dim',
      hideEnabled: mode === 'hide',
      linkedThresholds: true,
      sharedThreshold: threshold,
      dimThreshold: threshold,
      hideThreshold: threshold
    });
  }

  function showReloadNotice() {
    alert('Eternal 확장이 업데이트된 뒤 이 YouTube 탭의 이전 확장 컨텍스트가 남아 있습니다. 이 탭만 한 번 새로고침하면 설정 버튼이 다시 작동합니다.');
  }

  async function profileState() {
    const values = await storageGet({
      watchedDisplayMode: 'dim',
      watchedMinProgressPct: 0,
      watchedSurfaceDefaultProfile: null,
      watchedSurfaceProfiles: {}
    });
    const profiles = values.watchedSurfaceProfiles && typeof values.watchedSurfaceProfiles === 'object'
      ? values.watchedSurfaceProfiles
      : {};
    const key = surfaceKey();
    const defaults = values.watchedSurfaceDefaultProfile
      ? normalizeProfile(values.watchedSurfaceDefaultProfile)
      : legacyProfile(values);
    return {
      key,
      profiles,
      profile: normalizeProfile(Object.prototype.hasOwnProperty.call(profiles, key) ? profiles[key] : defaults)
    };
  }

  async function applyQuickMode(mode) {
    if (!extensionAlive()) {
      showReloadNotice();
      return;
    }
    const state = await profileState();
    if (state.key === 'shorts') return;
    const next = {
      ...state.profile,
      dimEnabled: mode === 'dim',
      hideEnabled: mode === 'hide'
    };
    await storageSet({
      watchedSurfaceProfiles: {
        ...state.profiles,
        [state.key]: normalizeProfile(next)
      }
    });
    scheduleDecorate();
  }

  async function syncQuickState(root) {
    if (!extensionAlive() || surfaceKey() === 'shorts') return;
    try {
      const { profile } = await profileState();
      const effective = profile.hideEnabled ? 'hide' : profile.dimEnabled ? 'dim' : 'none';
      for (const button of root.querySelectorAll('button[data-eyh-mode]')) {
        const active = button.dataset.eyhMode === effective;
        button.classList.toggle('eyh-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    } catch { }
  }

  function bindQuickButton(button) {
    if (button.dataset.eyhHotfixBound === '1') return;
    button.dataset.eyhHotfixBound = '1';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const mode = button.dataset.eyhMode;
      if (!['none', 'dim', 'hide'].includes(mode)) return;
      applyQuickMode(mode).catch(() => {
        if (!extensionAlive()) showReloadNotice();
      });
    }, true);
  }

  function bindSettingsButton(button) {
    if (!button || button.dataset.eyhContextGuardBound === '1') return;
    button.dataset.eyhContextGuardBound = '1';
    button.addEventListener('click', event => {
      if (extensionAlive()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showReloadNotice();
    }, true);
  }

  function decorate() {
    refreshQueued = false;
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return;

    const key = surfaceKey();
    if (key === 'shorts') {
      root.style.display = 'none';
      return;
    }
    root.style.removeProperty('display');

    const brand = root.querySelector('.eyh-header-brand');
    if (brand) brand.hidden = true;

    for (const button of root.querySelectorAll('button[data-eyh-mode]')) {
      button.hidden = false;
      button.removeAttribute('hidden');
      bindQuickButton(button);
    }

    // Destructive Watch Later controls are deliberately unavailable in v0.10.3 while the old
    // deletion path is being replaced by snapshot+journal+fresh-identity verification.
    for (const id of ['#eyh-watch-later-auto', '#eyh-watch-later-cleanup']) {
      const button = root.querySelector(id);
      if (!button) continue;
      button.hidden = true;
      button.disabled = true;
      button.title = '안전 복구 기능 추가 전까지 Watch Later 정리는 잠겨 있습니다.';
    }

    bindSettingsButton(root.querySelector('#eyh-surface-settings'));
    syncQuickState(root).catch(() => {});
  }

  function scheduleDecorate() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(decorate);
  }

  // Force the destructive preference off for this safety release. The MAIN-world safety boundary
  // independently blocks remove requests, so even a stale content script cannot delete anything.
  if (extensionAlive()) {
    chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.watchedSurfaceProfiles || changes.watchedSurfaceDefaultProfile)) {
        scheduleDecorate();
      }
    });
  }

  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('yt-navigate-finish', scheduleDecorate, true);
  window.addEventListener('popstate', scheduleDecorate, true);
  setTimeout(scheduleDecorate, 0);
})();
