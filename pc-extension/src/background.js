const DB_NAME = 'eternal-youtube-history';
const DB_VERSION = 3;
const VIDEO_STORE = 'videos';
const EVENT_STORE = 'events';
const OUTBOX_STORE = 'cloudOutbox';
const CLOUD_CHUNK = 320;
const ACTIVE_PULL_INTERVAL_MS = 15 * 60_000;

let flushPromise = null;
let pullPromise = null;
const internalSyncTabs = new Set();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VIDEO_STORE)) {
        const store = db.createObjectStore(VIDEO_STORE, { keyPath: 'videoId' });
        store.createIndex('lastSeenAt', 'lastSeenAt');
        store.createIndex('firstSeenAt', 'firstSeenAt');
        store.createIndex('title', 'title');
      }
      if (!db.objectStoreNames.contains(EVENT_STORE)) {
        const events = db.createObjectStore(EVENT_STORE, { keyPath: 'eventId' });
        events.createIndex('videoId', 'videoId');
        events.createIndex('watchedAt', 'watchedAt');
        events.createIndex('discoveredAt', 'discoveredAt');
        events.createIndex('source', 'source');
      }
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalizeProgressPct(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function normalizeRecord(incoming, old = null, now = Date.now()) {
  const discoveredRaw = Number(incoming.discoveredAt || now);
  const discoveredAt = Number.isFinite(discoveredRaw) && discoveredRaw > 0 ? discoveredRaw : now;
  const preciseRaw = incoming.preciseWatchedAt == null ? null : Number(incoming.preciseWatchedAt);
  const precise = Number.isFinite(preciseRaw) && preciseRaw > 0 ? preciseRaw : null;
  const firstRaw = Number(incoming.firstWatchedAt || 0);
  const firstCandidate = Number.isFinite(firstRaw) && firstRaw > 0 ? firstRaw : (precise || discoveredAt);
  const lastCandidate = precise || discoveredAt;
  const incomingProgress = normalizeProgressPct(incoming.maxProgressPct ?? incoming.progressPct);
  const oldProgress = normalizeProgressPct(old?.maxProgressPct);
  const maxProgressPct = incomingProgress == null ? oldProgress : (oldProgress == null ? incomingProgress : Math.max(oldProgress, incomingProgress));
  return {
    videoId: incoming.videoId,
    title: incoming.title || old?.title || null,
    channelName: incoming.channelName || old?.channelName || null,
    channelId: incoming.channelId || old?.channelId || null,
    firstSeenAt: old?.firstSeenAt ? Math.min(old.firstSeenAt, firstCandidate) : firstCandidate,
    lastSeenAt: Math.max(old?.lastSeenAt || 0, lastCandidate),
    lastPreciseWatchedAt: precise ? Math.max(old?.lastPreciseWatchedAt || 0, precise) : (old?.lastPreciseWatchedAt || null),
    maxProgressPct,
    historyDateLabel: incoming.historyDateLabel || old?.historyDateLabel || null,
    firstSource: old?.firstSource || incoming.source || incoming.firstSource || 'unknown',
    lastSource: incoming.source || incoming.lastSource || old?.lastSource || 'unknown',
    updatedAt: Math.max(Number(incoming.updatedAt || 0), now)
  };
}

function normalizeEvent(incoming, now = Date.now()) {
  const watchedRaw = incoming.watchedAt == null ? null : Number(incoming.watchedAt);
  const watchedAt = Number.isFinite(watchedRaw) && watchedRaw > 0 ? watchedRaw : null;
  const discoveredRaw = Number(incoming.discoveredAt || watchedAt || now);
  const discoveredAt = Number.isFinite(discoveredRaw) && discoveredRaw > 0 ? discoveredRaw : now;
  return {
    eventId: String(incoming.eventId),
    videoId: incoming.videoId,
    watchedAt,
    discoveredAt,
    source: incoming.source || 'unknown',
    historyDateLabel: incoming.historyDateLabel || null,
    rawTime: incoming.rawTime || null,
    title: incoming.title || null,
    channelName: incoming.channelName || null,
    channelId: incoming.channelId || null,
    updatedAt: Math.max(Number(incoming.updatedAt || 0), now)
  };
}

function cloudRelevantVideoChanged(old, next) {
  if (!old) return true;
  const fields = ['title','channelName','channelId','firstSeenAt','lastPreciseWatchedAt','historyDateLabel','firstSource','lastSource','maxProgressPct'];
  return fields.some(k => (old?.[k] ?? null) !== (next?.[k] ?? null));
}

function dedupeRecords(records = []) {
  const map = new Map();
  for (const r of records) {
    if (!r || !/^[A-Za-z0-9_-]{11}$/.test(r.videoId || '')) continue;
    const old = map.get(r.videoId);
    if (!old) { map.set(r.videoId, r); continue; }
    const oldP = normalizeProgressPct(old.maxProgressPct ?? old.progressPct);
    const newP = normalizeProgressPct(r.maxProgressPct ?? r.progressPct);
    map.set(r.videoId, {
      ...old,
      ...r,
      title: r.title || old.title || null,
      channelName: r.channelName || old.channelName || null,
      channelId: r.channelId || old.channelId || null,
      historyDateLabel: r.historyDateLabel || old.historyDateLabel || null,
      maxProgressPct: oldP == null ? newP : (newP == null ? oldP : Math.max(oldP, newP))
    });
  }
  return [...map.values()];
}

async function upsertRecords(records = [], { queueCloud = true, flush = true } = {}) {
  const clean = dedupeRecords(records);
  if (!clean.length) return { stored: 0, inserted: 0 };
  const db = await openDb();
  let inserted = 0;
  try {
    await new Promise((resolve, reject) => {
      const stores = queueCloud ? [VIDEO_STORE, OUTBOX_STORE] : [VIDEO_STORE];
      const tx = db.transaction(stores, 'readwrite');
      const videos = tx.objectStore(VIDEO_STORE);
      const outbox = queueCloud ? tx.objectStore(OUTBOX_STORE) : null;
      const now = Date.now();
      for (const incoming of clean) {
        const req = videos.get(incoming.videoId);
        req.onsuccess = () => {
          const old = req.result || null;
          if (!old) inserted++;
          const next = normalizeRecord(incoming, old, now);
          videos.put(next);
          if (outbox && cloudRelevantVideoChanged(old, next)) outbox.put({ key: `video:${next.videoId}`, kind: 'video', id: next.videoId, queuedAt: now });
        };
        req.onerror = () => { tx.abort(); reject(req.error); };
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('video transaction aborted'));
    });
  } finally { db.close(); }
  if (queueCloud && flush) flushCloudQueue({ maxRounds: 3 }).catch(() => {});
  return { stored: clean.length, inserted };
}

async function upsertEvents(events = [], { queueCloud = true, flush = true } = {}) {
  const clean = events.filter(e => e?.eventId && /^[A-Za-z0-9_-]{11}$/.test(e.videoId || ''));
  if (!clean.length) return { stored: 0 };
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const stores = queueCloud ? [EVENT_STORE, OUTBOX_STORE] : [EVENT_STORE];
      const tx = db.transaction(stores, 'readwrite');
      const eventStore = tx.objectStore(EVENT_STORE);
      const outbox = queueCloud ? tx.objectStore(OUTBOX_STORE) : null;
      const now = Date.now();
      for (const incoming of clean) {
        const next = normalizeEvent(incoming, now);
        const req = eventStore.get(next.eventId);
        req.onsuccess = () => {
          if (!req.result) {
            eventStore.put(next);
            if (outbox) outbox.put({ key: `event:${next.eventId}`, kind: 'event', id: next.eventId, queuedAt: now });
          }
        };
        req.onerror = () => { tx.abort(); reject(req.error); };
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('event transaction aborted'));
    });
  } finally { db.close(); }
  if (queueCloud && flush) flushCloudQueue({ maxRounds: 3 }).catch(() => {});
  return { stored: clean.length };
}

async function importWatch(records = [], events = []) {
  const a = await upsertRecords(records, { queueCloud: true, flush: false });
  const b = await upsertEvents(events, { queueCloud: true, flush: false });
  flushCloudQueue({ maxRounds: 4 }).catch(() => {});
  return { ...a, eventStored: b.stored };
}

async function updateProgress(entries = []) {
  const valid = entries.filter(x => /^[A-Za-z0-9_-]{11}$/.test(x?.videoId || '') && normalizeProgressPct(x?.progressPct) != null);
  if (!valid.length) return { updated: 0 };
  const db = await openDb();
  let updated = 0;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction([VIDEO_STORE, OUTBOX_STORE], 'readwrite');
      const videos = tx.objectStore(VIDEO_STORE);
      const outbox = tx.objectStore(OUTBOX_STORE);
      const now = Date.now();
      for (const e of valid) {
        const req = videos.get(e.videoId);
        req.onsuccess = () => {
          const old = req.result;
          if (!old) return;
          const pct = normalizeProgressPct(e.progressPct);
          const oldPct = normalizeProgressPct(old.maxProgressPct);
          if (oldPct != null && pct <= oldPct) return;
          const next = { ...old, maxProgressPct: pct, updatedAt: now };
          videos.put(next);
          outbox.put({ key: `video:${next.videoId}`, kind: 'video', id: next.videoId, queuedAt: now });
          updated++;
        };
        req.onerror = () => { tx.abort(); reject(req.error); };
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('progress transaction aborted'));
    });
  } finally { db.close(); }
  if (updated) flushCloudQueue({ maxRounds: 2 }).catch(() => {});
  return { updated };
}

async function checkWatched(ids = []) {
  const clean = [...new Set(ids.filter(id => /^[A-Za-z0-9_-]{11}$/.test(id || '')))];
  const watched = {}, progress = {};
  if (!clean.length) return { watched, progress };
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE, 'readonly');
      const store = tx.objectStore(VIDEO_STORE);
      let pending = clean.length;
      for (const id of clean) {
        const req = store.get(id);
        req.onsuccess = () => {
          watched[id] = Boolean(req.result);
          progress[id] = normalizeProgressPct(req.result?.maxProgressPct);
          if (--pending === 0) resolve();
        };
        req.onerror = () => reject(req.error);
      }
    });
  } finally { db.close(); }
  return { watched, progress };
}

async function storeCount(storeName) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).count();
      req.onsuccess = () => resolve(Number(req.result || 0));
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function outboxEntries(limit = 720) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value); c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function getStoreValues(storeName, ids) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const out = [];
      let pending = ids.length;
      if (!pending) return resolve(out);
      for (const id of ids) {
        const req = store.get(id);
        req.onsuccess = () => { if (req.result) out.push(req.result); if (--pending === 0) resolve(out); };
        req.onerror = () => reject(req.error);
      }
    });
  } finally { db.close(); }
}

async function deleteOutboxKeys(keys) {
  if (!keys.length) return;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      const store = tx.objectStore(OUTBOX_STORE);
      for (const key of keys) store.delete(key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function cloudConfig() {
  return await chrome.storage.local.get({ workerUrl: '', apiToken: '', cloudEnabled: false });
}

async function cloudFetch(path, init = {}) {
  const cfg = await cloudConfig();
  if (!cfg.cloudEnabled || !cfg.workerUrl || !cfg.apiToken) throw new Error('D1 중앙 원장 연결이 꺼져 있습니다.');
  const base = cfg.workerUrl.replace(/\/+$/, '');
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${cfg.apiToken}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(base + path, { ...init, headers });
  if (!res.ok) throw new Error(`D1 HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res;
}

async function pushCloudVideos(records) {
  let uploaded = 0;
  for (let i = 0; i < records.length; i += CLOUD_CHUNK) {
    const chunk = records.slice(i, i + CLOUD_CHUNK);
    const res = await cloudFetch('/v1/videos/batch', { method: 'POST', body: JSON.stringify({ records: chunk }) });
    const body = await res.json();
    uploaded += Number(body.upserted || chunk.length);
  }
  return uploaded;
}

async function pushCloudEvents(events) {
  let uploaded = 0;
  for (let i = 0; i < events.length; i += CLOUD_CHUNK) {
    const chunk = events.slice(i, i + CLOUD_CHUNK);
    const res = await cloudFetch('/v1/events/batch', { method: 'POST', body: JSON.stringify({ events: chunk }) });
    const body = await res.json();
    uploaded += Number(body.upserted || chunk.length);
  }
  return uploaded;
}

async function flushCloudQueue({ maxRounds = 4 } = {}) {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    const cfg = await cloudConfig();
    if (!cfg.cloudEnabled || !cfg.workerUrl || !cfg.apiToken) return { skipped: true, pending: await storeCount(OUTBOX_STORE) };
    let uploaded = 0;
    for (let round = 0; round < maxRounds; round++) {
      const entries = await outboxEntries(720);
      if (!entries.length) break;
      const videoEntries = entries.filter(x => x.kind === 'video');
      const eventEntries = entries.filter(x => x.kind === 'event');
      const videos = await getStoreValues(VIDEO_STORE, videoEntries.map(x => x.id));
      const events = await getStoreValues(EVENT_STORE, eventEntries.map(x => x.id));
      if (videos.length) uploaded += await pushCloudVideos(videos);
      if (events.length) uploaded += await pushCloudEvents(events);
      await deleteOutboxKeys(entries.map(x => x.key));
      if (entries.length < 720) break;
    }
    const pending = await storeCount(OUTBOX_STORE);
    await chrome.storage.local.set({ lastCloudFlushAt: Date.now(), lastCloudFlushPending: pending, lastCloudFlushError: null });
    return { uploaded, pending };
  })();
  try { return await flushPromise; }
  catch (e) {
    await chrome.storage.local.set({ lastCloudFlushAt: Date.now(), lastCloudFlushError: String(e?.message || e) }).catch(() => {});
    throw e;
  } finally { flushPromise = null; }
}

async function putCloudCache(records) {
  return await upsertRecords(records.map(r => ({
    ...r,
    source: r.lastSource || 'cloud-sync',
    preciseWatchedAt: r.lastPreciseWatchedAt || null,
    discoveredAt: r.lastSeenAt || r.firstSeenAt || Date.now(),
    maxProgressPct: r.maxProgressPct
  })), { queueCloud: false, flush: false });
}

async function getCloudStats() {
  const res = await cloudFetch('/v1/stats');
  return await res.json();
}

async function pullAllCloudVideos() {
  let after = '', imported = 0, pages = 0;
  for (;;) {
    const qs = new URLSearchParams({ limit: '1000', after });
    const res = await cloudFetch(`/v1/videos?${qs}`);
    const body = await res.json();
    const rows = Array.isArray(body.records) ? body.records : [];
    if (!rows.length) break;
    await putCloudCache(rows);
    imported += rows.length; pages++;
    after = String(rows.at(-1)?.videoId || '');
    if (rows.length < 1000) break;
  }
  const stats = await getCloudStats();
  await chrome.storage.local.set({ cloudChangeCursor: Number(stats.latestChangeRev || 0), lastCloudPullAt: Date.now(), lastCloudPullError: null });
  await broadcastRescan();
  return { imported, pages, cursor: Number(stats.latestChangeRev || 0) };
}

async function ensureCloudCursor() {
  const state = await chrome.storage.local.get({ cloudChangeCursor: null });
  if (state.cloudChangeCursor !== null && state.cloudChangeCursor !== undefined) return Number(state.cloudChangeCursor || 0);
  const localCount = await storeCount(VIDEO_STORE);
  if (localCount === 0) {
    await pullAllCloudVideos();
    return Number((await chrome.storage.local.get({ cloudChangeCursor: 0 })).cloudChangeCursor || 0);
  }
  const stats = await getCloudStats();
  const cursor = Number(stats.latestChangeRev || 0);
  await chrome.storage.local.set({ cloudChangeCursor: cursor, lastCloudPullAt: Date.now() });
  return cursor;
}

async function pullCloudDelta({ maxPages = 8 } = {}) {
  if (pullPromise) return pullPromise;
  pullPromise = (async () => {
    const cfg = await cloudConfig();
    if (!cfg.cloudEnabled || !cfg.workerUrl || !cfg.apiToken) return { skipped: true, imported: 0 };
    let cursor = await ensureCloudCursor();
    let imported = 0, pages = 0, latestRev = cursor;
    for (; pages < maxPages; pages++) {
      const qs = new URLSearchParams({ after: String(cursor), limit: '500' });
      const res = await cloudFetch(`/v1/changes?${qs}`);
      const body = await res.json();
      const rows = Array.isArray(body.records) ? body.records : [];
      latestRev = Number(body.latestRev || latestRev);
      if (!rows.length) break;
      await putCloudCache(rows);
      imported += rows.length;
      cursor = Number(body.nextCursor || rows.at(-1)?.rev || cursor);
      if (!body.hasMore || rows.length < 500) break;
    }
    await chrome.storage.local.set({ cloudChangeCursor: cursor, lastCloudPullAt: Date.now(), lastCloudPullImported: imported, lastCloudPullLatestRev: latestRev, lastCloudPullError: null });
    if (imported) await broadcastRescan();
    return { imported, pages, cursor, latestRev };
  })();
  try { return await pullPromise; }
  catch (e) {
    await chrome.storage.local.set({ lastCloudPullAt: Date.now(), lastCloudPullError: String(e?.message || e) }).catch(() => {});
    throw e;
  } finally { pullPromise = null; }
}

async function activeYouTubeSync({ force = false } = {}) {
  const cfg = await cloudConfig();
  if (!cfg.cloudEnabled || !cfg.workerUrl || !cfg.apiToken) return { skipped: true };
  const state = await chrome.storage.local.get({ lastCloudPullAt: 0 });
  const due = force || Date.now() - Number(state.lastCloudPullAt || 0) >= ACTIVE_PULL_INTERVAL_MS;
  const flushed = await flushCloudQueue({ maxRounds: 3 }).catch(() => null);
  const pulled = due ? await pullCloudDelta({ maxPages: 8 }).catch(() => null) : { skipped: 'not-due', imported: 0 };
  return { flushed, pulled };
}

async function getClientStatus() {
  const [cacheCount, eventCount, pending, cfg, state] = await Promise.all([
    storeCount(VIDEO_STORE), storeCount(EVENT_STORE), storeCount(OUTBOX_STORE), cloudConfig(),
    chrome.storage.local.get({ lastCloudPullAt: 0, lastCloudPullError: null, lastCloudFlushError: null, cloudChangeCursor: 0 })
  ]);
  let server = null;
  if (cfg.cloudEnabled && cfg.workerUrl && cfg.apiToken) {
    try { server = await getCloudStats(); } catch {}
  }
  return { cacheCount, eventCount, pending, server, ...state };
}

async function broadcastRescan() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*'] });
    await Promise.allSettled(tabs.map(t => chrome.tabs.sendMessage(t.id, { type: 'RESCAN' })));
  } catch {}
}

async function sendHistorySyncToTab(tabId, maxPages = 3, { useLoadedPage = false, retryMs = 12000 } = {}) {
  const deadline = Date.now() + retryMs;
  let lastError = null;
  do {
    try { return await chrome.tabs.sendMessage(tabId, { type: 'SYNC_HISTORY', maxPages, useLoadedPage }); }
    catch (e) { lastError = e; await new Promise(r => setTimeout(r, 250)); }
  } while (Date.now() < deadline);
  throw lastError || new Error('YouTube 탭과 연결할 수 없습니다.');
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.status === 'complete') return current;
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (value, error) => {
      if (done) return; done = true; clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated); chrome.tabs.onRemoved.removeListener(onRemoved);
      error ? reject(error) : resolve(value);
    };
    const onUpdated = (id, info, tab) => { if (id === tabId && info.status === 'complete') finish(tab); };
    const onRemoved = id => { if (id === tabId) finish(null, new Error('시청 기록 탭이 닫혔습니다.')); };
    const timer = setTimeout(() => finish(null, new Error('시청 기록 페이지 로드 시간 초과')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated); chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function findHistoryTab() {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/feed/history*'] });
  const usable = tabs.filter(t => !internalSyncTabs.has(t.id));
  return usable.find(t => t.active) || usable[0] || null;
}

async function syncHistoryPreferred(maxPages = 3) {
  let tab = await findHistoryTab();
  let created = false;
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: 'https://www.youtube.com/feed/history', active: false });
    created = true;
  }
  const tabId = tab.id;
  if (tabId == null) return { ok: false, error: '시청 기록 탭을 열지 못했습니다.' };
  internalSyncTabs.add(tabId);
  try {
    if (!created) await chrome.tabs.reload(tabId, { bypassCache: true });
    await waitForTabComplete(tabId);
    await new Promise(r => setTimeout(r, created ? 1800 : 700));
    const result = await sendHistorySyncToTab(tabId, maxPages, { useLoadedPage: true, retryMs: 15000 });
    return { ...result, syncPath: created ? 'temporary-history-tab' : 'existing-history-tab' };
  } catch (e) {
    return { ok: false, error: `수동 History 복구 실패: ${String(e?.message || e)}` };
  } finally {
    internalSyncTabs.delete(tabId);
    if (created) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'UPSERT_RECORDS': return await upsertRecords(msg.records || []);
      case 'UPSERT_WATCH': return await importWatch(msg.records || [], msg.events || []);
      case 'UPDATE_PROGRESS': return await updateProgress(msg.entries || []);
      case 'CHECK_WATCHED': return await checkWatched(msg.ids || []);
      case 'ACTIVE_YOUTUBE_SYNC': return await activeYouTubeSync({ force: Boolean(msg.force) });
      case 'GET_CLIENT_STATUS': return await getClientStatus();
      case 'GET_CLOUD_STATS': return await getCloudStats();
      case 'GET_CLOUD_QUEUE_STATUS': return { pending: await storeCount(OUTBOX_STORE), ...(await chrome.storage.local.get({ lastCloudFlushAt: 0, lastCloudFlushError: null })) };
      case 'FLUSH_CLOUD_QUEUE': return await flushCloudQueue({ maxRounds: 12 });
      case 'PULL_CLOUD_DELTA': return await pullCloudDelta({ maxPages: 20 });
      case 'REBUILD_CACHE_FROM_D1': return await pullAllCloudVideos();
      case 'SYNC_HISTORY_NOW': return await syncHistoryPreferred(Math.max(1, Math.min(500, Number(msg.maxPages) || 3)));
      case 'HISTORY_PROGRESS':
        await chrome.storage.local.set({ historyProgress: { pages: msg.pages, count: msg.count, at: Date.now() } });
        return { ok: true };
      default: return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['directWatchSeconds','cloudEnabled','watchedDisplayMode','watchedMinProgressPct','watchedThumbnailOpacityPct','watchedThumbnailGrayscale','watchedLinkCardInfo','autoHistoryPages','serverFirstMigration070']);
  await chrome.storage.local.set({
    directWatchSeconds: existing.directWatchSeconds ?? 5,
    cloudEnabled: existing.cloudEnabled ?? false,
    watchedDisplayMode: existing.watchedDisplayMode ?? 'dim',
    watchedMinProgressPct: existing.watchedMinProgressPct ?? 0,
    watchedThumbnailOpacityPct: existing.watchedThumbnailOpacityPct ?? 65,
    watchedThumbnailGrayscale: existing.watchedThumbnailGrayscale ?? false,
    watchedLinkCardInfo: existing.watchedLinkCardInfo ?? false,
    autoHistoryPages: existing.autoHistoryPages ?? 3,
    serverFirstMigration070: true,
    // Explicitly retire all previous background scheduling settings.
    autoSyncEnabled: false,
    autoSyncMode: 'manual'
  });
  // Remove alarms created by older versions. v0.7 never creates new alarms.
  if (chrome.alarms) {
    await chrome.alarms.clear('eyh-auto-sync').catch(() => {});
    await chrome.alarms.clear('eyh-cloud-retry').catch(() => {});
  }
});
