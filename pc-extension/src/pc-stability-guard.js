(() => {
  'use strict';

  const MIGRATION_KEY = 'eyhPcSingleRendererMigrationV0107';
  const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));

  // Stability guard for the single-owner 0.9.x renderer. It intentionally does not observe the
  // YouTube DOM. URL/navigation signals are enough to suppress Eternal UI on the full-screen
  // Shorts surface, while content.js remains the sole owner of watched-card rendering and the
  // header's 표시/흐림/숨김 controls.
  function applySurfaceClass() {
    const shorts = location.pathname.startsWith('/shorts/');
    document.documentElement.classList.toggle('eyh-shorts-surface', shorts);
  }

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }

  async function migratePresentationOnce() {
    if (!extensionAlive()) return;
    const state = await chrome.storage.local.get({
      [MIGRATION_KEY]: false,
      watchedDisplayMode: 'dim',
      watchedMinProgressPct: 0,
      watchedSurfaceDefaultProfile: null
    });
    if (state[MIGRATION_KEY]) return;

    const update = { [MIGRATION_KEY]: true, watchLaterAutoCleanupEnabled: false };
    const profile = state.watchedSurfaceDefaultProfile;
    // v0.10.x deliberately forced the legacy renderer to "none" while surface-profiles.js owned
    // presentation. When returning to the proven renderer, translate the preserved common profile
    // exactly once so an upgrade does not silently lose the user's dim/hide preference.
    if (state.watchedDisplayMode === 'none' && profile && typeof profile === 'object') {
      const mode = profile.hideEnabled ? 'hide' : profile.dimEnabled ? 'dim' : 'none';
      const linked = profile.linkedThresholds !== false;
      const threshold = linked
        ? clamp(profile.sharedThreshold)
        : mode === 'hide' ? clamp(profile.hideThreshold) : clamp(profile.dimThreshold);
      update.watchedDisplayMode = mode;
      update.watchedMinProgressPct = threshold;
    }
    await chrome.storage.local.set(update);
  }

  // Destructive background cleanup stays locked. The transactional safe-cleanup coordinator is a
  // separate explicit-user-action path and does not read this preference.
  if (extensionAlive()) {
    migratePresentationOnce().catch(() => {
      chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});
    });
  }

  applySurfaceClass();
  window.addEventListener('yt-navigate-finish', applySurfaceClass, true);
  window.addEventListener('popstate', applySurfaceClass, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applySurfaceClass();
  }, true);
})();
