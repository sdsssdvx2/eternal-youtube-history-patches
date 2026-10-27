(() => {
  'use strict';

  const SCHEMA = 1;
  const MAX_SNAPSHOT_ENTRIES = 5000;
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function videoId(value) {
    const s = String(value || '').trim();
    return VIDEO_ID_RE.test(s) ? s : null;
  }

  function setVideoId(value) {
    const s = String(value || '').trim();
    if (s.length < 4 || s.length > 512) return null;
    return /^[\x21-\x7E]+$/.test(s) ? s : null;
  }

  function progress(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function threshold(value) {
    return Math.max(1, Math.min(100, Number(value) || 60));
  }

  function normalizeSnapshot(entries, maxEntries = MAX_SNAPSHOT_ENTRIES) {
    if (!Array.isArray(entries)) throw new Error('Watch Later 목록 형식이 올바르지 않습니다.');
    if (entries.length > maxEntries) throw new Error(`Watch Later 항목이 안전 한도 ${maxEntries}개를 초과해 정리를 중단합니다.`);
    const out = [];
    const byVideo = new Map();
    const bySet = new Map();
    for (const raw of entries) {
      const v = videoId(raw?.videoId);
      const s = setVideoId(raw?.setVideoId);
      if (!v || !s) throw new Error('Watch Later 항목 식별자가 모호해 정리를 중단합니다.');
      if (byVideo.has(v) && byVideo.get(v) !== s) throw new Error(`videoId ${v}의 setVideoId가 둘 이상이라 정리를 중단합니다.`);
      if (bySet.has(s) && bySet.get(s) !== v) throw new Error('동일 setVideoId가 서로 다른 videoId에 연결되어 정리를 중단합니다.');
      if (byVideo.has(v)) continue;
      byVideo.set(v, s);
      bySet.set(s, v);
      out.push({ videoId: v, setVideoId: s });
    }
    return out;
  }

  function buildTransaction({ id, now = Date.now(), entries, progressById = {}, cleanupThreshold, pages = 0, hasMore = false }) {
    if (hasMore) throw new Error('Watch Later 전체 목록을 끝까지 읽지 못해 정리를 중단합니다.');
    const snapshot = normalizeSnapshot(entries);
    if (!snapshot.length) throw new Error('Watch Later 항목이 0개로 파싱되어 정리를 중단합니다.');
    const min = threshold(cleanupThreshold);
    const candidates = [];
    for (const entry of snapshot) {
      const pct = progress(progressById?.[entry.videoId]);
      if (pct == null || pct < min) continue;
      candidates.push({ ...entry, progressPct: pct, status: 'prepared', undoStatus: 'pending' });
    }
    return {
      schema: SCHEMA,
      id: String(id || ''),
      createdAt: Number(now),
      updatedAt: Number(now),
      state: 'prepared',
      threshold: min,
      pages: Math.max(0, Number(pages) || 0),
      snapshot,
      candidates,
      removedCount: 0,
      failureCount: 0,
      undoRestoredCount: 0,
      undoFailureCount: 0,
      journalDigest: ''
    };
  }

  function canonicalForDigest(tx) {
    return JSON.stringify({
      schema: Number(tx?.schema || 0),
      id: String(tx?.id || ''),
      createdAt: Number(tx?.createdAt || 0),
      state: String(tx?.state || ''),
      threshold: Number(tx?.threshold || 0),
      pages: Number(tx?.pages || 0),
      snapshot: (tx?.snapshot || []).map(e => ({ videoId: String(e.videoId), setVideoId: String(e.setVideoId) })),
      candidates: (tx?.candidates || []).map(e => ({
        videoId: String(e.videoId), setVideoId: String(e.setVideoId), progressPct: Number(e.progressPct),
        status: String(e.status || ''), undoStatus: String(e.undoStatus || '')
      }))
    });
  }

  function recalcCounts(tx) {
    const candidates = Array.isArray(tx?.candidates) ? tx.candidates : [];
    tx.removedCount = candidates.filter(e => e.status === 'removed').length;
    tx.failureCount = candidates.filter(e => ['failed', 'identity_mismatch', 'missing'].includes(e.status)).length;
    tx.undoRestoredCount = candidates.filter(e => ['restored', 'already_present'].includes(e.undoStatus)).length;
    tx.undoFailureCount = candidates.filter(e => e.undoStatus === 'failed').length;
    return tx;
  }

  function undoVideoIds(tx) {
    const out = [];
    const seen = new Set();
    for (const e of tx?.candidates || []) {
      const v = videoId(e?.videoId);
      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  }

  globalThis.EYHWatchLaterSafeCore = Object.freeze({
    SCHEMA,
    MAX_SNAPSHOT_ENTRIES,
    videoId,
    setVideoId,
    progress,
    threshold,
    normalizeSnapshot,
    buildTransaction,
    canonicalForDigest,
    recalcCounts,
    undoVideoIds
  });
})();
