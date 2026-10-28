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

  function declaredWatchLaterCount() {
    const selectors = [
      'ytd-playlist-header-renderer #stats',
      'ytd-playlist-header-renderer #stats yt-formatted-string',
      'ytd-playlist-sidebar-primary-info-renderer #stats'
    ];
    const patterns = [
      /동영상\s*([0-9,]+)\s*개/i,
      /([0-9,]+)\s*개\s*(?:의\s*)?동영상/i,
      /\b([0-9,]+)\s*videos?\b/i
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const values = [node.textContent, node.getAttribute?.('aria-label')];
        for (const raw of values) {
          const text = String(raw || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (!match) continue;
            const count = Number(match[1].replace(/,/g, ''));
            if (Number.isSafeInteger(count) && count >= 0) return count;
          }
        }
      }
    }
    return null;
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

  async function verifyStoredTransaction(tx) {
    if (!tx || typeof tx !== 'object') throw new Error('Watch Later 안전 journal이 없습니다.');
    if (!/^[0-9a-f]{64}$/i.test(String(tx.journalDigest || ''))) {
      throw new Error('Watch Later 안전 journal digest가 없거나 올바르지 않습니다.');
    }
    const recomputed = await sha256Hex(CORE.canonicalForDigest(tx));
    if (recomputed !== tx.journalDigest) {
      throw new Error('Watch Later 안전 journal 무결성 확인에 실패했습니다.');
    }
    return tx;
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
    return verifyStoredTransaction(check);
  }

  async function archivePreviousTransaction() {
    const state = await storageGet({ [TX_KEY]: null, [HISTORY_KEY]: [] });
    const previous = state[TX_KEY];
    if (!previous) return;
    await verifyStoredTransaction(previous);
    const recoveryIds = CORE.undoVideoIds(previous);
    const stateNeedsRecovery = ['removing', 'undoing', 'partial', 'undo_partial'].includes(previous.state)
      || (Number(previous.schema || 0) < 2 && previous.state === 'prepared');
    if (stateNeedsRecovery && recoveryIds.length) {
      throw new Error('완료되지 않았거나 부분 실패한 이전 정리 기록이 있습니다. 먼저 “마지막 정리 되돌리기”를 실행하세요.');
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

  async function strictListWatchLater() {
    const listed = await requestPage('EYH_WL_SAFE_LIST_REQUEST', { maxPages: 250 }, 600000);
    if (listed.strict !== true
        || listed.complete !== true
        || listed.hasMore !== false
        || listed.terminalReason !== 'no-continuation') {
      throw new Error('Watch Later 전체 목록의 안전한 끝 지점을 확인하지 못해 삭제하지 않습니다.');
    }
    return listed;
  }

  function requireDeclaredCount(expectedEntries, expectedPrevious = null) {
    const declaredCount = declaredWatchLaterCount();
    if (declaredCount == null) {
      throw new Error('YouTube 화면의 Watch Later 전체 개수를 확인할 수 없어 안전을 위해 삭제하지 않습니다.');
    }
    if (declaredCount !== expectedEntries) {
      throw new Error(`YouTube 표시 개수 ${declaredCount}개와 안전 파서 ${expectedEntries}개가 달라 삭제하지 않습니다.`);
    }
    if (expectedPrevious != null && declaredCount !== expectedPrevious) {
      throw new Error(`사용자 확인 뒤 Watch Later 개수가 ${expectedPrevious}개에서 ${declaredCount}개로 바뀌어 삭제하지 않습니다.`);
    }
    return declaredCount;
  }

  async function createPreparedTransaction() {
    await refreshCentralLedger();
    const listed = await strictListWatchLater();
    const entries = listed.entries || [];
    const declaredCount = requireDeclaredCount(entries.length);
    const ledger = await readLedger(entries.map(e => e.videoId));
    const prefs = await storageGet({ watchLaterCleanupMinProgressPct: 60 });
    const progressById = {};
    for (const entry of entries) {
      if (ledger.watched?.[entry.videoId] !== true) continue;
      const pct = CORE.progress(ledger.progress?.[entry.videoId]);
      if (pct != null) progressById[entry.videoId] = pct;
    }
    const tx = CORE.buildTransaction({
      id: `pcwl:${crypto.randomUUID()}`,
      entries,
      progressById,
      cleanupThreshold: prefs.watchLaterCleanupMinProgressPct,
      pages: listed.pages,
      hasMore: Boolean(listed.hasMore)
    });
    tx.declaredCount = declaredCount;
    tx.snapshotTerminalReason = listed.terminalReason;
    return tx;
  }

  async function revalidatePreparedSnapshot(tx) {
    const listed = await strictListWatchLater();
    const current = CORE.normalizeSnapshot(listed.entries || []);
    requireDeclaredCount(current.length, tx.declaredCount);
    if (!CORE.sameSnapshotMembership(tx.snapshot, current)) {
      throw new Error('사용자 확인 뒤 Watch Later 멤버십이 바뀌어 삭제하지 않습니다. 목록을 다시 확인한 뒤 재시도하세요.');
    }
    return { pages: Number(listed.pages || 0), count: current.length };
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
        `${preview}${more}\n\n삭제 전에 전체 Watch Later 스냅샷과 대상 journal을 저장하고, 사용자 확인 뒤 전체 목록을 한 번 더 대조한 다음 각 항목의 현재 식별자를 다시 검증합니다. 마지막 정리는 되돌릴 수 있습니다.`
      )) {
        setStatus('안전 정리를 취소했습니다.');
        return;
      }

      await archivePreviousTransaction();
      let durable = await persistVerified(tx);

      try {
        setStatus('사용자 확인 뒤 Watch Later 전체 목록이 그대로인지 다시 확인 중…');
        const verified = await revalidatePreparedSnapshot(durable);
        durable.snapshotVerifiedAt = Date.now();
        durable.snapshotVerificationPages = verified.pages;
        durable = await persistVerified(durable);
      } catch (error) {
        durable.state = 'aborted';
        durable.abortReason = String(error?.message || error).slice(0, 300);
        durable.abortedAt = Date.now();
        await persistVerified(durable);
        throw error;
      }

      durable.state = 'removing';
      durable = await persistVerified(durable);
      let halted = false;

      for (let i = 0; i < durable.candidates.length; i += 1) {
        const candidate = durable.candidates[i];
        setStatus(`${i + 1}/${durable.candidates.length} 안전 정리 · 삭제 직전 journal 기록 중…`);
        candidate.status = 'attempting';
        candidate.attemptStartedAt = Date.now();
        durable = await persistVerified(durable);

        try {
          setStatus(`${i + 1}/${durable.candidates.length} 안전 정리 · 현재 videoId↔setVideoId 재검증 중…`);
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

        durable = await persistVerified(durable);
        if (candidate.status !== 'removed') {
          halted = true;
          durable.haltedAt = Date.now();
          durable.haltReason = candidate.status;
          break;
        }
      }

      CORE.recalcCounts(durable);
      durable.state = halted || durable.failureCount > 0 ? 'partial' : 'completed';
      durable.completedAt = Date.now();
      durable = await persistVerified(durable);
      setStatus(
        durable.state === 'partial'
          ? `안전 정리 중단: ${durable.removedCount}개 제거 · 이상 감지 후 추가 삭제 중지 · 되돌리기 가능`
          : `안전 정리 완료: ${durable.removedCount}개 · 마지막 정리 되돌리기 가능`,
        durable.state === 'partial' ? 'error' : ''
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
      const stored = (await storageGet({ [TX_KEY]: null }))[TX_KEY];
      let tx = stored ? await verifyStoredTransaction(stored) : null;
      if (!tx || !Array.isArray(tx.candidates) || !tx.candidates.length || tx.state === 'undone') {
        setStatus('되돌릴 안전 정리 기록이 없습니다.');
        return;
      }
      const ids = CORE.undoVideoIds(tx);
      if (!ids.length) {
        setStatus('이 정리가 변경했을 가능성이 있는 Watch Later 항목이 없어 되돌릴 작업이 없습니다.');
        return;
      }
      if (!confirm(
        `마지막 안전 정리에서 실제로 제거됐거나 결과가 불확실한 ${ids.length}개의 Watch Later 멤버십을 복구할까요?\n\n이미 목록에 있는 영상은 건드리지 않고, 빠진 영상만 다시 추가합니다. YouTube의 ADD API 특성상 원래의 정확한 목록 위치까지는 복원되지 않을 수 있습니다.`
      )) return;

      const eligible = new Set(ids);
      if (Number(tx.schema || 0) >= 2) {
        for (const candidate of tx.candidates) {
          if (!eligible.has(candidate.videoId) && candidate.undoStatus === 'pending') {
            candidate.undoStatus = 'not_needed';
          }
        }
      }
      tx.state = 'undoing';
      tx.undoStartedAt = Date.now();
      tx = await persistVerified(tx);

      const toRestore = tx.candidates.filter(candidate => eligible.has(candidate.videoId));
      for (let i = 0; i < toRestore.length; i += 1) {
        const candidate = toRestore[i];
        setStatus(`${i + 1}/${toRestore.length} Watch Later 멤버십 복구 준비 중…`);
        candidate.undoStatus = 'attempting';
        candidate.undoAttemptStartedAt = Date.now();
        tx = await persistVerified(tx);
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
    cleanup.title = `전체 스냅샷 2회 대조 + journal + 직전 식별자 재검증 후 ${min}% 이상 본 영상만 정리`;
    cleanup.hidden = !page;
    cleanup.disabled = busy;

    const tx = state[TX_KEY];
    const undoIds = tx && Array.isArray(tx.candidates) ? CORE.undoVideoIds(tx) : [];
    const canUndo = page && tx && undoIds.length > 0 && tx.state !== 'undone';
    undo.hidden = !canUndo;
    undo.disabled = busy;
    if (canUndo && ['prepared', 'removing', 'undoing', 'partial', 'undo_partial'].includes(tx.state)) {
      undo.textContent = '미완료 정리 복구';
      undo.title = '중단된 안전 정리 journal에서 실제 변경됐거나 결과가 불확실한 Watch Later 멤버십만 복구';
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

  function scheduleDecorateRetries() {
    scheduleDecorate();
    setTimeout(scheduleDecorate, 120);
    setTimeout(scheduleDecorate, 500);
    setTimeout(scheduleDecorate, 1400);
  }

  if (!CORE || !WL) return;
  // Keep only the legacy unsafe preference off. v0.10.8 automatic cleanup uses a separate key and
  // the same snapshot+journal+fresh-identity transaction protocol as manual safe cleanup.
  if (extensionAlive()) chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});

  // Do not observe the whole YouTube document. The single card renderer already owns the one
  // resident DOM observer; safe cleanup decorates only after navigation, preference changes and a
  // bounded set of post-navigation retries so it cannot reintroduce the v0.10.x lag regression.
  window.addEventListener('yt-navigate-finish', scheduleDecorateRetries, true);
  window.addEventListener('popstate', scheduleDecorateRetries, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.watchLaterCleanupMinProgressPct || changes[TX_KEY])) scheduleDecorate();
  });
  scheduleDecorateRetries();
})();
