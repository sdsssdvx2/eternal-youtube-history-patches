(() => {
  'use strict';

  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const BLOCKED = new Set([
    'EYH_WL_REMOVE_REQUEST',
    'EYH_WL_REMOVE_ONE_REQUEST'
  ]);
  const ERROR = 'Watch Later 정리는 안전 복구 기능을 추가하는 동안 잠겨 있습니다. 목록/시청기록은 그대로 유지됩니다.';

  // Emergency fail-closed boundary. This script is intentionally loaded in MAIN world before
  // page-bridge.js. Capture-phase handling prevents any destructive edit_playlist request from
  // reaching the bridge, regardless of stale extension settings or an older content-script path.
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== CONTENT || msg.target !== PAGE || !BLOCKED.has(msg.type)) return;

    event.stopImmediatePropagation();
    event.stopPropagation();

    const requestId = msg.requestId;
    queueMicrotask(() => {
      window.postMessage({
        source: PAGE,
        target: CONTENT,
        type: 'EYH_WL_RESULT',
        action: 'blocked-by-safety-lock',
        requestId,
        ok: false,
        error: ERROR
      }, '*');
    });
  }, true);
})();
