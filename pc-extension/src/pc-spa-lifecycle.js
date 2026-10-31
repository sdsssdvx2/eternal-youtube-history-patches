(() => {
  'use strict';

  // YouTube normally emits yt-navigate-finish itself. This is only a bounded fallback for the rare
  // isolated-world miss: compare URL + one fixed Eternal root, never scan cards or storage.
  // Hidden tabs do not need a polling wakeup; visibilitychange performs an immediate reconciliation.
  const HEARTBEAT_MS = 1000;
  let lastRoute = `${location.pathname}${location.search}`;
  let lastHeaderRoot = document.getElementById('eyh-header-controls');
  let heartbeatTimer = null;

  function reconcile(force = false) {
    const route = `${location.pathname}${location.search}`;
    const headerRoot = document.getElementById('eyh-header-controls');
    if (!force && route === lastRoute && headerRoot === lastHeaderRoot) return;

    lastRoute = route;
    lastHeaderRoot = headerRoot;
    window.dispatchEvent(new Event('yt-navigate-finish'));
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  function scheduleHeartbeat() {
    stopHeartbeat();
    if (document.visibilityState !== 'visible') return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      reconcile(false);
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconcile(true);
      scheduleHeartbeat();
    } else {
      stopHeartbeat();
    }
  }, true);

  reconcile(true);
  scheduleHeartbeat();
})();
