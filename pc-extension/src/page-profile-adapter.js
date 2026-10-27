(() => {
  'use strict';

  const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));
  let applyGeneration = 0;
  let retryTimers = [];

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
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

  function effectiveLegacy(profile) {
    const p = normalizeProfile(profile);
    if (p.hideEnabled) {
      return {
        mode: 'hide',
        threshold: p.linkedThresholds ? p.sharedThreshold : p.hideThreshold
      };
    }
    if (p.dimEnabled) {
      return {
        mode: 'dim',
        threshold: p.linkedThresholds ? p.sharedThreshold : p.dimThreshold
      };
    }
    return {
      mode: 'none',
      threshold: p.linkedThresholds ? p.sharedThreshold : Math.max(p.dimThreshold, p.hideThreshold)
    };
  }

  async function profileState() {
    if (!extensionAlive()) return null;
    const values = await chrome.storage.local.get({
      watchedDisplayMode: 'dim',
      watchedMinProgressPct: 0,
      watchedSurfaceDefaultProfile: null,
      watchedSurfaceProfiles: {}
    });
    const key = surfaceKey();
    const profiles = values.watchedSurfaceProfiles && typeof values.watchedSurfaceProfiles === 'object'
      ? values.watchedSurfaceProfiles
      : {};
    const defaults = values.watchedSurfaceDefaultProfile
      ? normalizeProfile(values.watchedSurfaceDefaultProfile)
      : legacyProfile(values);
    const profile = Object.prototype.hasOwnProperty.call(profiles, key)
      ? normalizeProfile(profiles[key])
      : defaults;
    return { key, profiles, profile };
  }

  function showReloadNotice() {
    alert('Eternal 확장이 업데이트된 뒤 이 YouTube 탭의 이전 확장 컨텍스트가 남아 있습니다. 이 탭만 한 번 새로고침해 주세요.');
  }

  function clearRetryTimers() {
    for (const id of retryTimers) clearTimeout(id);
    retryTimers = [];
  }

  function bindQuickButton(button) {
    if (!button || button.dataset.eyhStableAdapterBound === '1') return;
    button.dataset.eyhStableAdapterBound = '1';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!extensionAlive()) {
        showReloadNotice();
        return;
      }
      const mode = button.dataset.eyhMode;
      if (!['none', 'dim', 'hide'].includes(mode)) return;
      applyQuickPreset(mode).catch(() => {
        if (!extensionAlive()) showReloadNotice();
      });
    }, true);
  }

  async function applyQuickPreset(mode) {
    const state = await profileState();
    if (!state || state.key === 'shorts') return;
    const next = normalizeProfile({
      ...state.profile,
      dimEnabled: mode === 'dim',
      hideEnabled: mode === 'hide'
    });
    const profiles = { ...state.profiles, [state.key]: next };
    const legacy = effectiveLegacy(next);
    await chrome.storage.local.set({
      watchedSurfaceProfiles: profiles,
      watchedDisplayMode: legacy.mode,
      watchedMinProgressPct: legacy.threshold
    });
    decorateHeader();
  }

  function decorateHeader() {
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return false;

    const key = surfaceKey();
    if (key === 'shorts') {
      root.style.display = 'none';
      return true;
    }
    if (root.style.display === 'none') root.style.removeProperty('display');

    root.querySelector('#eyh-surface-settings')?.remove();
    const brand = root.querySelector('.eyh-header-brand');
    if (brand) brand.hidden = true;

    for (const button of root.querySelectorAll('button[data-eyh-mode]')) {
      button.hidden = false;
      bindQuickButton(button);
    }

    // Legacy destructive Watch Later controls stay unavailable. The playlist-scoped safe
    // transaction script adds its own journaled cleanup/undo buttons on Watch Later only.
    for (const id of ['#eyh-watch-later-auto', '#eyh-watch-later-cleanup']) {
      const button = root.querySelector(id);
      if (!button) continue;
      button.hidden = true;
      button.disabled = true;
    }
    return true;
  }

  function scheduleHeaderRetries() {
    clearRetryTimers();
    for (const delay of [0, 150, 400, 900, 1800, 3200]) {
      retryTimers.push(setTimeout(() => decorateHeader(), delay));
    }
  }

  async function applyCurrentProfile() {
    const generation = ++applyGeneration;
    const state = await profileState();
    if (!state || generation !== applyGeneration) return;

    // Automatic Watch Later deletion remains fail-closed while recovery is in progress.
    const updates = { watchLaterAutoCleanupEnabled: false };
    if (state.key !== 'shorts') {
      const legacy = effectiveLegacy(state.profile);
      const current = await chrome.storage.local.get({
        watchedDisplayMode: 'dim',
        watchedMinProgressPct: 0
      });
      if (current.watchedDisplayMode !== legacy.mode) updates.watchedDisplayMode = legacy.mode;
      if (clamp(current.watchedMinProgressPct) !== legacy.threshold) {
        updates.watchedMinProgressPct = legacy.threshold;
      }
    }
    if (generation !== applyGeneration) return;
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    scheduleHeaderRetries();
  }

  if (!extensionAlive()) return;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.watchedSurfaceProfiles || changes.watchedSurfaceDefaultProfile) {
      applyCurrentProfile().catch(() => {});
    }
  });

  const onNavigate = () => applyCurrentProfile().catch(() => {});
  window.addEventListener('yt-navigate-finish', onNavigate, true);
  window.addEventListener('popstate', onNavigate, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleHeaderRetries();
  }, true);

  applyCurrentProfile().catch(() => {});
})();
