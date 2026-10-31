(() => {
  'use strict';

  // Resolve only the initial page profile at document_start. The full controller still owns
  // navigation, buttons and late masthead state at document_idle; this tiny bootstrap exists only
  // to ensure content.js never starts its first card scan with a stale global presentation mode.
  const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));

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

  function normalizeProfile(profile, fallbackMode, fallbackThreshold) {
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

  async function bootstrap() {
    const key = surfaceKey();
    // Shorts intentionally never remaps the legacy renderer inputs. It has no useful watched-card
    // presentation surface and must not leak a Shorts visit into the default profile state.
    if (key === 'shorts') return;

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
    }

    const profiles = values.watchedSurfaceProfiles && typeof values.watchedSurfaceProfiles === 'object'
      ? values.watchedSurfaceProfiles : {};
    const profile = normalizeProfile(
      Object.prototype.hasOwnProperty.call(profiles, key) ? profiles[key] : defaults,
      legacyMode,
      values.watchedMinProgressPct
    );
    const effective = effectivePresentation(profile);
    const patch = {};
    if (values.watchedDisplayMode !== effective.mode) patch.watchedDisplayMode = effective.mode;
    if (Number(values.watchedMinProgressPct || 0) !== effective.threshold) {
      patch.watchedMinProgressPct = effective.threshold;
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);

    if (document.documentElement) {
      document.documentElement.dataset.eyhInitialProfile = `${key}:${effective.mode}:${effective.threshold}`;
    }
  }

  globalThis.EYHProfileBootstrapReady = bootstrap().catch(() => null);
})();
