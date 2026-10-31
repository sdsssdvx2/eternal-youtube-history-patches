(() => {
  'use strict';

  // O(1) fallback for YouTube SPA transitions. The normal yt-navigate-finish path still does the
  // immediate work; this heartbeat exists only to repair a missed route/header transition.
  const HEARTBEAT_MS = 1000;
  let lastRoute = routeKey();
  let lastHeaderRoot = document.getElementById('eyh-header-controls');
  let heartbeatTimer = null;

  function routeKey() {
    return `${location.pathname}${location.search}`;
  }

  function reconcile() {
    const nextRoute = routeKey();
    const nextHeaderRoot = document.getElementById('eyh-header-controls');
    if (nextRoute === lastRoute && nextHeaderRoot === lastHeaderRoot) return false;
    lastRoute = nextRoute;
    lastHeaderRoot = nextHeaderRoot;
    window.dispatchEvent(new Event('yt-navigate-finish'));
    return true;
  }

  function stopHeartbeat() {
    if (heartbeatTimer != null) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleHeartbeat() {
    stopHeartbeat();
    if (document.visibilityState !== 'visible') return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      reconcile();
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  // Resident scripts already initialize themselves. Avoid an eager synthetic navigation event at
  // startup: it used to amplify the first seconds of storage/header churn for no functional gain.
  scheduleHeartbeat();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconcile();
      scheduleHeartbeat();
    } else {
      stopHeartbeat();
    }
  }, true);
  window.addEventListener('pagehide', stopHeartbeat, { once: true });
})();
