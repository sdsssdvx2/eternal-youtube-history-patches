(() => {
  'use strict';

  // MAIN-world, read-only InnerTube bridge for comment search. It only ever calls the public
  // `next` endpoint (the same request YouTube makes when you scroll to comments) and never
  // writes anything. One request per message; pacing is owned by comment-search.js.
  const SOURCE = 'eternal-youtube-history-page';
  const TARGET = 'eternal-youtube-history-content';
  const CORE = globalThis.EYHCommentSearchCore;

  function cfg(key, fallback = undefined) {
    try { return globalThis.ytcfg?.get?.(key) ?? fallback; } catch { return fallback; }
  }

  function clientContext() {
    const full = cfg('INNERTUBE_CONTEXT');
    if (full?.client) return structuredClone(full);
    return {
      client: {
        clientName: 'WEB',
        clientVersion: cfg('INNERTUBE_CLIENT_VERSION', '2.20261101.00.00'),
        hl: cfg('HL', document.documentElement.lang?.split('-')[0] || 'ko'),
        gl: cfg('GL', 'KR')
      }
    };
  }

  async function next(body) {
    const key = cfg('INNERTUBE_API_KEY');
    const url = `/youtubei/v1/next?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME', 1)),
      'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION', ''))
    };
    const visitor = cfg('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const res = await fetch(url, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
      body: JSON.stringify({ context: clientContext(), ...body })
    });
    if (!res.ok) throw new Error(`YouTube 댓글 요청 실패: HTTP ${res.status}`);
    return res.json();
  }

  async function handle(msg) {
    if (!CORE) throw new Error('댓글 검색 모듈이 로드되지 않았습니다.');
    if (msg.continuation) {
      const json = await next({ continuation: String(msg.continuation) });
      return CORE.parseCommentsPage(json, { isReplyPage: Boolean(msg.isReplyPage) });
    }
    if (!CORE.isVideoId(msg.videoId)) throw new Error('현재 영상 ID를 확인할 수 없습니다.');
    const watch = await next({ videoId: msg.videoId, racyCheckOk: true, contentCheckOk: true });
    const token = CORE.initialCommentsToken(watch);
    if (!token) return { comments: [], next: null, replyTokens: [], totalText: null, disabled: true };
    const json = await next({ continuation: token });
    return CORE.parseCommentsPage(json);
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== TARGET || msg.target !== SOURCE || msg.type !== 'EYH_COMMENTS_REQUEST') return;
    const requestId = msg.requestId;
    handle(msg)
      .then(result => window.postMessage({ source: SOURCE, target: TARGET, type: 'EYH_COMMENTS_RESULT', requestId, ok: true, ...result }, '*'))
      .catch(error => window.postMessage({ source: SOURCE, target: TARGET, type: 'EYH_COMMENTS_RESULT', requestId, ok: false, error: String(error?.message || error) }, '*'));
  });
})();
