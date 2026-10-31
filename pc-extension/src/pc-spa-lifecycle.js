(() => {
  'use strict';

  // YouTube occasionally changes SPA routes without delivering the navigation event to an
  // extension's isolated world. Keep this deliberately O(1): URL + one fixed header identity only.
  // Poll quickly while YouTube is constructing/navigating, then back off during steady-state use;
  // hidden tabs do not need a polling wakeup at all.
  const FAST_HEARTBEAT_MS = 500;
  const STEADY_HEARTBEAT_MS = 2500;
  const FAST_WINDOW_MS = 12_000;
  let fastUntil = Date.now() + FAST_WINDOW_MS;
  let timer = null;
  let lastRoute = `${location.pathname}${location.search}`;
  let lastHeaderRoot = document.getElementById('eyh-header-controls');

  function reconcile(force = false) {
    const route = `${location.pathname}${location.search}`;
    const headerRoot = document.getElementById('eyh-header-controls');
    if (!force && route === lastRoute && headerRoot === lastHeaderRoot) return false;

    lastRoute = route;
    lastHeaderRoot = headerRoot;
    fastUntil = Date.now() + FAST_WINDOW_MS;
    window.dispatchEvent(new Event('yt-navigate-finish'));
    return true;
  }

  function schedule(delay = null) {
    clearTimeout(timer);
    timer = null;
    if (document.visibilityState !== 'visible') return;
    const nextDelay = delay ?? (Date.now() < fastUntil ? FAST_HEARTBEAT_MS : STEADY_HEARTBEAT_MS);
    timer = setTimeout(tick, nextDelay);
  }

  function tick() {
    timer = null;
    if (document.visibilityState !== 'visible') return;
    reconcile(false);
    schedule();
  }

  function armFastWindow() {
    fastUntil = Date.now() + FAST_WINDOW_MS;
    schedule(FAST_HEARTBEAT_MS);
  }

  // Native signals are cheap opportunities to keep the watchdog responsive around real SPA work.
  // If a completion signal itself is missed, the O(1) timer still repairs the lifecycle state.
  window.addEventListener('yt-navigate-start', armFastWindow, true);
  window.addEventListener('yt-navigate-finish', armFastWindow, true);
  window.addEventListener('popstate', armFastWindow, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      fastUntil = Date.now() + FAST_WINDOW_MS;
      reconcile(true);
      schedule(FAST_HEARTBEAT_MS);
    } else {
      clearTimeout(timer);
      timer = null;
    }
  }, true);

  reconcile(true);
  schedule(FAST_HEARTBEAT_MS);
})();
