(() => {
  'use strict';

  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const pending = new Map();

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }

  function isWatchLaterPage() {
    return location.pathname === '/playlist' && new URLSearchParams(location.search).get('list') === 'WL';
  }

  function declaredWatchLaterCount() {
    const selectors = [
      'ytd-playlist-header-renderer #stats',
      'ytd-playlist-header-renderer #stats yt-formatted-string',
      'ytd-playlist-sidebar-primary-info-renderer #stats'
    ];
    const patterns = [
      /동영상\s*([0-9,]+)\s*개/i,
      /([0-9,]+)\s*개\s*(?:의\s*)?동영상/i,
      /\b([0-9,]+)\s*videos?\b/i
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        for (const raw of [node.textContent, node.getAttribute?.('aria-label')]) {
          const text = String(raw || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (!match) continue;
            const count = Number(match[1].replace(/,/g, ''));
            if (Number.isSafeInteger(count) && count >= 0) return count;
          }
        }
      }
    }
    return null;
  }

  function requestPage(type, payload = {}, responseType, timeoutMs = 600000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${type} 요청 시간이 초과되었습니다.`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout, responseType });
      window.postMessage({ source: CONTENT, target: PAGE, type, requestId, ...payload }, '*');
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== PAGE || message.target !== CONTENT || !message.requestId) return;
    const waiter = pending.get(message.requestId);
    if (!waiter || message.type !== waiter.responseType) return;
    pending.delete(message.requestId);
    clearTimeout(waiter.timeout);
    if (message.ok) waiter.resolve(message);
    else waiter.reject(new Error(message.error || `${message.type} 실패`));
  });

  async function recoverySnapshot() {
    if (!isWatchLaterPage()) throw new Error('복구 비교는 Watch Later 페이지에서만 실행할 수 있습니다.');
    const listed = await requestPage(
      'EYH_WL_SAFE_LIST_REQUEST',
      { maxPages: 250 },
      'EYH_WL_SAFE_RESULT'
    );
    if (listed.strict !== true
        || listed.complete !== true
        || listed.hasMore !== false
        || listed.terminalReason !== 'no-continuation') {
      throw new Error('Watch Later 서버 목록의 끝 지점을 안전하게 확인하지 못했습니다.');
    }
    const entries = Array.isArray(listed.entries) ? listed.entries : [];
    const declared = declaredWatchLaterCount();
    if (declared == null) throw new Error('YouTube 화면의 Watch Later 전체 개수를 확인할 수 없습니다.');
    if (declared < entries.length) {
      throw new Error(`YouTube 표시 개수 ${declared}개보다 안전 파서 결과 ${entries.length}개가 더 많아 복구 비교를 중단합니다.`);
    }

    // Recovery is ADD-only. YouTube may count unavailable/private/deleted tombstones in the playlist
    // header even though they expose no usable videoId+setVideoId pair. Those entries cannot be
    // compared, but allowing the known membership set is safe: each selected candidate is checked
    // again immediately before ADD and an already-present membership is never duplicated.
    return {
      entries: entries.map(entry => ({ videoId: entry.videoId, setVideoId: entry.setVideoId })),
      declaredCount: declared,
      parsedCount: entries.length,
      unparsedCount: declared - entries.length,
      pages: Number(listed.pages || 0)
    };
  }

  async function addOne(operationId, videoId) {
    if (!isWatchLaterPage()) throw new Error('복구는 Watch Later 페이지에서만 실행할 수 있습니다.');
    return requestPage(
      'EYH_WL_RECOVERY_ADD_REQUEST',
      { operationId, videoId },
      'EYH_WL_RECOVERY_RESULT',
      120000
    );
  }

  if (!extensionAlive()) return;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !['EYH_RECOVERY_GET_WL_SNAPSHOT', 'EYH_RECOVERY_ADD_ONE'].includes(message.type)) return false;
    const task = message.type === 'EYH_RECOVERY_GET_WL_SNAPSHOT'
      ? recoverySnapshot()
      : addOne(String(message.operationId || ''), String(message.videoId || ''));
    task.then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });
})();
