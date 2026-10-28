(() => {
  'use strict';

  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const CORE = globalThis.EYHWatchLaterSafeCore;
  const TX_KEY = 'eyhWatchLaterSafeTransactionV1';
  const HISTORY_KEY = 'eyhWatchLaterSafeTransactionHistoryV1';
  const AUTO_KEY = 'watchLaterSafeAutoCleanupEnabled';
  const pending = new Map();
  let busy = false;
  let wasWatchLater = false;
  let generation = 0;

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }

  function isWatchLaterPage() {
    return location.pathname === '/playlist' && new URLSearchParams(location.search).get('list') === 'WL';
  }

  function setStatus(text, kind = '') {
    const status = document.querySelector('#eyh-header-status');
    if (!status) return;
    status.textContent = text || '';
    status.dataset.kind = kind;
    if (!text) return;
    const token = `${Date.now()}:${Math.random()}`;
    status.dataset.token = token;
    setTimeout(() => {
      if (status.dataset.token === token) status.textContent = '';
    }, kind === 'error' ? 18000 : 10000);
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
        for (const raw of [node.textContent, node.getAttribute?.('aria-label')]) {
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

  function requestPage(type, payload = {}, timeoutMs = 120000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${type} 요청 시간이 초과되었습니다.`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      window.postMessage({ source: CONTENT, target: PAGE, type, requestId, ...payload }, '*');
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE || msg.target !== CONTENT || msg.type !== 'EYH_WL_SAFE_RESULT') return;
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    clearTimeout(p.timeout);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'Watch Later 안전 요청 실패'));
  });

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function verifyStoredTransaction(tx) {
    if (!tx || typeof tx !== 'object' || !/^[0-9a-f]{64}$/i.test(String(tx.journalDigest || ''))) {
      throw new Error('Watch Later 안전 journal이 없거나 올바르지 않습니다.');
    }
    const digest = await sha256Hex(CORE.canonicalForDigest(tx));
    if (digest !== tx.journalDigest) throw new Error('Watch Later 안전 journal 무결성 확인에 실패했습니다.');
    return tx;
  }

  async function persistVerified(tx) {
    tx.updatedAt = Date.now();
    CORE.recalcCounts(tx);
    tx.journalDigest = await sha256Hex(CORE.canonicalForDigest(tx));
    await chrome.storage.local.set({ [TX_KEY]: tx });
    const stored = (await chrome.storage.local.get({ [TX_KEY]: null }))[TX_KEY];
    if (!stored || stored.id !== tx.id || stored.journalDigest !== tx.journalDigest) {
      throw new Error('Watch Later 안전 journal 저장 확인에 실패했습니다.');
    }
    return verifyStoredTransaction(stored);
  }

  async function archivePreviousTransaction() {
    const state = await chrome.storage.local.get({ [TX_KEY]: null, [HISTORY_KEY]: [] });
    const previous = state[TX_KEY];
    if (!previous) return;
    await verifyStoredTransaction(previous);
    const undoIds = CORE.undoVideoIds(previous);
    const needsRecovery = ['removing', 'undoing', 'partial', 'undo_partial'].includes(previous.state)
      || (Number(previous.schema || 0) < 2 && previous.state === 'prepared');
    if (needsRecovery && undoIds.length) {
      throw new Error('미완료 정리 복구 기록이 남아 있어 자동 정리를 시작하지 않습니다. 먼저 되돌리기를 확인하세요.');
    }
    const history = Array.isArray(state[HISTORY_KEY]) ? state[HISTORY_KEY] : [];
    await chrome.storage.local.set({
      [HISTORY_KEY]: [previous, ...history.filter(x => x?.id !== previous.id)].slice(0, 2)
    });
  }

  async function strictListWatchLater() {
    const listed = await requestPage('EYH_WL_SAFE_LIST_REQUEST', { maxPages: 250 }, 600000);
    if (listed.strict !== true || listed.complete !== true || listed.hasMore !== false
        || listed.terminalReason !== 'no-continuation') {
      throw new Error('Watch Later 전체 목록의 안전한 끝 지점을 확인하지 못했습니다.');
    }
    return listed;
  }

  /**
   * The visible YouTube count may include unavailable/private/deleted rows that intentionally have
   * no usable videoId+setVideoId pair. Those rows are never cleanup candidates. A destructive
   * cleanup is safe to operate on the verified subset because every candidate is re-resolved by
   * videoId immediately before removal. We still fail closed if the parser produces MORE entries
   * than YouTube declares, and the declared count must stay identical across both full snapshots.
   */
  function requireDeclaredCoverage(parsedCount, expectedDeclared = null) {
    const declared = declaredWatchLaterCount();
    if (declared == null) throw new Error('YouTube 화면의 Watch Later 전체 개수를 확인할 수 없습니다.');
    if (declared < parsedCount) {
      throw new Error(`안전 파서 ${parsedCount}개가 YouTube 표시 ${declared}개보다 많아 자동 정리하지 않습니다.`);
    }
    if (expectedDeclared != null && declared !== expectedDeclared) {
      throw new Error(`두 번째 확인 중 Watch Later 표시 개수가 ${expectedDeclared}개에서 ${declared}개로 바뀌었습니다.`);
    }
    return { declared, unparsed: declared - parsedCount };
  }

  async function refreshCentralLedger() {
    const prefs = await chrome.storage.local.get({ cloudEnabled: false });
    const result = await chrome.runtime.sendMessage({ type: 'ACTIVE_YOUTUBE_SYNC', force: true });
    if (prefs.cloudEnabled && (!result || result.pulled == null)) {
      throw new Error('중앙 Eternal 진행률 동기화가 완료되지 않았습니다.');
    }
  }

  async function readLedger(ids) {
    const watched = {}, progress = {};
    const clean = [...new Set((ids || []).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id || '')))];
    for (let i = 0; i < clean.length; i += 400) {
      const result = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: clean.slice(i, i + 400) });
      Object.assign(watched, result?.watched || {});
      Object.assign(progress, result?.progress || {});
    }
    return { watched, progress };
  }

  async function prepareTransaction() {
    await refreshCentralLedger();
    const listed = await strictListWatchLater();
    const entries = listed.entries || [];
    const coverage = requireDeclaredCoverage(entries.length);
    const ledger = await readLedger(entries.map(e => e.videoId));
    const prefs = await chrome.storage.local.get({ watchLaterCleanupMinProgressPct: 60 });
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
    tx.declaredCount = coverage.declared;
    tx.unparsedCount = coverage.unparsed;
    tx.snapshotTerminalReason = listed.terminalReason;
    tx.automatic = true;
    return tx;
  }

  async function revalidateSnapshot(tx) {
    const listed = await strictListWatchLater();
    const current = CORE.normalizeSnapshot(listed.entries || []);
    const coverage = requireDeclaredCoverage(current.length, tx.declaredCount);
    if (coverage.unparsed !== Number(tx.unparsedCount || 0)) {
      throw new Error('두 번째 확인에서 안전하게 식별할 수 없는 Watch Later 항목 수가 바뀌었습니다.');
    }
    if (!CORE.sameSnapshotMembership(tx.snapshot, current)) {
      throw new Error('두 번째 확인에서 안전하게 식별된 Watch Later 멤버십이 바뀌었습니다.');
    }
    return listed;
  }

  async function runAutomaticCleanup(runGeneration) {
    if (busy || !extensionAlive() || !isWatchLaterPage()) return;
    const prefs = await chrome.storage.local.get({ [AUTO_KEY]: false });
    if (!prefs[AUTO_KEY] || runGeneration !== generation) return;
    busy = true;
    globalThis.__eyhWatchLaterSafeAutoBusy = true;
    try {
      setStatus('자동 안전 정리 · 전체 목록과 진행률 확인 중…');
      const tx = await prepareTransaction();
      if (runGeneration !== generation || !isWatchLaterPage()) return;
      const coverageNote = tx.unparsedCount > 0 ? ` · 식별 불가 ${tx.unparsedCount}개는 건드리지 않음` : '';
      if (!tx.candidates.length) {
        setStatus(`${tx.snapshot.length}개 안전 확인${coverageNote} · ${tx.threshold}%+ 자동 정리 대상 없음`);
        return;
      }

      await archivePreviousTransaction();
      let durable = await persistVerified(tx);
      try {
        setStatus('자동 안전 정리 · 전체 목록 두 번째 대조 중…');
        const listed = await revalidateSnapshot(durable);
        durable.snapshotVerifiedAt = Date.now();
        durable.snapshotVerificationPages = Number(listed.pages || 0);
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
        if (runGeneration !== generation || !isWatchLaterPage()) {
          halted = true;
          durable.haltReason = 'page_changed';
          break;
        }
        const candidate = durable.candidates[i];
        candidate.status = 'attempting';
        candidate.attemptStartedAt = Date.now();
        durable = await persistVerified(durable);
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
        durable = await persistVerified(durable);
        if (candidate.status !== 'removed') {
          halted = true;
          durable.haltReason = candidate.status;
          break;
        }
        setStatus(`${i + 1}/${durable.candidates.length} 자동 안전 정리 중…`);
      }

      CORE.recalcCounts(durable);
      durable.state = halted || durable.failureCount > 0 ? 'partial' : 'completed';
      durable.completedAt = Date.now();
      await persistVerified(durable);
      const untouched = durable.unparsedCount > 0 ? ` · 식별 불가 ${durable.unparsedCount}개 미변경` : '';
      setStatus(
        durable.state === 'completed'
          ? `자동 안전 정리 완료 · ${durable.removedCount}개 · 되돌리기 가능${untouched}`
          : `자동 안전 정리 중단 · ${durable.removedCount}개 제거 · 되돌리기 가능${untouched}`,
        durable.state === 'completed' ? '' : 'error'
      );
    } catch (error) {
      setStatus(`자동 안전 정리 중단: ${error.message}`, 'error');
    } finally {
      busy = false;
      globalThis.__eyhWatchLaterSafeAutoBusy = false;
    }
  }

  function onNavigation() {
    const nowWatchLater = isWatchLaterPage();
    if (!nowWatchLater) {
      wasWatchLater = false;
      generation += 1;
      return;
    }
    if (wasWatchLater) return;
    wasWatchLater = true;
    const currentGeneration = ++generation;
    setTimeout(() => runAutomaticCleanup(currentGeneration).catch(() => {}), 1800);
  }

  if (!CORE || !extensionAlive()) return;
  window.addEventListener('yt-navigate-finish', onNavigation, true);
  window.addEventListener('popstate', onNavigation, true);
  setTimeout(onNavigation, 1200);
})();
