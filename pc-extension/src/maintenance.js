(() => {
  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const WL = globalThis.EYHWatchLaterCore;
  const pending = new Map();
  const HISTORY_INTERVAL_MS = 60 * 60 * 1000;
  const WATCH_LATER_INTERVAL_MS = 30 * 60 * 1000;
  const RETRY_MS = 10 * 60 * 1000;
  const TICK_MS = 5 * 60 * 1000;
  let runningHistory = false;
  let runningWatchLater = false;

  function requestPage(type, payload = {}, timeoutMs = 600000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      window.postMessage({ source: CONTENT, target: PAGE, type, requestId, ...payload }, '*');
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE || msg.target !== CONTENT || !msg.requestId) return;
    if (msg.type !== 'EYH_HISTORY_RESULT' && msg.type !== 'EYH_WL_RESULT') return;
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    clearTimeout(p.timeout);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || `${msg.type} failed`));
  });

  async function claimDue(key, intervalMs) {
    const now = Date.now();
    const state = await chrome.storage.local.get({ [key]: 0 });
    if (Number(state[key] || 0) > now) return false;
    await chrome.storage.local.set({ [key]: now + intervalMs });
    return true;
  }

  async function retrySoon(key) {
    await chrome.storage.local.set({ [key]: Date.now() + RETRY_MS }).catch(() => {});
  }

  function normalizeProgress(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }

  async function readLedger(ids) {
    const watched = {}, progress = {};
    const clean = [...new Set((ids || []).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id || '')))];
    for (let i = 0; i < clean.length; i += 400) {
      const chunk = clean.slice(i, i + 400);
      const result = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: chunk });
      Object.assign(watched, result?.watched || {});
      Object.assign(progress, result?.progress || {});
    }
    return { watched, progress };
  }

  async function reconcileRecentHistory() {
    const leaseKey = 'eyhMaintenanceNextHistoryAt';
    if (runningHistory || document.visibilityState !== 'visible') return;
    if (!(await claimDue(leaseKey, HISTORY_INTERVAL_MS))) return;
    runningHistory = true;
    try {
      const result = await requestPage('EYH_REQUEST_HISTORY', { maxPages: 3, useLoadedPage: false });
      const now = Date.now();
      const records = (result.records || []).map(r => ({
        ...r,
        source: 'youtube-history-auto',
        preciseWatchedAt: null,
        discoveredAt: now
      }));
      const stored = records.length
        ? await chrome.runtime.sendMessage({ type: 'UPSERT_RECORDS', records })
        : { inserted: 0, stored: 0 };
      await chrome.storage.local.set({
        eyhLastAutoHistoryReconcile: {
          at: now,
          pages: Number(result.pages || 0),
          fetched: records.length,
          inserted: Number(stored?.inserted || 0),
          stopReason: result.stopReason || null
        }
      });
    } catch (error) {
      await retrySoon(leaseKey);
      await chrome.storage.local.set({
        eyhLastAutoHistoryReconcile: { at: Date.now(), error: String(error?.message || error) }
      }).catch(() => {});
    } finally {
      runningHistory = false;
    }
  }

  async function sweepWatchLater() {
    const leaseKey = 'eyhMaintenanceNextWatchLaterAt';
    if (runningWatchLater || document.visibilityState !== 'visible' || !WL) return;
    if (WL.isWatchLaterUrl?.(location.href)) return;
    const settings = await chrome.storage.local.get({
      watchLaterAutoCleanupEnabled: false,
      watchLaterCleanupMinProgressPct: 60
    });
    if (!settings.watchLaterAutoCleanupEnabled) return;
    if (!(await claimDue(leaseKey, WATCH_LATER_INTERVAL_MS))) return;
    runningWatchLater = true;
    try {
      await chrome.runtime.sendMessage({ type: 'ACTIVE_YOUTUBE_SYNC', force: true }).catch(() => null);
      const listed = await requestPage('EYH_WL_LIST_REQUEST', { maxPages: 100 });
      const entries = listed.entries || [];
      const ledger = await readLedger(entries.map(e => e.videoId));
      const progress = {};
      for (const e of entries) {
        if (ledger.watched?.[e.videoId] !== true) continue;
        const pct = normalizeProgress(ledger.progress?.[e.videoId]);
        if (pct != null) progress[e.videoId] = pct;
      }
      const threshold = Math.max(1, Math.min(100, Number(settings.watchLaterCleanupMinProgressPct) || 60));
      const qualified = WL.qualifyCleanup?.(entries, progress, threshold) || [];
      let result = { removed: 0, failures: [] };
      if (qualified.length) {
        result = await requestPage('EYH_WL_REMOVE_REQUEST', {
          entries: qualified.map(({ videoId, setVideoId }) => ({ videoId, setVideoId }))
        });
      }
      await chrome.storage.local.set({
        eyhLastAutoWatchLaterSweep: {
          at: Date.now(),
          threshold,
          pages: Number(listed.pages || 0),
          scanned: entries.length,
          qualified: qualified.length,
          removed: Number(result.removed || 0),
          failures: Array.isArray(result.failures) ? result.failures.length : 0
        }
      });
    } catch (error) {
      await retrySoon(leaseKey);
      await chrome.storage.local.set({
        eyhLastAutoWatchLaterSweep: { at: Date.now(), error: String(error?.message || error) }
      }).catch(() => {});
    } finally {
      runningWatchLater = false;
    }
  }

  function tick() {
    if (document.visibilityState !== 'visible') return;
    reconcileRecentHistory().catch(() => {});
    sweepWatchLater().catch(() => {});
  }

  setTimeout(tick, 12_000 + Math.floor(Math.random() * 8_000));
  setInterval(tick, TICK_MS);
  window.addEventListener('yt-navigate-finish', () => setTimeout(tick, 1500), true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(tick, 1200);
  }, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.watchLaterAutoCleanupEnabled || changes.watchLaterCleanupMinProgressPct)) {
      if (changes.watchLaterAutoCleanupEnabled?.newValue === true) {
        chrome.storage.local.set({ eyhMaintenanceNextWatchLaterAt: 0 }).then(() => setTimeout(tick, 500)).catch(() => {});
      }
    }
  });
})();
