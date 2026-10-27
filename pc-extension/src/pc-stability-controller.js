(() => {
  'use strict';

  // Presentation stability controller for v0.10.7.
  // IMPORTANT: this file never scans or mutates video cards. content.js is the sole card renderer.
  // It only maps the stored page profile onto the legacy renderer inputs and decorates the header.

  const RETRY_DELAYS = [0, 180, 700, 1800];
  let applyGeneration = 0;

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
    // Keep the historic mutually-exclusive quick modes. If an old advanced profile has both enabled,
    // hide wins, matching the prior page-profile renderer's effective presentation.
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

    // Direct upgrades from the stable 0.9.x line have no page-profile default yet. Capture the old
    // global mode exactly once before any page override can remap watchedDisplayMode. This prevents
    // the first quick-button choice from leaking into every other surface.
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

  function decorateHeader() {
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return false;

    // Remove stale v0.10.x detailed-settings UI if this SPA document survived an extension update.
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

    // Destructive legacy controls stay unavailable. The old MAIN-world message names are also
    // independently blocked by watch-later-safety-main.js, so stale tabs cannot reopen deletion.
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
    for (const delay of RETRY_DELAYS) setTimeout(decorateHeader, delay);
  }

  async function applySurfaceProfile() {
    if (!extensionAlive()) return;
    const generation = ++applyGeneration;
    const key = surfaceKey();

    // Shorts has no useful recommendation-card presentation surface. Crucially, do not write the
    // global renderer settings here: doing so would corrupt the 0.9.x fallback/default when a user
    // visits Shorts before a page-profile default has ever been stored.
    if (key === 'shorts') {
      scheduleHeaderDecoration();
      return;
    }

    const state = await readProfileState(key);
    if (generation !== applyGeneration || key !== surfaceKey()) return;
    const effective = effectivePresentation(state.profile);
    const patch = {};
    if (state.values.watchedDisplayMode !== effective.mode) patch.watchedDisplayMode = effective.mode;
    if (Number(state.values.watchedMinProgressPct || 0) !== effective.threshold) {
      patch.watchedMinProgressPct = effective.threshold;
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    scheduleHeaderDecoration();
  }

  async function setCurrentSurfaceMode(mode) {
    if (!extensionAlive() || !['none', 'dim', 'hide'].includes(mode)) return;
    const key = surfaceKey();
    if (key === 'shorts') return;
    const state = await readProfileState(key);
    const profile = {
      ...state.profile,
      dimEnabled: mode === 'dim',
      hideEnabled: mode === 'hide'
    };
    const profiles = { ...state.profiles, [key]: profile };
    const effective = effectivePresentation(profile);
    await chrome.storage.local.set({
      watchedSurfaceProfiles: profiles,
      watchedDisplayMode: effective.mode,
      watchedMinProgressPct: effective.threshold,
      watchLaterAutoCleanupEnabled: false
    });
    scheduleHeaderDecoration();
  }

  // Capture the three lightweight legacy buttons before content.js's old global-mode handler.
  // This preserves the familiar UI while storing the choice as the current page override.
  document.addEventListener('click', event => {
    const button = event.target?.closest?.('#eyh-header-controls button[data-eyh-mode]');
    if (!button) return;
    const mode = button.dataset.eyhMode;
    if (!['none', 'dim', 'hide'].includes(mode) || surfaceKey() === 'shorts') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setCurrentSurfaceMode(mode).catch(() => {});
  }, true);

  function onNavigation() {
    applyGeneration += 1;
    applySurfaceProfile().catch(() => {});
    scheduleHeaderDecoration();
  }

  if (!extensionAlive()) return;

  // Keep the old destructive/automatic path truly dormant, not merely blocked at its final bridge.
  chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});
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
