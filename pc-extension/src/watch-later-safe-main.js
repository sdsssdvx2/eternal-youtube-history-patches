(() => {
  'use strict';

  const SOURCE = 'eternal-youtube-history-page';
  const TARGET = 'eternal-youtube-history-content';
  const WL = globalThis.EYHWatchLaterCore;
  const SAFE = globalThis.EYHWatchLaterSafeCore;
  const OP_RE = /^[A-Za-z0-9:_-]{8,160}$/;
  const DIGEST_RE = /^[0-9a-f]{64}$/i;
  const MAX_SAFE_PAGES = 250;
  const MAX_SAFE_ENTRIES = 5000;
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
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
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
    const res = await fetch(`/youtubei/v1/${route}?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: await authHeaders(),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`YouTube ${route} 요청 실패: HTTP ${res.status}${txt ? ` / ${txt.slice(0, 160)}` : ''}`);
    }
    return res.json();
  }

  async function fetchWatchLaterPage(continuation = null) {
    const body = {
      context: getClientContext(),
      contentCheckOk: true,
      racyCheckOk: true
    };
    if (continuation) body.continuation = continuation;
    else body.browseId = 'VLWL';
    const json = await youtubeApiPost('browse', body);
    return {
      entries: WL.extractPlaylistEntries(json) || [],
      continuations: WL.extractContinuationTokens(json) || []
    };
  }

  function appendStrictEntry(raw, ordered, byVideo, bySet) {
    const id = WL?.normalizeVideoId?.(raw?.videoId);
    const setId = WL?.normalizeSetVideoId?.(raw?.setVideoId);
    if (!id || !setId) throw new Error('Watch Later 응답에 모호한 항목 식별자가 있어 전체 목록 확인을 중단합니다.');
    if (byVideo.has(id) && byVideo.get(id) !== setId) {
      throw new Error(`Watch Later videoId ${id}의 setVideoId가 페이지 사이에서 바뀌어 정리를 중단합니다.`);
    }
    if (bySet.has(setId) && bySet.get(setId) !== id) {
      throw new Error('Watch Later 동일 setVideoId가 서로 다른 videoId에 연결되어 정리를 중단합니다.');
    }
    if (byVideo.has(id)) return false;
    byVideo.set(id, setId);
    bySet.set(setId, id);
    ordered.push({ videoId: id, setVideoId: setId });
    if (ordered.length > MAX_SAFE_ENTRIES) {
      throw new Error(`Watch Later 항목이 안전 한도 ${MAX_SAFE_ENTRIES}개를 초과해 정리를 중단합니다.`);
    }
    return true;
  }

  async function strictListWatchLater(maxPages = MAX_SAFE_PAGES) {
    if (!WL || !SAFE) throw new Error('Watch Later 안전 코어가 로드되지 않았습니다.');
    const limit = Math.max(1, Math.min(Number(maxPages) || MAX_SAFE_PAGES, MAX_SAFE_PAGES));
    const ordered = [];
    const byVideo = new Map();
    const bySet = new Map();
    const seenTokens = new Set();
    let continuation = null;
    let pages = 0;

    while (true) {
      const page = await fetchWatchLaterPage(continuation);
      pages += 1;
      let added = 0;
      for (const entry of page.entries) {
        if (appendStrictEntry(entry, ordered, byVideo, bySet)) added += 1;
      }

      const decision = SAFE.paginationDecision(page.continuations, seenTokens, {
        pages,
        added,
        maxPages: limit
      });
      if (decision.complete) {
        return {
          entries: ordered,
          pages,
          complete: true,
          hasMore: false,
          terminalReason: decision.terminalReason,
          strict: true
        };
      }

      seenTokens.add(decision.next);
      continuation = decision.next;
      await new Promise(r => setTimeout(r, 80));
    }
  }

  async function resolveEntry(videoId) {
    const id = WL?.normalizeVideoId?.(videoId);
    if (!id) throw new Error('올바르지 않은 videoId입니다.');
    const json = await youtubeApiPost('next', {
      context: getClientContext(),
      videoId: id,
      playlistId: 'WL',
      contentCheckOk: true,
      racyCheckOk: true
    });
    return (WL.extractPlaylistEntries(json) || []).find(e => e.videoId === id) || null;
  }

  async function safeRemove(videoId, expectedSetVideoId) {
    const id = WL?.normalizeVideoId?.(videoId);
    const expected = WL?.normalizeSetVideoId?.(expectedSetVideoId);
    if (!id || !expected) throw new Error('삭제 대상 식별자가 올바르지 않습니다.');

    // Critical invariant: never trust the setVideoId from the earlier snapshot. Resolve the exact
    // current membership immediately before the destructive request and require the tuple to match.
    const fresh = await resolveEntry(id);
    if (!fresh) return { status: 'missing', removed: 0 };
    if (fresh.setVideoId !== expected) return { status: 'identity_mismatch', removed: 0 };

    const json = await youtubeApiPost('browse/edit_playlist', {
      context: getClientContext(),
      playlistId: 'WL',
      actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: fresh.setVideoId }]
    });
    if (json?.status && json.status !== 'STATUS_SUCCEEDED') {
      throw new Error(`playlist edit status=${json.status}`);
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise(r => setTimeout(r, 250 + attempt * 150));
      if (!(await resolveEntry(id))) return { status: 'removed', removed: 1 };
    }
    throw new Error('삭제 요청 뒤에도 동일 videoId가 Watch Later에 남아 있습니다.');
  }

  async function safeAdd(videoId) {
    const id = WL?.normalizeVideoId?.(videoId);
    if (!id) throw new Error('복구 대상 videoId가 올바르지 않습니다.');
    if (await resolveEntry(id)) return { status: 'already_present', restored: 1 };

    const json = await youtubeApiPost('browse/edit_playlist', {
      context: getClientContext(),
      playlistId: 'WL',
      actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: id }]
    });
    if (json?.status && json.status !== 'STATUS_SUCCEEDED') {
      throw new Error(`playlist edit status=${json.status}`);
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise(r => setTimeout(r, 250 + attempt * 150));
      if (await resolveEntry(id)) return { status: 'restored', restored: 1 };
    }
    throw new Error('복구 요청 뒤에도 Watch Later 멤버십을 확인하지 못했습니다.');
  }

  function validEnvelope(msg) {
    const operationId = String(msg?.operationId || '');
    return operationId.startsWith('pcwl:')
      && OP_RE.test(operationId)
      && DIGEST_RE.test(String(msg?.journalDigest || ''));
  }

  async function handleMutation(msg) {
    if (!WL || !SAFE) throw new Error('Watch Later 안전 코어가 로드되지 않았습니다.');
    if (!validEnvelope(msg)) throw new Error('안전 journal 식별자가 없거나 올바르지 않습니다.');
    const key = `${msg.operationId}:${msg.type}:${msg.videoId || ''}`;
    if (inFlight.has(key)) throw new Error('같은 안전 작업이 이미 진행 중입니다.');
    inFlight.add(key);
    try {
      if (msg.type === 'EYH_WL_SAFE_REMOVE_REQUEST') return safeRemove(msg.videoId, msg.setVideoId);
      if (msg.type === 'EYH_WL_SAFE_ADD_REQUEST') return safeAdd(msg.videoId);
      throw new Error('지원하지 않는 안전 작업입니다.');
    } finally {
      inFlight.delete(key);
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.origin && event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== TARGET || msg.target !== SOURCE) return;
    if (![
      'EYH_WL_SAFE_LIST_REQUEST',
      'EYH_WL_SAFE_REMOVE_REQUEST',
      'EYH_WL_SAFE_ADD_REQUEST'
    ].includes(msg.type)) return;
    const requestId = msg.requestId;

    const task = msg.type === 'EYH_WL_SAFE_LIST_REQUEST'
      ? strictListWatchLater(msg.maxPages)
      : handleMutation(msg);

    task.then(result => {
      window.postMessage({
        source: SOURCE,
        target: TARGET,
        type: 'EYH_WL_SAFE_RESULT',
        requestId,
        operationId: msg.operationId || null,
        action: msg.type === 'EYH_WL_SAFE_LIST_REQUEST' ? 'list'
          : msg.type === 'EYH_WL_SAFE_REMOVE_REQUEST' ? 'remove' : 'add',
        ok: true,
        ...result
      }, '*');
    }).catch(error => {
      window.postMessage({
        source: SOURCE,
        target: TARGET,
        type: 'EYH_WL_SAFE_RESULT',
        requestId,
        operationId: msg.operationId || null,
        ok: false,
        error: String(error?.message || error)
      }, '*');
    });
  }, true);
})();
