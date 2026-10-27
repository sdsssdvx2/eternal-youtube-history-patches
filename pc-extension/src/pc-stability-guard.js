(() => {
  'use strict';

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

  // Destructive background cleanup stays locked. The transactional safe-cleanup coordinator is a
  // separate explicit-user-action path and does not read this preference.
  if (extensionAlive()) {
    chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});
  }

  applySurfaceClass();
  window.addEventListener('yt-navigate-finish', applySurfaceClass, true);
  window.addEventListener('popstate', applySurfaceClass, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applySurfaceClass();
  }, true);
})();
