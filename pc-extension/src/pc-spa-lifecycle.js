(() => {
  'use strict';

  // YouTube occasionally changes SPA routes without delivering the navigation event to an
  // extension's isolated world. Keep this deliberately tiny: it never scans video cards or the
  // document tree. It only compares the URL and the single Eternal header root twice per second.
  // When either changes, replay the same completion signal our lightweight coordinators already
  // consume. This repairs page-profile, Watch Later and inline-control lifecycle state without a
  // second MutationObserver or another renderer.
  const HEARTBEAT_MS = 500;
  let lastRoute = `${location.pathname}${location.search}`;
  let lastHeaderRoot = document.getElementById('eyh-header-controls');

  function reconcile(force = false) {
    const route = `${location.pathname}${location.search}`;
    const headerRoot = document.getElementById('eyh-header-controls');
    if (!force && route === lastRoute && headerRoot === lastHeaderRoot) return;

    lastRoute = route;
    lastHeaderRoot = headerRoot;
    window.dispatchEvent(new Event('yt-navigate-finish'));
  }

  setInterval(() => reconcile(false), HEARTBEAT_MS);
  setTimeout(() => reconcile(true), 0);
})();
