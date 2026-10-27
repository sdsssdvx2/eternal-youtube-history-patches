(() => {
  'use strict';

  const SOURCE = 'eternal-youtube-history-page';
  const TARGET = 'eternal-youtube-history-content';
  const WL = globalThis.EYHWatchLaterCore;
  const OP_RE = /^pcwl-recovery:[A-Za-z0-9:_-]{8,180}$/;
  const inFlight = new Set();

  function cfg(key, fallback = undefined) {
    try { return globalThis.ytcfg?.get?.(key) ?? fallback; } catch { return fallback; }
  }

  function getClientContext() {
    const full = cfg('INNERTUBE_CONTEXT');
    if (full?.client) return structuredClone(full);
    return {
      client: {
        clientName: cfg('INNERTUBE_CLIENT_NAME', 'WEB'),
        clientVersion: cfg('INNERTUBE_CLIENT_VERSION', '2.20261001.00.00'),
        hl: cfg('HL', document.documentElement.lang?.split('-')[0] || 'en'),
        gl: cfg('GL', 'US')
      }
    };
  }

  async function sha1Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function readCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function authHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Bootstrap-Logged-In': 'true',
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME', 1)),
      'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION', '')),
      'X-Origin': location.origin
    };
    const authUser = cfg('SESSION_INDEX');
    if (authUser !== undefined && authUser !== null && authUser !== '') headers['X-Goog-AuthUser'] = String(authUser);
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID') || readCookie('__Secure-1PAPISID');
    if (sapisid) {
      const ts = Math.floor(Date.now() / 1000);
      const hash = await sha1Hex(`${ts} ${sapisid} ${location.origin}`);
      headers.Authorization = `SAPISIDHASH ${ts}_${hash}`;
    }
    const pageId = cfg('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = String(pageId);
    const visitor = cfg('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    return headers;
  }

  async function youtubeApiPost(route, body) {
    const apiKey = cfg('INNERTUBE_API_KEY');
    if (!apiKey) throw new Error('YouTube INNERTUBE_API_KEY를 찾지 못했습니다.');
    const response = await fetch(`/youtubei/v1/${route}?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: await authHeaders(),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`YouTube ${route} 요청 실패: HTTP ${response.status}${text ? ` / ${text.slice(0, 160)}` : ''}`);
    }
    return response.json();
  }

  async function resolveEntry(videoId) {
    const id = WL?.normalizeVideoId?.(videoId);
    if (!id) throw new Error('복구 대상 videoId가 올바르지 않습니다.');
    const json = await youtubeApiPost('next', {
      context: getClientContext(),
      videoId: id,
      playlistId: 'WL',
      contentCheckOk: true,
      racyCheckOk: true
    });
    return (WL.extractPlaylistEntries(json) || []).find(entry => entry.videoId === id) || null;
  }

  async function addMembership(videoId) {
    const id = WL?.normalizeVideoId?.(videoId);
    if (!id) throw new Error('복구 대상 videoId가 올바르지 않습니다.');
    if (await resolveEntry(id)) return { status: 'already_present', videoId: id };

    const json = await youtubeApiPost('browse/edit_playlist', {
      context: getClientContext(),
      playlistId: 'WL',
      actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: id }]
    });
    if (json?.status && json.status !== 'STATUS_SUCCEEDED') {
      throw new Error(`playlist edit status=${json.status}`);
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 250 + attempt * 150));
      if (await resolveEntry(id)) return { status: 'restored', videoId: id };
    }
    throw new Error('복구 요청 뒤에도 Watch Later 멤버십을 확인하지 못했습니다.');
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.origin && event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== TARGET || message.target !== SOURCE) return;
    if (message.type !== 'EYH_WL_RECOVERY_ADD_REQUEST' || !message.requestId) return;
    if (!OP_RE.test(String(message.operationId || ''))) return;

    const id = WL?.normalizeVideoId?.(message.videoId);
    if (!id) {
      window.postMessage({
        source: SOURCE,
        target: TARGET,
        type: 'EYH_WL_RECOVERY_RESULT',
        requestId: message.requestId,
        operationId: message.operationId,
        ok: false,
        error: '복구 대상 videoId가 올바르지 않습니다.'
      }, '*');
      return;
    }

    const key = `${message.operationId}:${id}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    addMembership(id).then(result => {
      window.postMessage({
        source: SOURCE,
        target: TARGET,
        type: 'EYH_WL_RECOVERY_RESULT',
        requestId: message.requestId,
        operationId: message.operationId,
        ok: true,
        ...result
      }, '*');
    }).catch(error => {
      window.postMessage({
        source: SOURCE,
        target: TARGET,
        type: 'EYH_WL_RECOVERY_RESULT',
        requestId: message.requestId,
        operationId: message.operationId,
        ok: false,
        error: String(error?.message || error)
      }, '*');
    }).finally(() => inFlight.delete(key));
  }, true);
})();
