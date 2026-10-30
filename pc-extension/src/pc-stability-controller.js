(() => {
  'use strict';

  // Presentation stability controller for v0.10.13.
  // IMPORTANT: this file never scans or mutates video cards. content.js is the sole card renderer.
  // It owns only page-profile -> legacy-renderer mapping and the three quick-button visuals.

  const RETRY_DELAYS = [0, 180, 700, 1800];
  const PROFILE_ACTIVE_CLASS = 'eyh-profile-active';
  let applyGeneration = 0;
  let decorationTimers = [];
  const quickModeSeqBySurface = new Map();
  const pendingModeBySurface = new Map();

  const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));

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

  function normalizeProfile(profile, fallbackMode = 'dim', fallbackThreshold = 0) {
    if (!profile || typeof profile !== 'object') {
      const threshold = clamp(fallbackThreshold);
      return {
        dimEnabled: fallbackMode === 'dim',
        hideEnabled: fallbackMode === 'hide',
        linkedThresholds: true,
        sharedThreshold: threshold,
        dimThreshold: threshold,
        hideThreshold: threshold
      };
    }
    return {
      dimEnabled: Boolean(profile.dimEnabled),
      hideEnabled: Boolean(profile.hideEnabled),
      linkedThresholds: profile.linkedThresholds !== false,
      sharedThreshold: clamp(profile.sharedThreshold),
      dimThreshold: clamp(profile.dimThreshold),
      hideThreshold: clamp(profile.hideThreshold)
    };
  }

  function effectivePresentation(profile) {
    if (profile.hideEnabled) {
      return {
        mode: 'hide',
        threshold: profile.linkedThresholds ? profile.sharedThreshold : profile.hideThreshold
      };
    }
    if (profile.dimEnabled) {
      return {
        mode: 'dim',
        threshold: profile.linkedThresholds ? profile.sharedThreshold : profile.dimThreshold
      };
    }
    return { mode: 'none', threshold: 0 };
  }

  async function readProfileState(key = surfaceKey()) {
    const values = await chrome.storage.local.get({
      watchedDisplayMode: 'dim',
      watchedMinProgressPct: 0,
      watchedSurfaceDefaultProfile: null,
      watchedSurfaceProfiles: {}
    });
    const legacyMode = ['dim', 'hide', 'none'].includes(values.watchedDisplayMode)
      ? values.watchedDisplayMode : 'dim';
    const hasStoredDefault = values.watchedSurfaceDefaultProfile
      && typeof values.watchedSurfaceDefaultProfile === 'object';
    const defaults = normalizeProfile(
      hasStoredDefault ? values.watchedSurfaceDefaultProfile : null,
      legacyMode,
      values.watchedMinProgressPct
    );

    if (!hasStoredDefault) {
      await chrome.storage.local.set({ watchedSurfaceDefaultProfile: defaults });
      values.watchedSurfaceDefaultProfile = defaults;
    }

    const profiles = values.watchedSurfaceProfiles && typeof values.watchedSurfaceProfiles === 'object'
      ? values.watchedSurfaceProfiles : {};
    const hasOverride = Object.prototype.hasOwnProperty.call(profiles, key);
    return {
      values,
      profiles,
      hasOverride,
      profile: normalizeProfile(hasOverride ? profiles[key] : defaults, legacyMode, values.watchedMinProgressPct)
    };
  }

  function paintQuickMode(mode) {
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return;
    root.dataset.eyhProfileOwned = '1';
    for (const button of root.querySelectorAll('button[data-eyh-mode]')) {
      const active = button.dataset.eyhMode === mode;
      // content.js still maintains the historic eyh-active class for compatibility. v0.10.13
      // deliberately paints the visible selection through a separate class so only one subsystem
      // controls what the user sees during startup/storage churn.
      button.classList.toggle(PROFILE_ACTIVE_CLASS, active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function decorateHeader() {
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return false;

    root.dataset.eyhProfileOwned = '1';
    root.querySelector('#eyh-surface-settings')?.remove();
    document.querySelector('#eyh-surface-panel')?.remove();
    const brand = root.querySelector('.eyh-header-brand');
    if (brand) brand.hidden = true;

    const shorts = surfaceKey() === 'shorts';
    root.style.display = shorts ? 'none' : '';

    for (const button of root.querySelectorAll('button[data-eyh-mode]')) {
      button.hidden = shorts;
      button.disabled = shorts;
    }

    for (const selector of ['#eyh-watch-later-auto', '#eyh-watch-later-cleanup']) {
      const button = root.querySelector(selector);
      if (!button) continue;
      button.hidden = true;
      button.disabled = true;
      button.title = 'Watch Later 자동/legacy 정리는 안전 잠금 상태입니다.';
    }
    return true;
  }

  function scheduleHeaderDecoration() {
    // YouTube can emit several equivalent lifecycle signals while the masthead is being built.
    // Keep at most one retry ladder alive instead of accumulating 4 timers per signal.
    for (const timer of decorationTimers) clearTimeout(timer);
    decorationTimers = RETRY_DELAYS.map(delay => setTimeout(decorateHeader, delay));
  }

  async function applySurfaceProfile() {
    if (!extensionAlive()) return;
    const generation = ++applyGeneration;
    const key = surfaceKey();

    if (key === 'shorts') {
      scheduleHeaderDecoration();
      return;
    }

    const state = await readProfileState(key);
    if (generation !== applyGeneration || key !== surfaceKey()) return;

    const pending = pendingModeBySurface.get(key);
    if (pending) {
      paintQuickMode(pending.mode);
      scheduleHeaderDecoration();
      return;
    }

    const effective = effectivePresentation(state.profile);
    paintQuickMode(effective.mode);
    const patch = {};
    if (state.values.watchedDisplayMode !== effective.mode) patch.watchedDisplayMode = effective.mode;
    if (Number(state.values.watchedMinProgressPct || 0) !== effective.threshold) {
      patch.watchedMinProgressPct = effective.threshold;
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    scheduleHeaderDecoration();
  }

  async function persistCurrentSurfaceMode(mode, key, seq) {
    if (!extensionAlive() || !['none', 'dim', 'hide'].includes(mode) || key === 'shorts') return;
    const state = await readProfileState(key);
    if (quickModeSeqBySurface.get(key) !== seq) return;

    const profile = {
      ...state.profile,
      dimEnabled: mode === 'dim',
      hideEnabled: mode === 'hide'
    };
    const profiles = { ...state.profiles, [key]: profile };
    const effective = effectivePresentation(profile);
    const patch = {
      watchedSurfaceProfiles: profiles,
      watchLaterAutoCleanupEnabled: false
    };
    if (surfaceKey() === key) {
      patch.watchedDisplayMode = effective.mode;
      patch.watchedMinProgressPct = effective.threshold;
    }
    // One canonical storage transaction per click. v0.10.12 first wrote watchedDisplayMode and then
    // wrote the full profile, which made content.js reload/scan twice and amplified startup churn.
    await chrome.storage.local.set(patch);

    if (quickModeSeqBySurface.get(key) !== seq) return;
    pendingModeBySurface.delete(key);
    if (surfaceKey() === key) {
      paintQuickMode(effective.mode);
      applySurfaceProfile().catch(() => {});
    }
    scheduleHeaderDecoration();
  }

  function chooseCurrentSurfaceMode(mode) {
    const key = surfaceKey();
    if (key === 'shorts') return;
    const seq = (quickModeSeqBySurface.get(key) || 0) + 1;
    quickModeSeqBySurface.set(key, seq);
    pendingModeBySurface.set(key, { seq, mode });

    // UI feedback is immediate. The sole renderer switches after the single canonical storage
    // transaction below, avoiding the old two-write bounce while keeping the user's click pinned.
    paintQuickMode(mode);
    persistCurrentSurfaceMode(mode, key, seq).catch(() => {
      if (quickModeSeqBySurface.get(key) === seq) {
        pendingModeBySurface.delete(key);
        applySurfaceProfile().catch(() => {});
      }
    });
  }

  document.addEventListener('click', event => {
    const button = event.target?.closest?.('#eyh-header-controls button[data-eyh-mode]');
    if (!button) return;
    const mode = button.dataset.eyhMode;
    if (!['none', 'dim', 'hide'].includes(mode) || surfaceKey() === 'shorts') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    chooseCurrentSurfaceMode(mode);
  }, true);

  function onNavigation() {
    applyGeneration += 1;
    applySurfaceProfile().catch(() => {});
    scheduleHeaderDecoration();
  }

  if (!extensionAlive()) return;

  // CSS can now ignore content.js's compatibility eyh-active paint before the first masthead mount,
  // eliminating the visible startup ping-pong even if storage/lifecycle events arrive in a burst.
  document.documentElement.dataset.eyhProfileController = '1';

  // Keep the old destructive auto-cleanup key fail-closed without performing a redundant storage
  // write on every YouTube tab startup.
  chrome.storage.local.get({ watchLaterAutoCleanupEnabled: false }).then(values => {
    if (values.watchLaterAutoCleanupEnabled === true) {
      return chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false });
    }
    return null;
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.watchLaterAutoCleanupEnabled?.newValue === true) {
      chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});
    }
    if (changes.watchedSurfaceProfiles || changes.watchedSurfaceDefaultProfile) {
      applySurfaceProfile().catch(() => {});
    }
  });
  window.addEventListener('yt-navigate-finish', onNavigation, true);
  window.addEventListener('popstate', onNavigation, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onNavigation();
  }, true);

  onNavigation();
})();
