(() => {
  'use strict';

  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const CORE = globalThis.EYHWatchLaterSafeCore;
  const WL = globalThis.EYHWatchLaterCore;
  const TX_KEY = 'eyhWatchLaterSafeTransactionV1';
  const HISTORY_KEY = 'eyhWatchLaterSafeTransactionHistoryV1';
  const pending = new Map();
  let busy = false;
  let decorateQueued = false;

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }

  async function storageGet(defaults) {
    if (!extensionAlive()) throw new Error('확장 컨텍스트가 바뀌었습니다. 이 YouTube 탭을 한 번 새로고침하세요.');
    return chrome.storage.local.get(defaults);
  }

  async function storageSet(values) {
    if (!extensionAlive()) throw new Error('확장 컨텍스트가 바뀌었습니다. 이 YouTube 탭을 한 번 새로고침하세요.');
    return chrome.storage.local.set(values);
  }

  function isWatchLaterPage() {
    return location.pathname === '/playlist' && new URLSearchParams(location.search).get('list') === 'WL';
  }

  function setStatus(text, kind = '') {
    const status = document.querySelector('#eyh-header-status');
    if (!status) return;
    status.textContent = text || '';
    status.dataset.kind = kind || '';
    if (text) {
      const token = String(Date.now());
      status.dataset.token = token;
      setTimeout(() => {
        if (status.dataset.token === token) status.textContent = '';
      }, kind === 'error' ? 18000 : 10000);
    }
  }

  function requestPage(type, payload = {}, timeoutMs = 120000) {
    const requestId = crypto.randomUUID();
    const responseType = type.startsWith('EYH_WL_SAFE_') ? 'EYH_WL_SAFE_RESULT' : 'EYH_WL_RESULT';
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${type} 요청 시간이 초과되었습니다.`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout, responseType });
      window.postMessage({ source: CONTENT, target: PAGE, type, requestId, ...payload }, '*');
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE || msg.target !== CONTENT || !msg.requestId) return;
    const p = pending.get(msg.requestId);
    if (!p || msg.type !== p.responseType) return;
    pending.delete(msg.requestId);
    clearTimeout(p.timeout);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || `${msg.type} 실패`));
  });

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function persistVerified(tx) {
    tx.updatedAt = Date.now();
    CORE.recalcCounts(tx);
    tx.journalDigest = await sha256Hex(CORE.canonicalForDigest(tx));
    await storageSet({ [TX_KEY]: tx });
    const check = (await storageGet({ [TX_KEY]: null }))[TX_KEY];
    if (!check || check.id !== tx.id || check.journalDigest !== tx.journalDigest) {
      throw new Error('Watch Later 안전 journal 저장 확인에 실패했습니다. 삭제를 중단합니다.');
    }
    const recomputed = await sha256Hex(CORE.canonicalForDigest(check));
    if (recomputed !== check.journalDigest) {
      throw new Error('Watch Later 안전 journal 무결성 확인에 실패했습니다. 삭제를 중단합니다.');
    }
    return check;
  }

  async function archivePreviousTransaction() {
    const state = await storageGet({ [TX_KEY]: null, [HISTORY_KEY]: [] });
    const previous = state[TX_KEY];
    if (!previous) return;
    if (['prepared', 'removing', 'undoing'].includes(previous.state)) {
      throw new Error('완료되지 않은 이전 정리 기록이 있습니다. 먼저 “마지막 정리 되돌리기”를 실행하세요.');
    }
    const history = Array.isArray(state[HISTORY_KEY]) ? state[HISTORY_KEY] : [];
    const next = [previous, ...history.filter(x => x?.id !== previous.id)].slice(0, 2);
    await storageSet({ [HISTORY_KEY]: next });
  }

  async function readLedger(ids) {
    const clean = [...new Set((ids || []).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id || '')))];
    const watched = {}, progress = {};
    for (let i = 0; i < clean.length; i += 400) {
      const chunk = clean.slice(i, i + 400);
      const result = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: chunk });
      Object.assign(watched, result?.watched || {});
      Object.assign(progress, result?.progress || {});
    }
    return { watched, progress };
  }

  async function refreshCentralLedger() {
    const prefs = await storageGet({ cloudEnabled: false });
    const result = await chrome.runtime.sendMessage({ type: 'ACTIVE_YOUTUBE_SYNC', force: true });
    if (prefs.cloudEnabled && (!result || result.pulled == null)) {
      throw new Error('중앙 Eternal 진행률 동기화가 완료되지 않아 정리를 중단합니다.');
    }
  }

  async function createPreparedTransaction() {
    await refreshCentralLedger();
    const listed = await requestPage('EYH_WL_LIST_REQUEST', { maxPages: 250 }, 600000);
    if (listed.hasMore) throw new Error('Watch Later 전체 목록을 끝까지 읽지 못해 삭제하지 않습니다.');
    const entries = listed.entries || [];
    const ledger = await readLedger(entries.map(e => e.videoId));
    const prefs = await storageGet({ watchLaterCleanupMinProgressPct: 60 });
    const progressById = {};
    for (const entry of entries) {
      if (ledger.watched?.[entry.videoId] !== true) continue;
      const pct = CORE.progress(ledger.progress?.[entry.videoId]);
      if (pct != null) progressById[entry.videoId] = pct;
    }
    return CORE.buildTransaction({
      id: `pcwl:${crypto.randomUUID()}`,
      entries,
      progressById,
      cleanupThreshold: prefs.watchLaterCleanupMinProgressPct,
      pages: listed.pages,
      hasMore: Boolean(listed.hasMore)
    });
  }

  async function runSafeCleanup() {
    if (busy) return;
    if (!isWatchLaterPage()) return;
    busy = true;
    scheduleDecorate();
    try {
      setStatus('Watch Later 전체 목록과 Eternal 진행률을 안전하게 확인 중…');
      const tx = await createPreparedTransaction();
      if (!tx.candidates.length) {
        setStatus(`${tx.snapshot.length}개 확인 · ${tx.threshold}%+ 정리 대상 없음`);
        return;
      }

      const preview = tx.candidates.slice(0, 6)
        .map(e => `${e.videoId} (${Math.round(e.progressPct)}%)`).join('\n');
      const more = tx.candidates.length > 6 ? `\n외 ${tx.candidates.length - 6}개` : '';
      if (!confirm(
        `Eternal 진행률 ${tx.threshold}% 이상인 Watch Later 영상 ${tx.candidates.length}개를 안전 정리할까요?\n\n` +
        `${preview}${more}\n\n삭제 전에 전체 Watch Later 스냅샷과 대상 journal을 저장하고, 각 항목의 현재 식별자를 다시 검증합니다. 마지막 정리는 되돌릴 수 있습니다.`
      )) {
        setStatus('안전 정리를 취소했습니다.');
        return;
      }

      await archivePreviousTransaction();
      let durable = await persistVerified(tx); // Durable full snapshot + every candidate before delete #1.
      durable.state = 'removing';
      durable = await persistVerified(durable);

      for (let i = 0; i < durable.candidates.length; i += 1) {
        const candidate = durable.candidates[i];
        setStatus(`${i + 1}/${durable.candidates.length} 안전 정리 · 삭제 직전 식별자 재검증 중…`);
        try {
          const result = await requestPage('EYH_WL_SAFE_REMOVE_REQUEST', {
            operationId: durable.id,
            journalDigest: durable.journalDigest,
            videoId: candidate.videoId,
            setVideoId: candidate.setVideoId
          });
          candidate.status = result.status === 'removed' ? 'removed'
            : result.status === 'identity_mismatch' ? 'identity_mismatch'
              : result.status === 'missing' ? 'missing' : 'failed';
          candidate.resultAt = Date.now();
        } catch (error) {
          candidate.status = 'failed';
          candidate.error = String(error?.message || error).slice(0, 300);
          candidate.resultAt = Date.now();
        }
        // The next delete is forbidden until the result of this one is durably re-read and verified.
        durable = await persistVerified(durable);
      }

      CORE.recalcCounts(durable);
      durable.state = durable.failureCount === 0 ? 'completed' : 'partial';
      durable.completedAt = Date.now();
      durable = await persistVerified(durable);
      setStatus(
        durable.failureCount
          ? `안전 정리: ${durable.removedCount}개 제거 · ${durable.failureCount}개 보류/실패 · 되돌리기 가능`
          : `안전 정리 완료: ${durable.removedCount}개 · 마지막 정리 되돌리기 가능`,
        durable.failureCount ? 'error' : ''
      );
    } catch (error) {
      setStatus(`안전 정리 중단: ${error.message}`, 'error');
    } finally {
      busy = false;
      scheduleDecorate();
    }
  }

  async function undoLastCleanup() {
    if (busy) return;
    busy = true;
    scheduleDecorate();
    try {
      let tx = (await storageGet({ [TX_KEY]: null }))[TX_KEY];
      if (!tx || !Array.isArray(tx.candidates) || !tx.candidates.length || tx.state === 'undone') {
        setStatus('되돌릴 안전 정리 기록이 없습니다.');
        return;
      }
      const ids = CORE.undoVideoIds(tx);
      if (!ids.length) throw new Error('복구할 videoId가 journal에 없습니다.');
      if (!confirm(
        `마지막 안전 정리 대상 ${ids.length}개의 Watch Later 멤버십을 복구할까요?\n\n이미 목록에 있는 영상은 건드리지 않고, 빠진 영상만 다시 추가합니다. YouTube의 ADD API 특성상 원래의 정확한 목록 위치까지는 복원되지 않을 수 있습니다.`
      )) return;

      tx.state = 'undoing';
      tx.undoStartedAt = Date.now();
      tx = await persistVerified(tx);
      for (let i = 0; i < tx.candidates.length; i += 1) {
        const candidate = tx.candidates[i];
        setStatus(`${i + 1}/${tx.candidates.length} Watch Later 멤버십 복구 중…`);
        try {
          const result = await requestPage('EYH_WL_SAFE_ADD_REQUEST', {
            operationId: tx.id,
            journalDigest: tx.journalDigest,
            videoId: candidate.videoId
          });
          candidate.undoStatus = result.status === 'already_present' ? 'already_present' : 'restored';
          candidate.undoAt = Date.now();
          delete candidate.undoError;
        } catch (error) {
          candidate.undoStatus = 'failed';
          candidate.undoError = String(error?.message || error).slice(0, 300);
          candidate.undoAt = Date.now();
        }
        tx = await persistVerified(tx);
      }
      CORE.recalcCounts(tx);
      tx.state = tx.undoFailureCount === 0 ? 'undone' : 'undo_partial';
      tx.undoCompletedAt = Date.now();
      tx = await persistVerified(tx);
      setStatus(
        tx.undoFailureCount
          ? `되돌리기: ${tx.undoRestoredCount}개 확인/복구 · ${tx.undoFailureCount}개 실패`
          : `마지막 안전 정리 되돌리기 완료 · ${tx.undoRestoredCount}개 멤버십 확인/복구`,
        tx.undoFailureCount ? 'error' : ''
      );
    } catch (error) {
      setStatus(`되돌리기 중단: ${error.message}`, 'error');
    } finally {
      busy = false;
      scheduleDecorate();
    }
  }

  async function decorate() {
    decorateQueued = false;
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return;
    let cleanup = root.querySelector('#eyh-watch-later-safe-cleanup');
    let undo = root.querySelector('#eyh-watch-later-safe-undo');
    if (!cleanup) {
      cleanup = document.createElement('button');
      cleanup.type = 'button';
      cleanup.id = 'eyh-watch-later-safe-cleanup';
      cleanup.className = 'eyh-header-button eyh-cleanup-button';
      cleanup.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        runSafeCleanup().catch(error => setStatus(error.message, 'error'));
      }, true);
      root.appendChild(cleanup);
    }
    if (!undo) {
      undo = document.createElement('button');
      undo.type = 'button';
      undo.id = 'eyh-watch-later-safe-undo';
      undo.className = 'eyh-header-button';
      undo.textContent = '되돌리기';
      undo.title = '마지막 안전 정리의 Watch Later 멤버십 복구';
      undo.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        undoLastCleanup().catch(error => setStatus(error.message, 'error'));
      }, true);
      root.appendChild(undo);
    }

    const page = isWatchLaterPage();
    const state = await storageGet({ watchLaterCleanupMinProgressPct: 60, [TX_KEY]: null }).catch(() => null);
    if (!state) {
      cleanup.hidden = !page;
      undo.hidden = true;
      return;
    }
    const min = CORE.threshold(state.watchLaterCleanupMinProgressPct);
    cleanup.textContent = `${min}%+ 안전 정리`;
    cleanup.title = `전체 스냅샷 + journal + 직전 식별자 재검증 후 ${min}% 이상 본 영상만 정리`;
    cleanup.hidden = !page;
    cleanup.disabled = busy;

    const tx = state[TX_KEY];
    const canUndo = page && tx && Array.isArray(tx.candidates) && tx.candidates.length > 0 && tx.state !== 'undone';
    undo.hidden = !canUndo;
    undo.disabled = busy;
    if (canUndo && ['prepared', 'removing', 'undoing'].includes(tx.state)) {
      undo.textContent = '미완료 정리 복구';
      undo.title = '중단된 안전 정리 journal을 기준으로 원래 Watch Later 멤버십을 복구';
    } else {
      undo.textContent = '마지막 정리 되돌리기';
      undo.title = '마지막 안전 정리의 Watch Later 멤버십 복구';
    }
  }

  function scheduleDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    queueMicrotask(() => decorate().catch(() => { decorateQueued = false; }));
  }

  if (!CORE || !WL) return;
  // Automatic cleanup remains deliberately disabled in v0.10.4. Only the new explicit transaction
  // path below can perform a destructive request; legacy remove messages stay blocked in MAIN world.
  if (extensionAlive()) chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});

  const observer = new MutationObserver(mutations => {
    if (mutations.some(m => m.type === 'childList' && m.addedNodes.length)) scheduleDecorate();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });
  window.addEventListener('yt-navigate-finish', scheduleDecorate, true);
  window.addEventListener('popstate', scheduleDecorate, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.watchLaterCleanupMinProgressPct || changes[TX_KEY])) scheduleDecorate();
  });
  setTimeout(scheduleDecorate, 0);
})();
