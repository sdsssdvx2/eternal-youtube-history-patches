(() => {
  'use strict';

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

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
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    }
  }

  function extractPlaylistEntries(root) {
    const bySetId = new Map();
    walkJson(root, node => {
      const renderer = node.playlistVideoRenderer || node.playlistPanelVideoRenderer || null;
      if (!renderer || typeof renderer !== 'object') return;
      const videoId = normalizeVideoId(renderer.videoId);
      const setVideoId = normalizeSetVideoId(renderer.setVideoId || renderer.playlistSetVideoId);
      if (!videoId || !setVideoId || bySetId.has(setVideoId)) return;
      bySetId.set(setVideoId, { videoId, setVideoId });
    });
    return [...bySetId.values()];
  }

  function extractContinuationTokens(root) {
    const out = [];
    const seen = new Set();
    walkJson(root, node => {
      const token = node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
        node?.continuationEndpoint?.continuationCommand?.token ||
        node?.continuationCommand?.token || null;
      if (typeof token !== 'string' || token.length < 8 || seen.has(token)) return;
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
