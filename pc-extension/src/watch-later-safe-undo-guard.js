(() => {
  'use strict';

  const PAGE = 'eternal-youtube-history-page';
  const CONTENT = 'eternal-youtube-history-content';
  const CORE = globalThis.EYHWatchLaterSafeCore;
  const TX_KEY = 'eyhWatchLaterSafeTransactionV1';
  const pending = new Map();
  let busy = false;

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

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function persistVerified(tx) {
    tx.updatedAt = Date.now();
    CORE.recalcCounts(tx);
    tx.journalDigest = await sha256Hex(CORE.canonicalForDigest(tx));
    await storageSet({ [TX_KEY]: tx });
    const check = (await storageGet({ [TX_KEY]: null }))[TX_KEY];
    if (!check || check.id !== tx.id || check.journalDigest !== tx.journalDigest) {
      throw new Error('Watch Later 되돌리기 journal 저장 확인에 실패했습니다.');
    }
    const recomputed = await sha256Hex(CORE.canonicalForDigest(check));
    if (recomputed !== check.journalDigest) throw new Error('Watch Later 되돌리기 journal 무결성 확인에 실패했습니다.');
    return check;
  }

  function shouldRestore(candidate) {
    if (!candidate) return false;
    const status = String(candidate.status || 'prepared');
    // These states are assigned before any delete request is sent. Re-adding them could resurrect a
    // video the user removed independently, so the undo path must never issue ACTION_ADD_VIDEO.
    if (status === 'missing' || status === 'identity_mismatch') return false;
    return String(candidate.undoStatus || 'pending') !== 'not_removed';
  }

  function setStatus(text, kind = '') {
    const status = document.querySelector('#eyh-header-status');
    if (!status) return;
    status.textContent = text || '';
    status.dataset.kind = kind || '';
  }

  function requestAdd(tx, candidate, timeoutMs = 120000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Watch Later 복구 요청 시간이 초과되었습니다.'));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      window.postMessage({
        source: CONTENT,
        target: PAGE,
        type: 'EYH_WL_SAFE_ADD_REQUEST',
        requestId,
        operationId: tx.id,
        journalDigest: tx.journalDigest,
        videoId: candidate.videoId
      }, '*');
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
    if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'Watch Later 복구 실패'));
  });

  async function runNarrowUndo() {
    if (busy) return;
    busy = true;
    try {
      let tx = (await storageGet({ [TX_KEY]: null }))[TX_KEY];
      const candidates = Array.isArray(tx?.candidates) ? tx.candidates : [];
      if (!tx || !candidates.length || tx.state === 'undone') {
        setStatus('되돌릴 안전 정리 기록이 없습니다.');
        return;
      }
      const restoreCandidates = candidates.filter(shouldRestore);
      const untouched = candidates.length - restoreCandidates.length;
      if (!restoreCandidates.length) {
        setStatus('우리 정리 코드가 제거했을 가능성이 있는 항목이 없습니다.');
        return;
      }
      const suffix = untouched ? `\n\n삭제 요청을 보내지 않았음이 확정된 ${untouched}개는 건드리지 않습니다.` : '';
      if (!confirm(
        `우리 정리 코드가 제거했거나 결과가 불확실한 ${restoreCandidates.length}개의 Watch Later 멤버십만 확인·복구할까요?${suffix}\n\nYouTube의 추가 API 특성상 원래의 정확한 목록 위치까지는 복원되지 않을 수 있습니다.`
      )) return;

      tx.state = 'undoing';
      tx.undoStartedAt = Date.now();
      tx = await persistVerified(tx);
      for (let i = 0; i < tx.candidates.length; i += 1) {
        const candidate = tx.candidates[i];
        if (!shouldRestore(candidate)) {
          candidate.undoStatus = 'not_removed';
          candidate.undoAt = Date.now();
          tx = await persistVerified(tx);
          continue;
        }
        setStatus(`${i + 1}/${tx.candidates.length} Watch Later 멤버십 복구 중…`);
        try {
          const result = await requestAdd(tx, candidate);
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
    }
  }

  if (!CORE) return;

  // Capture before the v0.10.4 button-target listener. This keeps the proven cleanup engine intact
  // while replacing only undo with the narrower no-resurrection policy.
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('#eyh-watch-later-safe-undo') : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    runNarrowUndo().catch(error => setStatus(error.message, 'error'));
  }, true);
})();
