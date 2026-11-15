(() => {
  'use strict';

  // Pure parser for YouTube InnerTube `next` comment responses (WEB client). DOM-free and
  // network-free so it runs in the page MAIN world and in node self-tests. Supports both the
  // legacy `commentRenderer` shape and the 2024+ `commentViewModel` + frameworkUpdates
  // `commentEntityPayload` shape. Unknown shapes simply yield no comments (fail-soft).

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function text(obj) {
    if (obj == null) return '';
    if (typeof obj === 'string') return obj;
    if (typeof obj.simpleText === 'string') return obj.simpleText;
    if (typeof obj.content === 'string') return obj.content;
    if (Array.isArray(obj.runs)) return obj.runs.map(r => r?.text || '').join('');
    return '';
  }

  function tokenOf(node) {
    if (!node || typeof node !== 'object') return null;
    return node.continuationEndpoint?.continuationCommand?.token
      || node.button?.buttonRenderer?.command?.continuationCommand?.token
      || node.continuationCommand?.token
      || null;
  }

  /** First continuation token for the comment section of a `next` response for a videoId. */
  function initialCommentsToken(json) {
    const contents = json?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
    if (Array.isArray(contents)) {
      for (const c of contents) {
        const section = c?.itemSectionRenderer;
        if (!section) continue;
        const id = section.sectionIdentifier || section.targetId || '';
        if (id && !/comment/i.test(id)) continue;
        for (const item of section.contents || []) {
          const token = tokenOf(item?.continuationItemRenderer);
          if (token) return token;
        }
      }
    }
    for (const panel of json?.engagementPanels || []) {
      const p = panel?.engagementPanelSectionListRenderer;
      if (!p || !/comment/i.test(p.panelIdentifier || p.targetId || '')) continue;
      for (const c of p.content?.sectionListRenderer?.contents || []) {
        for (const item of c?.itemSectionRenderer?.contents || []) {
          const token = tokenOf(item?.continuationItemRenderer);
          if (token) return token;
        }
      }
    }
    return null;
  }

  function continuationItems(json) {
    const out = [];
    for (const key of ['onResponseReceivedEndpoints', 'onResponseReceivedActions', 'onResponseReceivedCommands']) {
      for (const action of json?.[key] || []) {
        const items = action?.reloadContinuationItemsCommand?.continuationItems
          || action?.appendContinuationItemsAction?.continuationItems;
        if (Array.isArray(items)) out.push(...items);
      }
    }
    return out;
  }

  function entityMap(json) {
    const map = new Map();
    for (const m of json?.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
      const payload = m?.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (payload.commentEntityPayload) map.set(m.entityKey, payload.commentEntityPayload);
      if (payload.engagementToolbarStateEntityPayload) map.set(m.entityKey, payload.engagementToolbarStateEntityPayload);
    }
    return map;
  }

  function fromLegacy(r, isReply) {
    if (!r || typeof r !== 'object' || !r.commentId) return null;
    return {
      id: String(r.commentId),
      author: text(r.authorText).trim(),
      authorChannelId: r.authorEndpoint?.browseEndpoint?.browseId || null,
      text: text(r.contentText),
      likes: text(r.voteCount).trim(),
      published: text(r.publishedTimeText).trim(),
      replies: Number(r.replyCount || 0) || 0,
      isReply: Boolean(isReply)
    };
  }

  function fromViewModel(vm, entities, isReply) {
    if (!vm || typeof vm !== 'object') return null;
    const e = entities.get(vm.commentKey);
    if (!e) return null;
    const props = e.properties || {};
    const id = props.commentId || vm.commentId;
    if (!id) return null;
    return {
      id: String(id),
      author: String(e.author?.displayName || '').trim(),
      authorChannelId: e.author?.channelId || null,
      text: text(props.content),
      likes: String(e.toolbar?.likeCountNotliked || e.toolbar?.likeCountA11y || '').trim(),
      published: String(props.publishedTime || '').trim(),
      replies: Number(String(e.toolbar?.replyCount || '0').replace(/[^0-9]/g, '')) || 0,
      isReply: Boolean(isReply || Number(props.replyLevel || 0) > 0)
    };
  }

  /**
   * Parse one comment continuation response.
   * @returns {{comments: object[], next: string|null, replyTokens: string[], totalText: string|null}}
   */
  function parseCommentsPage(json, { isReplyPage = false } = {}) {
    const entities = entityMap(json);
    const comments = [];
    const replyTokens = [];
    let next = null;
    let totalText = null;
    for (const item of continuationItems(json)) {
      if (!item || typeof item !== 'object') continue;
      if (item.commentsHeaderRenderer) {
        totalText = text(item.commentsHeaderRenderer.countText) || text(item.commentsHeaderRenderer.commentsCount) || totalText;
        continue;
      }
      if (item.continuationItemRenderer) {
        const token = tokenOf(item.continuationItemRenderer);
        if (token) next = token;
        continue;
      }
      const thread = item.commentThreadRenderer;
      if (thread) {
        const c = fromLegacy(thread.comment?.commentRenderer, false)
          || fromViewModel(thread.commentViewModel?.commentViewModel, entities, false);
        if (c) comments.push(c);
        for (const r of thread.replies?.commentRepliesRenderer?.contents || []) {
          const token = tokenOf(r?.continuationItemRenderer);
          if (token) replyTokens.push(token);
        }
        continue;
      }
      const direct = fromLegacy(item.commentRenderer, isReplyPage)
        || fromViewModel(item.commentViewModel, entities, isReplyPage);
      if (direct) comments.push(direct);
    }
    return { comments, next, replyTokens, totalText };
  }

  function norm(value) {
    let s = String(value ?? '');
    try { s = s.normalize('NFKC'); } catch { }
    return s.toLowerCase();
  }

  function queryTerms(query) {
    const terms = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(query || '')))) {
      const t = norm(m[1] || m[2]).trim();
      if (t) terms.push(t);
    }
    return terms.slice(0, 12);
  }

  /** AND search over comment text + author. Returns matches in original order. */
  function searchComments(comments, query, { limit = 500 } = {}) {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const out = [];
    for (const c of comments || []) {
      const hay = norm(`${c.text}\n${c.author}`);
      if (terms.every(t => hay.includes(t))) {
        out.push(c);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Non-overlapping [start,end) ranges of query terms inside `value` for safe highlighting. */
  function highlightRanges(value, query) {
    const terms = queryTerms(query);
    const hay = norm(value);
    // NFKC can change length; only highlight when normalized length is unchanged.
    if (!terms.length || hay.length !== String(value || '').length) return [];
    const ranges = [];
    for (const t of terms) {
      let from = 0;
      for (;;) {
        const i = hay.indexOf(t, from);
        if (i < 0) break;
        ranges.push([i, i + t.length]);
        from = i + t.length;
        if (ranges.length > 200) break;
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    return merged;
  }

  function isVideoId(value) { return VIDEO_ID_RE.test(String(value || '')); }

  globalThis.EYHCommentSearchCore = Object.freeze({
    initialCommentsToken, parseCommentsPage, searchComments, highlightRanges, queryTerms, isVideoId, text
  });
})();
