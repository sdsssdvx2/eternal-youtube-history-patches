(() => {
  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const watchedCache = new Map();
  const progressCache = new Map();
  let watchedDisplayMode = 'dim';
  let watchedMinProgressPct = 0;
  let watchedThumbnailOpacityPct = 65;
  let watchedThumbnailGrayscale = false;
  let watchedLinkCardInfo = false;
  let pendingHistory = new Map();
  let scanTimer = null;
  let currentVideoId = null;
  let currentVideoEl = null;
  let directTimer = null;
  let directRecorded = false;
  let lastProgressSent = null;
  let activeSyncInFlight = null;
  let lastActiveSyncRequestAt = 0;

  function normalizeProgressPct(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function currentVideoProgressPct(el = currentVideoEl) {
    const duration = Number(el?.duration || 0);
    const current = Number(el?.currentTime || 0);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(current) || current < 0) return null;
    return normalizeProgressPct((current / duration) * 100);
  }

  async function syncServerWhileActive({ force = false } = {}) {
    if (document.visibilityState === 'hidden') return null;
    const now = Date.now();
    if (!force && now - lastActiveSyncRequestAt < 60_000) return null;
    if (activeSyncInFlight) return activeSyncInFlight;
    lastActiveSyncRequestAt = now;
    activeSyncInFlight = chrome.runtime.sendMessage({ type: 'ACTIVE_YOUTUBE_SYNC', force })
      .then(result => {
        if (Number(result?.pulled?.imported || 0) > 0) {
          watchedCache.clear();
          progressCache.clear();
          scheduleScan();
        }
        return result;
      })
      .catch(() => null)
      .finally(() => { activeSyncInFlight = null; });
    return activeSyncInFlight;
  }

  async function loadDisplaySettings() {
    const v = await chrome.storage.local.get({
      watchedDisplayMode: 'dim',
      watchedMinProgressPct: 0,
      watchedThumbnailOpacityPct: 65,
      watchedThumbnailGrayscale: false,
      watchedLinkCardInfo: false
    });
    watchedDisplayMode = ['dim','hide','none'].includes(v.watchedDisplayMode) ? v.watchedDisplayMode : 'dim';
    watchedMinProgressPct = Math.max(0, Math.min(100, Number(v.watchedMinProgressPct) || 0));
    watchedThumbnailOpacityPct = Math.max(10, Math.min(100, Number(v.watchedThumbnailOpacityPct) || 65));
    watchedThumbnailGrayscale = Boolean(v.watchedThumbnailGrayscale);
    watchedLinkCardInfo = Boolean(v.watchedLinkCardInfo);
    document.documentElement.style.setProperty('--eyh-watched-opacity', String(watchedThumbnailOpacityPct / 100));
  }

  function nativeProgressPct(container) {
    if (!container?.querySelector) return null;
    const progressEl = container.querySelector(
      'ytd-thumbnail-overlay-resume-playback-renderer #progress, ' +
      'yt-thumbnail-overlay-progress-bar-view-model [style*="width"], ' +
      '[class*="progress"][style*="width"], [id*="progress"][style*="width"], progress'
    );
    if (!progressEl) return null;

    const aria = normalizeProgressPct(progressEl.getAttribute?.('aria-valuenow'));
    if (aria != null) return aria;

    if (progressEl.tagName === 'PROGRESS') {
      const value = Number(progressEl.value);
      const max = Number(progressEl.max || 100);
      if (Number.isFinite(value) && Number.isFinite(max) && max > 0) return normalizeProgressPct((value / max) * 100);
    }

    const style = progressEl.getAttribute?.('style') || '';
    const m = style.match(/width\s*:\s*([0-9.]+)%/i);
    if (m) return normalizeProgressPct(m[1]);

    const width = parseFloat(getComputedStyle(progressEl).width);
    const parentWidth = parseFloat(getComputedStyle(progressEl.parentElement).width);
    if (Number.isFinite(width) && Number.isFinite(parentWidth) && parentWidth > 0) {
      return normalizeProgressPct((width / parentWidth) * 100);
    }
    return null;
  }

  function videoIdFromUrl(raw = location.href) {
    try {
      const u = new URL(raw, location.origin);
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v');
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
      }
      const m = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
      return m?.[1] || null;
    } catch {
      return null;
    }
  }

  function titleAndChannel() {
    const title = document.querySelector('h1 yt-formatted-string, h1.title, #title h1')?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, '').trim() || null;
    const channelName = document.querySelector('ytd-watch-metadata #channel-name a, #owner #channel-name a, ytd-channel-name a')?.textContent?.trim() || null;
    const channelHref = document.querySelector('ytd-watch-metadata #channel-name a, #owner #channel-name a, ytd-channel-name a')?.getAttribute('href') || '';
    const channelId = channelHref.match(/^\/channel\/(UC[A-Za-z0-9_-]+)/)?.[1] || null;
    return { title, channelName, channelId };
  }

  async function recordDirectWatch(videoId) {
    if (!videoId || videoId !== videoIdFromUrl() || directRecorded) return;
    directRecorded = true;
    const meta = titleAndChannel();
    const watchedAt = Date.now();
    const progressPct = currentVideoProgressPct();
    await chrome.runtime.sendMessage({
      type: 'UPSERT_WATCH',
      records: [{
        videoId,
        ...meta,
        source: 'pc-direct',
        preciseWatchedAt: watchedAt,
        discoveredAt: watchedAt,
        historyDateLabel: null,
        maxProgressPct: progressPct
      }],
      events: [{
        eventId: `pc-direct:${crypto.randomUUID()}`,
        videoId,
        ...meta,
        source: 'pc-direct',
        watchedAt,
        discoveredAt: watchedAt,
        historyDateLabel: null
      }]
    });
    watchedCache.set(videoId, true);
    if (progressPct != null) {
      progressCache.set(videoId, progressPct);
      lastProgressSent = progressPct;
    }
    scheduleScan();
  }

  async function bindVideoWatcher() {
    const vid = videoIdFromUrl();
    if (!vid) {
      currentVideoId = null;
      currentVideoEl = null;
      directRecorded = false;
      lastProgressSent = null;
      clearTimeout(directTimer);
      return;
    }
    const el = document.querySelector('video.html5-main-video, video');
    if (!el) return;
    if (currentVideoId === vid && currentVideoEl === el) return;

    currentVideoId = vid;
    currentVideoEl = el;
    directRecorded = false;
    lastProgressSent = null;
    clearTimeout(directTimer);

    const maybeRecord = async () => {
      const { directWatchSeconds = 5 } = await chrome.storage.local.get({ directWatchSeconds: 5 });
      if (currentVideoId !== vid || currentVideoEl !== el) return;
      if (!el.paused && Number(el.currentTime || 0) >= Number(directWatchSeconds || 5)) {
        await recordDirectWatch(vid).catch(() => {});
      }
      if (directRecorded) {
        const pct = currentVideoProgressPct(el);
        if (pct != null && (lastProgressSent == null || pct >= lastProgressSent + 5 || pct >= 99.5)) {
          lastProgressSent = pct;
          progressCache.set(vid, Math.max(progressCache.get(vid) ?? 0, pct));
          chrome.runtime.sendMessage({ type: 'UPDATE_PROGRESS', entries: [{ videoId: vid, progressPct: pct }] }).catch(() => {});
        }
      }
    };

    const onTime = () => maybeRecord().catch(() => {});
    el.addEventListener('timeupdate', onTime, { passive: true });
    el.addEventListener('playing', onTime, { passive: true });
    el.addEventListener('ended', () => {
      if (currentVideoId === vid) {
        lastProgressSent = 100;
        progressCache.set(vid, 100);
        chrome.runtime.sendMessage({ type: 'UPDATE_PROGRESS', entries: [{ videoId: vid, progressPct: 100 }] }).catch(() => {});
        scheduleScan();
      }
    }, { passive: true });
    directTimer = setTimeout(() => maybeRecord().catch(() => {}), 7000);
  }

  function idFromAnchor(a) {
    const href = a?.getAttribute?.('href');
    if (!href) return null;
    return videoIdFromUrl(new URL(href, location.origin).href);
  }

  function candidateContainer(a) {
    return a.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-rich-grid-media, ytd-thumbnail') || a.parentElement;
  }

  async function scanAndMark() {
    scanTimer = null;
    const map = new Map();
    for (const a of document.querySelectorAll('a[href*="watch?v="], a[href^="/shorts/"]')) {
      const id = idFromAnchor(a);
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(a);
    }
    const unknown = [...map.keys()].filter(id => !watchedCache.has(id));
    if (unknown.length) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: unknown });
        for (const id of unknown) {
          watchedCache.set(id, Boolean(resp?.watched?.[id]));
          progressCache.set(id, normalizeProgressPct(resp?.progress?.[id]));
        }
      } catch {}
    }
    for (const [id, anchors] of map) {
      const watched = watchedCache.get(id) === true;
      for (const a of anchors) {
        const c = candidateContainer(a);
        if (!c) continue;
        const storedProgress = normalizeProgressPct(progressCache.get(id));
        const cardProgress = nativeProgressPct(c);
        const effectiveProgress = storedProgress == null ? cardProgress : (cardProgress == null ? storedProgress : Math.max(storedProgress, cardProgress));
        const matchesProgress = watchedMinProgressPct <= 0 || (effectiveProgress != null && effectiveProgress >= watchedMinProgressPct);
        const matches = watched && matchesProgress && watchedDisplayMode !== 'none';
        const dimmed = matches && watchedDisplayMode === 'dim';
        c.classList.toggle('eyh-watched', dimmed);
        c.classList.toggle('eyh-watched-linked', dimmed && watchedLinkCardInfo);
        c.classList.toggle('eyh-watched-grayscale', dimmed && watchedThumbnailGrayscale);
        c.classList.toggle('eyh-hidden', matches && watchedDisplayMode === 'hide');
        c.dataset.eyhVideoId = id;
        if (effectiveProgress != null) c.dataset.eyhProgressPct = String(Math.round(effectiveProgress));
        else delete c.dataset.eyhProgressPct;
      }
    }
    bindVideoWatcher().catch(() => {});
  }

  function scheduleScan() {
    if (document.visibilityState === 'hidden') return;
    if (scanTimer) return;
    scanTimer = setTimeout(scanAndMark, 650);
  }

  function normalizeHistoryDateLabel(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const now = new Date();
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (/^오늘$/i.test(s)) return ymd(now);
    if (/^어제$/i.test(s)) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return ymd(d);
    }
    let m = s.match(/(?:(\d{4})\s*[.\-/년]\s*)?(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/);
    if (!m) return s;
    let year = m[1] ? Number(m[1]) : now.getFullYear();
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!m[1]) {
      const candidate = new Date(year, month - 1, day);
      if (candidate.getTime() > now.getTime() + 7 * 86400000) year -= 1;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return s;
    return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  function historyDateLabelFromCard(card) {
    const section = card?.closest?.('ytd-item-section-renderer');
    const candidates = [
      section?.querySelector?.('ytd-item-section-header-renderer #title'),
      section?.querySelector?.('ytd-item-section-header-renderer yt-formatted-string'),
      section?.querySelector?.('#header ytd-item-section-header-renderer'),
      section?.querySelector?.(':scope > #header #title')
    ];
    for (const el of candidates) {
      const t = el?.textContent?.trim();
      if (t) return normalizeHistoryDateLabel(t);
    }
    return null;
  }

  function historyDomRecordFromCard(card) {
    if (!card?.querySelector) return null;
    const a = card.querySelector('a#thumbnail[href*="watch?v="], a[href*="watch?v="], a[href*="/shorts/"]');
    const videoId = idFromAnchor(a);
    if (!videoId) return null;
    const title = card.querySelector('#video-title, a#video-title, yt-formatted-string#video-title, h3 a, .yt-lockup-metadata-view-model__title')?.textContent?.trim() || a?.getAttribute('title')?.trim() || null;
    const channelAnchor = card.querySelector('ytd-channel-name a, #channel-name a, #metadata a[href^="/@"], #metadata a[href^="/channel/"]');
    const channelName = channelAnchor?.textContent?.trim() || null;
    const channelHref = channelAnchor?.getAttribute('href') || '';
    const channelId = channelHref.match(/^\/channel\/(UC[A-Za-z0-9_-]+)/)?.[1] || null;
    return { videoId, title, channelName, channelId, historyDateLabel: historyDateLabelFromCard(card), maxProgressPct: nativeProgressPct(card) };
  }

  function scrapeHistoryDom() {
    if (!location.pathname.startsWith('/feed/history')) return [];
    const out = [];
    const seen = new Set();
    const root = document.querySelector('ytd-browse[page-subtype="history"], ytd-browse') || document;
    const cards = root.querySelectorAll(
      'ytd-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ' +
      'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-rich-item-renderer'
    );
    for (const card of cards) {
      const rec = historyDomRecordFromCard(card);
      if (!rec || seen.has(rec.videoId)) continue;
      seen.add(rec.videoId);
      out.push(rec);
    }

    // Always do a second anchor pass. YouTube can mix old video renderers with a new
    // Shorts shelf in the same History page. v0.6.0 returned early as soon as one
    // normal video card was found, which silently dropped Shorts rendered by a newer
    // lockup component. The anchor pass only fills IDs not already found above.
    for (const a of root.querySelectorAll('a#thumbnail[href*="watch?v="], a[href*="watch?v="], a[href*="/shorts/"]')) {
      const videoId = idFromAnchor(a);
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      const card = candidateContainer(a);
      out.push({
        videoId,
        title: card?.querySelector?.('#video-title, a#video-title, h3 a')?.textContent?.trim() || a.getAttribute('title')?.trim() || null,
        channelName: card?.querySelector?.('ytd-channel-name a, #channel-name a')?.textContent?.trim() || null,
        channelId: null,
        historyDateLabel: historyDateLabelFromCard(card),
        maxProgressPct: nativeProgressPct(card)
      });
    }
    return out;
  }

  function domSignature(records) {
    return (records || []).slice(0, 8).map(r => r.videoId).join('|');
  }

  async function waitForHistoryDom(timeoutMs = 10000) {
    const started = Date.now();
    let last = [];
    let lastSig = '';
    let lastChangedAt = started;
    let firstNonEmptyAt = null;

    while (Date.now() - started < timeoutMs) {
      const current = scrapeHistoryDom();
      const sig = domSignature(current);
      if (current.length && firstNonEmptyAt == null) firstNonEmptyAt = Date.now();
      if (sig && sig !== lastSig) {
        last = current;
        lastSig = sig;
        lastChangedAt = Date.now();
      } else if (current.length) {
        last = current;
      }

      // Do not trust an immediately-rendered stale snapshot. Give YouTube at least
      // 3.5s after the first history cards appear and require 1s of DOM stability.
      if (last.length && firstNonEmptyAt != null &&
          Date.now() - firstNonEmptyAt >= 3500 && Date.now() - lastChangedAt >= 1000) {
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return { records: last, waitedMs: Date.now() - started, signature: lastSig };
  }

  function requestHistory(maxPages, { useLoadedPage = false } = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingHistory.delete(requestId);
        reject(new Error('History 동기화 응답 시간이 초과되었습니다. YouTube 탭을 새로고침한 뒤 다시 시도하세요.'));
      }, 600000);
      pendingHistory.set(requestId, { resolve, reject, timeout });
      window.postMessage({ source: CONTENT, target: PAGE, type: 'EYH_REQUEST_HISTORY', requestId, maxPages, useLoadedPage }, '*');
    });
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE || msg.target !== CONTENT) return;

    if (msg.type === 'EYH_HISTORY_PROGRESS') {
      chrome.runtime.sendMessage({ type: 'HISTORY_PROGRESS', pages: msg.pages, count: msg.count }).catch(() => {});
      return;
    }
    if (msg.type === 'EYH_HISTORY_RESULT') {
      const p = pendingHistory.get(msg.requestId);
      if (!p) return;
      pendingHistory.delete(msg.requestId);
      clearTimeout(p.timeout);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'History 동기화 실패'));
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'SYNC_HISTORY') {
      (async () => {
        const useLoadedPage = Boolean(msg.useLoadedPage);
        const dom = useLoadedPage && location.pathname.startsWith('/feed/history')
          ? await waitForHistoryDom(10000)
          : { records: [], waitedMs: 0, signature: '' };

        const result = await requestHistory(msg.maxPages || 3, { useLoadedPage });
        const merged = new Map();
        // DOM first: on a real top-level History load this is the source closest to
        // what the user actually sees, and can be newer than ytInitialData.
        for (const r of dom.records || []) if (!merged.has(r.videoId)) merged.set(r.videoId, r);
        for (const r of result.records || []) if (!merged.has(r.videoId)) merged.set(r.videoId, r);

        const latestRecord = dom.records?.[0] || result.latestRecord || [...merged.values()][0] || null;
        let latestAlreadyKnown = null;
        if (latestRecord?.videoId) {
          const before = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: [latestRecord.videoId] }).catch(() => null);
          latestAlreadyKnown = Boolean(before?.watched?.[latestRecord.videoId]);
        }

        const now = Date.now();
        const records = [...merged.values()].map(r => ({
          ...r,
          source: 'youtube-history',
          preciseWatchedAt: null,
          discoveredAt: now
        }));
        const stored = await chrome.runtime.sendMessage({ type: 'UPSERT_RECORDS', records });
        for (const r of records) {
          watchedCache.set(r.videoId, true);
          if (normalizeProgressPct(r.maxProgressPct) != null) progressCache.set(r.videoId, normalizeProgressPct(r.maxProgressPct));
        }
        scheduleScan();

        return {
          ok: true,
          pages: result.pages,
          hasMore: result.hasMore,
          fetched: records.length,
          apiFetched: (result.records || []).length,
          domFetched: (dom.records || []).length,
          stored: stored?.stored || 0,
          inserted: stored?.inserted || 0,
          latestRecord,
          latestAlreadyKnown,
          loopDetected: Boolean(result.loopDetected),
          stopReason: result.stopReason || null,
          pageStats: result.pageStats || [],
          diagnostics: {
            pageUrl: location.href,
            domWaitedMs: dom.waitedMs || 0,
            domTop: (dom.records || []).slice(0, 3).map(r => ({ videoId: r.videoId, title: r.title || null })),
            apiTop: (result.records || []).slice(0, 3).map(r => ({ videoId: r.videoId, title: r.title || null })),
            firstApiResponseSource: result.pageStats?.[0]?.responseSource || null
          }
        };
      })()
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    if (msg?.type === 'RESCAN') {
      watchedCache.clear();
      progressCache.clear();
      scheduleScan();
      sendResponse({ ok: true });
    }
  });

  loadDisplaySettings().then(scheduleScan).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.watchedDisplayMode || changes.watchedMinProgressPct || changes.watchedThumbnailOpacityPct || changes.watchedThumbnailGrayscale || changes.watchedLinkCardInfo) {
      loadDisplaySettings().then(() => {
        watchedCache.clear();
        progressCache.clear();
        scheduleScan();
      }).catch(() => {});
    }
  });

  const observer = new MutationObserver(mutations => {
    if (document.visibilityState === 'hidden') return;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length) {
        scheduleScan();
        bindVideoWatcher().catch(() => {});
        break;
      }
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });

  const onYoutubeNavigation = () => {
    scheduleScan();
    bindVideoWatcher().catch(() => {});
    syncServerWhileActive().catch(() => {});
  };
  window.addEventListener('yt-navigate-finish', onYoutubeNavigation, true);
  window.addEventListener('popstate', onYoutubeNavigation, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleScan();
      bindVideoWatcher().catch(() => {});
      syncServerWhileActive().catch(() => {});
    }
  }, true);

  // v0.7 intentionally has no periodic timer. Mutation/navigation/player events
  // are enough while YouTube is actually in use; otherwise the extension sleeps.
  scheduleScan();
  bindVideoWatcher().catch(() => {});
  syncServerWhileActive().catch(() => {});
})();
