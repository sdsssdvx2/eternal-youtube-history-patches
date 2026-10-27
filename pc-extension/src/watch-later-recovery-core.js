(() => {
  'use strict';

  const VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;

  function normalizeVideoId(value) {
    const id = String(value || '').trim();
    return VIDEO_RE.test(id) ? id : null;
  }

  function isYoutubeHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com');
  }

  function cleanTitle(value) {
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    return title.replace(/\s+-\s+YouTube$/i, '').trim();
  }

  function parseHistoryItem(item) {
    try {
      const url = new URL(String(item?.url || ''));
      if (!/^https?:$/.test(url.protocol)) return null;
      if (!isYoutubeHost(url.hostname)) return null;
      if (url.pathname !== '/watch') return null;
      if (url.searchParams.get('list') !== 'WL') return null;
      const videoId = normalizeVideoId(url.searchParams.get('v'));
      if (!videoId) return null;
      const lastVisitTime = Number(item?.lastVisitTime || 0);
      return {
        videoId,
        title: cleanTitle(item?.title),
        lastVisitTime: Number.isFinite(lastVisitTime) && lastVisitTime > 0 ? lastVisitTime : 0,
        evidenceCount: 1
      };
    } catch {
      return null;
    }
  }

  function collectEvidence(items) {
    const byVideo = new Map();
    for (const raw of Array.isArray(items) ? items : []) {
      const parsed = parseHistoryItem(raw);
      if (!parsed) continue;
      const previous = byVideo.get(parsed.videoId);
      if (!previous) {
        byVideo.set(parsed.videoId, parsed);
        continue;
      }
      const next = {
        ...previous,
        evidenceCount: Number(previous.evidenceCount || 1) + 1
      };
      if (parsed.lastVisitTime >= Number(previous.lastVisitTime || 0)) {
        next.lastVisitTime = parsed.lastVisitTime;
        if (parsed.title) next.title = parsed.title;
      }
      byVideo.set(parsed.videoId, next);
    }
    return [...byVideo.values()].sort((a, b) =>
      Number(b.lastVisitTime || 0) - Number(a.lastVisitTime || 0)
        || a.videoId.localeCompare(b.videoId)
    );
  }

  function normalizeCurrentIds(entries) {
    const ids = new Set();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = normalizeVideoId(typeof entry === 'string' ? entry : entry?.videoId);
      if (id) ids.add(id);
    }
    return ids;
  }

  function buildRecoveryCandidates(evidence, currentEntries, progressById = {}) {
    const current = normalizeCurrentIds(currentEntries);
    return (Array.isArray(evidence) ? evidence : [])
      .filter(item => normalizeVideoId(item?.videoId) && !current.has(item.videoId))
      .map(item => {
        const rawProgress = Number(progressById?.[item.videoId]);
        return {
          videoId: item.videoId,
          title: cleanTitle(item.title),
          lastVisitTime: Number(item.lastVisitTime || 0),
          evidenceCount: Math.max(1, Number(item.evidenceCount || 1)),
          progressPct: Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress)) : null
        };
      })
      .sort((a, b) => b.lastVisitTime - a.lastVisitTime || a.videoId.localeCompare(b.videoId));
  }

  const api = {
    normalizeVideoId,
    parseHistoryItem,
    collectEvidence,
    buildRecoveryCandidates
  };

  globalThis.EYHWatchLaterRecoveryCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
