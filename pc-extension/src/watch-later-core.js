(() => {
  'use strict';

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const ITEM_KEYS = new Set([
    'playlistVideoRenderer',
    'playlistPanelVideoRenderer',
    'playlistVideoViewModel',
    'lockupViewModel',
    'videoViewModel',
    'videoLockupViewModel',
    'compactVideoViewModel',
    'mediaLockupRenderer'
  ]);

  function normalizeProgressPct(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function normalizeVideoId(value) {
    const s = String(value || '').trim();
    return VIDEO_ID_RE.test(s) ? s : null;
  }

  function normalizeSetVideoId(value) {
    const s = String(value || '').trim();
    if (s.length < 4 || s.length > 512) return null;
    return /^[\x21-\x7E]+$/.test(s) ? s : null;
  }

  function isWatchLaterUrl(raw, base = 'https://www.youtube.com/') {
    try {
      const u = new URL(raw, base);
      return (u.pathname === '/playlist' || u.pathname === '/watch') && u.searchParams.get('list') === 'WL';
    } catch {
      return false;
    }
  }

  function walkJson(root, visitor, maxNodes = 250000) {
    if (!root || typeof root !== 'object') return;
    const seen = new WeakSet();
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < maxNodes) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      visited += 1;
      visitor(node);
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i -= 1) {
          if (node[i] && typeof node[i] === 'object') stack.push(node[i]);
        }
      } else {
        const values = Object.values(node);
        for (let i = values.length - 1; i >= 0; i -= 1) {
          const value = values[i];
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    }
  }

  function collectItemIds(root, videos, setIds, depth = 0) {
    if (!root || typeof root !== 'object' || depth > 20 || videos.size > 1 || setIds.size > 1) return;
    if (Array.isArray(root)) {
      for (const child of root) collectItemIds(child, videos, setIds, depth + 1);
      return;
    }

    const videoId = normalizeVideoId(root.videoId) || normalizeVideoId(root.contentId);
    const setVideoId = normalizeSetVideoId(root.setVideoId) || normalizeSetVideoId(root.playlistSetVideoId);
    if (videoId) videos.add(videoId);
    if (setVideoId) setIds.add(setVideoId);
    if (videos.size > 1 || setIds.size > 1) return;

    for (const child of Object.values(root)) {
      if (child && typeof child === 'object') collectItemIds(child, videos, setIds, depth + 1);
      if (videos.size > 1 || setIds.size > 1) return;
    }
  }

  function addPair(out, videoIdRaw, setVideoIdRaw) {
    const videoId = normalizeVideoId(videoIdRaw);
    const setVideoId = normalizeSetVideoId(setVideoIdRaw);
    if (!videoId || !setVideoId || out.has(setVideoId)) return false;
    out.set(setVideoId, { videoId, setVideoId });
    return true;
  }

  function extractPlaylistEntries(root) {
    const bySetId = new Map();
    walkJson(root, node => {
      // Old renderers and any model that exposes the pair on one object remain the cheapest path.
      addPair(
        bySetId,
        node.videoId || node.contentId,
        node.setVideoId || node.playlistSetVideoId
      );

      // Modern lockup/view-model rows frequently split videoId and setVideoId across descendants
      // (for example, the set id may live in a menu service endpoint). Mirror Android's conservative
      // parser: accept a row only when that item subtree contains exactly one valid video id and one
      // valid setVideoId. Ambiguous rows are deliberately not guessed.
      for (const key of ITEM_KEYS) {
        const item = node[key];
        if (!item || typeof item !== 'object') continue;
        const videos = new Set();
        const setIds = new Set();
        collectItemIds(item, videos, setIds, 0);
        if (videos.size === 1 && setIds.size === 1) {
          addPair(bySetId, [...videos][0], [...setIds][0]);
        }
      }
    });
    return [...bySetId.values()];
  }

  function extractContinuationTokens(root) {
    const out = [];
    const seen = new Set();
    walkJson(root, node => {
      const token = node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
        node?.continuationEndpoint?.continuationCommand?.token ||
        node?.continuationCommand?.token ||
        node?.nextContinuationData?.continuation ||
        node?.reloadContinuationData?.continuation || null;
      if (typeof token !== 'string' || token.length < 8 || token.length >= 8192 || seen.has(token)) return;
      seen.add(token);
      out.push(token);
    }, 80000);
    return out;
  }

  function qualifyCleanup(entries, progressById, threshold) {
    const min = Math.max(1, Math.min(100, Number(threshold) || 60));
    const out = [];
    for (const entry of entries || []) {
      const videoId = normalizeVideoId(entry?.videoId);
      const setVideoId = normalizeSetVideoId(entry?.setVideoId);
      if (!videoId || !setVideoId) continue;
      const progressPct = normalizeProgressPct(progressById?.[videoId]);
      if (progressPct == null || progressPct < min) continue;
      out.push({ videoId, setVideoId, progressPct });
    }
    return out;
  }

  function buildRemoveActions(entries) {
    const seen = new Set();
    const actions = [];
    for (const entry of entries || []) {
      const setVideoId = normalizeSetVideoId(entry?.setVideoId);
      if (!setVideoId || seen.has(setVideoId)) continue;
      seen.add(setVideoId);
      actions.push({ action: 'ACTION_REMOVE_VIDEO', setVideoId });
    }
    return actions;
  }

  globalThis.EYHWatchLaterCore = Object.freeze({
    normalizeProgressPct,
    normalizeVideoId,
    normalizeSetVideoId,
    isWatchLaterUrl,
    extractPlaylistEntries,
    extractContinuationTokens,
    qualifyCleanup,
    buildRemoveActions
  });
})();
