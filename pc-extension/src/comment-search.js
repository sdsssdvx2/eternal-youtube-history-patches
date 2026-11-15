(() => {
  'use strict';

  // Watch-page comment search. Adds one "댓글" button to the existing Eternal masthead group and a
  // small panel. Comments are fetched read-only through comment-search-main.js (InnerTube `next`),
  // paced and capped, cached in memory for the last few videos only, and searched locally.
  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const CORE = globalThis.EYHCommentSearchCore;
  const BUTTON_ID = 'eyh-comment-search';
  const PANEL_ID = 'eyh-comment-panel';
  const MAX_PAGES = 200;          // ~20 comments/page → up to ~4,000 top-level comments
  const MAX_REPLY_PAGES = 120;
  const PAGE_DELAY_MS = 180;
  const CACHE_VIDEOS = 3;
  const RETRY_DELAYS = [0, 150, 600, 1500];

  const pending = new Map();
  const cache = new Map();        // videoId -> state
  let renderQueued = false;
  let activeVideoId = null;

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }

  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    const id = new URLSearchParams(location.search).get('v');
    return CORE?.isVideoId(id) ? id : null;
  }

  function request(payload, timeoutMs = 30000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('댓글 요청 시간이 초과되었습니다.')); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      window.postMessage({ source: CONTENT, target: PAGE, type: 'EYH_COMMENTS_REQUEST', requestId, ...payload }, '*');
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE || msg.target !== CONTENT || msg.type !== 'EYH_COMMENTS_RESULT') return;
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    clearTimeout(p.timeout);
    if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || '댓글 요청 실패'));
  });

  function stateFor(videoId) {
    let s = cache.get(videoId);
    if (s) { cache.delete(videoId); cache.set(videoId, s); return s; }
    s = { videoId, comments: [], ids: new Set(), next: undefined, replyTokens: [], pages: 0, replyPages: 0,
      loading: false, stop: false, done: false, repliesDone: false, totalText: null, error: null, disabled: false };
    cache.set(videoId, s);
    while (cache.size > CACHE_VIDEOS) cache.delete(cache.keys().next().value);
    return s;
  }

  function addComments(s, list) {
    for (const c of list || []) {
      if (!c?.id || s.ids.has(c.id)) continue;
      s.ids.add(c.id);
      s.comments.push(c);
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function load(s, { includeReplies }) {
    if (s.loading) return;
    s.loading = true; s.stop = false; s.error = null;
    renderPanel();
    try {
      while (!s.stop && !s.done && s.pages < MAX_PAGES) {
        const r = s.next === undefined
          ? await request({ videoId: s.videoId })
          : await request({ continuation: s.next });
        s.pages += 1;
        if (r.disabled) s.disabled = true;
        if (r.totalText) s.totalText = r.totalText;
        addComments(s, r.comments);
        s.replyTokens.push(...(r.replyTokens || []));
        s.next = r.next || null;
        if (!s.next) s.done = true;
        renderPanel();
        if (activeVideoId !== s.videoId) return;
        await sleep(PAGE_DELAY_MS);
      }
      if (includeReplies) {
        while (!s.stop && s.replyTokens.length && s.replyPages < MAX_REPLY_PAGES) {
          const token = s.replyTokens.shift();
          const r = await request({ continuation: token, isReplyPage: true });
          s.replyPages += 1;
          addComments(s, r.comments);
          if (r.next) s.replyTokens.unshift(r.next);
          renderPanel();
          if (activeVideoId !== s.videoId) return;
          await sleep(PAGE_DELAY_MS);
        }
        if (!s.replyTokens.length) s.repliesDone = true;
      }
    } catch (error) {
      s.error = String(error?.message || error);
    } finally {
      s.loading = false;
      renderPanel();
    }
  }

  // ---------- UI ----------

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function highlighted(value, query) {
    const frag = document.createDocumentFragment();
    const s = String(value || '');
    let pos = 0;
    for (const [a, b] of CORE.highlightRanges(s, query)) {
      if (a > pos) frag.append(s.slice(pos, a));
      frag.append(el('mark', { text: s.slice(a, b) }));
      pos = b;
    }
    if (pos < s.length) frag.append(s.slice(pos));
    return frag;
  }

  function jumpTo(comment) {
    // Prefer scrolling to an already-rendered comment; otherwise open the permalink that YouTube
    // pins to the top of the comment list (new tab, so current playback is not interrupted).
    const link = document.querySelector(`ytd-comments a[href*="lc=${CSS.escape(comment.id)}"]`);
    const host = link?.closest('ytd-comment-thread-renderer, ytd-comment-view-model, ytd-comment-renderer');
    if (host) { host.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(activeVideoId)}&lc=${encodeURIComponent(comment.id)}`, '_blank', 'noopener');
  }

  let queryValue = '';
  let includeRepliesValue = false;
  let renderTimer = null;

  function renderPanel() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; paintPanel(); }, 60);
  }

  function paintPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const s = activeVideoId ? cache.get(activeVideoId) : null;
    const status = panel.querySelector('.eyh-cs-status');
    const list = panel.querySelector('.eyh-cs-results');
    const action = panel.querySelector('.eyh-cs-load');
    if (!s) { status.textContent = '영상 페이지에서만 사용할 수 있습니다.'; list.replaceChildren(); return; }

    const loaded = s.comments.length.toLocaleString('ko-KR');
    let line = `불러온 댓글 ${loaded}개`;
    if (s.totalText) line += ` / ${s.totalText}`;
    if (s.loading) line += ' · 불러오는 중…';
    else if (s.disabled) line = '이 영상은 댓글이 꺼져 있거나 불러올 수 없습니다.';
    else if (s.done && (!includeRepliesValue || s.repliesDone)) line += ' · 전부 불러옴';
    else if (s.pages >= MAX_PAGES) line += ` · 상한(${MAX_PAGES}페이지) 도달`;
    if (s.error) line += ` · 오류: ${s.error}`;
    status.textContent = line;
    status.dataset.kind = s.error ? 'error' : '';

    action.textContent = s.loading ? '중지' : (s.done && (!includeRepliesValue || s.repliesDone) ? '다시 불러오기' : '더 불러오기');

    const q = queryValue.trim();
    if (!q) { list.replaceChildren(el('div', { class: 'eyh-cs-empty', text: '검색어를 입력하세요. 여러 단어는 모두 포함, "따옴표"는 구문 검색입니다.' })); return; }
    const matches = CORE.searchComments(s.comments, q, { limit: 300 });
    const head = el('div', { class: 'eyh-cs-count', text: `${matches.length >= 300 ? '300+' : matches.length}개 일치` });
    const items = matches.map(c => el('button', { type: 'button', class: 'eyh-cs-item', title: '이 댓글로 이동', onclick: () => jumpTo(c) },
      el('div', { class: 'eyh-cs-meta' }, highlighted(c.author || '(이름 없음)', q),
        document.createTextNode(` · ${c.published || ''}${c.likes ? ` · 좋아요 ${c.likes}` : ''}${c.isReply ? ' · 답글' : ''}`)),
      el('div', { class: 'eyh-cs-text' }, highlighted(c.text, q))));
    list.replaceChildren(head, ...items);
  }

  function closePanel() { document.getElementById(PANEL_ID)?.remove(); }

  function openPanel() {
    closePanel();
    const videoId = currentVideoId();
    if (!videoId) return;
    activeVideoId = videoId;
    const s = stateFor(videoId);

    const input = el('input', { type: 'search', class: 'eyh-cs-input', placeholder: '댓글 검색', 'aria-label': '댓글 검색어' });
    input.value = queryValue;
    input.addEventListener('input', () => { queryValue = input.value; renderPanel(); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); e.stopPropagation(); });
    input.addEventListener('keyup', e => e.stopPropagation());
    input.addEventListener('keypress', e => e.stopPropagation());

    const replies = el('input', { type: 'checkbox' });
    replies.checked = includeRepliesValue;
    replies.addEventListener('change', () => {
      includeRepliesValue = replies.checked;
      if (includeRepliesValue) load(stateFor(activeVideoId), { includeReplies: true });
      renderPanel();
    });

    const loadButton = el('button', { type: 'button', class: 'eyh-cs-load', onclick: () => {
      const st = stateFor(activeVideoId);
      if (st.loading) { st.stop = true; return; }
      if (st.done && (!includeRepliesValue || st.repliesDone)) {
        cache.delete(activeVideoId);
        load(stateFor(activeVideoId), { includeReplies: includeRepliesValue });
        return;
      }
      load(st, { includeReplies: includeRepliesValue });
    } });

    const panel = el('div', { id: PANEL_ID, role: 'dialog', 'aria-label': 'Eternal 댓글 검색' },
      el('div', { class: 'eyh-cs-head' },
        el('strong', { text: '댓글 검색' }),
        el('button', { type: 'button', class: 'eyh-cs-close', 'aria-label': '닫기', text: '✕', onclick: closePanel })),
      input,
      el('div', { class: 'eyh-cs-row' }, el('label', {}, replies, document.createTextNode(' 답글도 불러오기')), loadButton),
      el('div', { class: 'eyh-cs-status', 'aria-live': 'polite' }),
      el('div', { class: 'eyh-cs-results' }));
    document.documentElement.appendChild(panel);
    input.focus();
    paintPanel();
    if (s.next === undefined && !s.loading) load(s, { includeReplies: includeRepliesValue });
  }

  function render() {
    renderQueued = false;
    const root = document.querySelector('#eyh-header-controls');
    const videoId = currentVideoId();
    let button = document.getElementById(BUTTON_ID);
    if (!root || !videoId) {
      button?.remove();
      if (!videoId) closePanel();
      return;
    }
    if (!button || button.parentElement !== root) {
      button?.remove();
      button = el('button', { type: 'button', id: BUTTON_ID, class: 'eyh-header-button', text: '댓글', title: '이 영상의 댓글 검색' });
      root.insertBefore(button, root.querySelector('#eyh-header-status'));
    }
    if (activeVideoId && activeVideoId !== videoId) {
      const old = cache.get(activeVideoId);
      if (old) old.stop = true;
      if (document.getElementById(PANEL_ID)) openPanel();
      else activeVideoId = videoId;
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => { try { render(); } catch { renderQueued = false; } });
  }

  function scheduleRenderRetries() { for (const d of RETRY_DELAYS) setTimeout(scheduleRender, d); }

  if (!CORE || !extensionAlive()) return;

  document.addEventListener('click', event => {
    if (event.target?.closest?.(`#${BUTTON_ID}`)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (document.getElementById(PANEL_ID)) closePanel(); else openPanel();
    }
  }, true);
  window.addEventListener('yt-navigate-finish', scheduleRenderRetries, true);
  window.addEventListener('popstate', scheduleRenderRetries, true);
  scheduleRenderRetries();
})();
