const CORE = globalThis.EYHWatchLaterRecoveryCore;
const WL_URL = 'https://www.youtube.com/playlist?list=WL';
const HISTORY_PERMISSION = { permissions: ['history'] };
const HISTORY_MAX_RESULTS = 100000;
const JOURNAL_KEY = 'eyhWatchLaterRecoveryJournalV1';
const $ = selector => document.querySelector(selector);

let candidates = [];
let currentCount = 0;
let busy = false;

function setStatus(text, error = false) {
  const node = $('#status');
  node.textContent = text;
  node.style.color = error ? '#f28b82' : '#a8c7fa';
}

function isWatchLaterUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.hostname === 'www.youtube.com'
      && url.pathname === '/playlist'
      && url.searchParams.get('list') === 'WL';
  } catch {
    return false;
  }
}

async function sendWithRetry(tabId, message, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response?.ok) return response;
      lastError = new Error(response?.error || 'YouTube 탭 응답이 아직 준비되지 않았습니다.');
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw lastError || new Error('YouTube Watch Later 탭과 연결하지 못했습니다.');
}

async function withWatchLaterTab(task) {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*'] });
  let tab = tabs.find(item => isWatchLaterUrl(item.url));
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: WL_URL, active: false });
    created = true;
  }
  if (!tab?.id) throw new Error('Watch Later 탭을 열지 못했습니다.');
  try {
    return await task(tab.id);
  } finally {
    if (created) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function getCurrentSnapshot() {
  return withWatchLaterTab(tabId => sendWithRetry(tabId, { type: 'EYH_RECOVERY_GET_WL_SNAPSHOT' }, 90000));
}

async function readLedgerProgress(ids) {
  const progress = {};
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'CHECK_WATCHED', ids: chunk });
      Object.assign(progress, result?.progress || {});
    } catch {
      // Recovery evidence remains valid without Eternal progress enrichment.
    }
  }
  return progress;
}

async function scanChromeHistory() {
  const rows = await chrome.history.search({
    text: 'youtube.com/watch',
    startTime: 0,
    maxResults: HISTORY_MAX_RESULTS
  });
  return {
    evidence: CORE.collectEvidence(rows),
    truncated: rows.length >= HISTORY_MAX_RESULTS
  };
}

function selectedIds() {
  return [...document.querySelectorAll('.candidate input[type="checkbox"]:checked')]
    .map(node => node.dataset.videoId)
    .filter(Boolean);
}

function updateSelectedCount() {
  const count = selectedIds().length;
  $('#selectedCount').textContent = count.toLocaleString();
  $('#restore').disabled = busy || count === 0;
  $('#clearSelection').disabled = busy || count === 0;
}

function candidateRow(item) {
  const row = document.createElement('label');
  row.className = 'candidate';
  row.dataset.videoId = item.videoId;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.dataset.videoId = item.videoId;
  check.disabled = Boolean(item.recoveryStatus);
  check.addEventListener('change', updateSelectedCount);

  const info = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'candidateTitle';
  title.textContent = item.title || item.videoId;
  const meta = document.createElement('div');
  meta.className = 'candidateMeta';
  const date = item.lastVisitTime ? new Date(item.lastVisitTime).toLocaleString() : '날짜 정보 없음';
  meta.textContent = `${date} · Chrome WL URL 근거 ${item.evidenceCount}건 · ${item.videoId}`;
  const link = document.createElement('a');
  link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = '영상 열기';
  info.append(title, meta, link);

  const progress = document.createElement('div');
  progress.className = 'progress';
  if (item.recoveryStatus) progress.textContent = item.recoveryStatus;
  else progress.textContent = item.progressPct == null ? '' : `Eternal ${Math.round(item.progressPct)}%`;

  row.append(check, info, progress);
  return row;
}

function render() {
  $('#summary').hidden = false;
  $('#resultsCard').hidden = false;
  $('#candidateCount').textContent = candidates.length.toLocaleString();
  $('#currentCount').textContent = currentCount.toLocaleString();
  const root = $('#results');
  root.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Chrome 기록에서 현재 Watch Later에 없는 확실한 WL 방문 후보를 찾지 못했습니다.';
    root.appendChild(empty);
  } else {
    for (const item of candidates) root.appendChild(candidateRow(item));
  }
  $('#selectAll').disabled = busy || candidates.every(item => item.recoveryStatus);
  updateSelectedCount();
}

async function runScan() {
  if (busy) return;
  busy = true;
  $('#scan').disabled = true;
  $('#selectAll').disabled = true;
  $('#clearSelection').disabled = true;
  $('#restore').disabled = true;
  setStatus('Chrome 방문 기록에서 list=WL 근거를 찾는 중…');

  let scan;
  try {
    scan = await scanChromeHistory();
  } finally {
    await chrome.permissions.remove(HISTORY_PERMISSION).catch(() => false);
  }

  try {
    setStatus('history 권한을 반납했습니다. 현재 Watch Later 전체 목록을 안전하게 비교 중…');
    const snapshot = await getCurrentSnapshot();
    currentCount = Number(snapshot.declaredCount || snapshot.entries?.length || 0);
    const progress = await readLedgerProgress(scan.evidence.map(item => item.videoId));
    candidates = CORE.buildRecoveryCandidates(scan.evidence, snapshot.entries || [], progress);
    $('#historyEvidence').textContent = scan.evidence.length.toLocaleString();
    render();
    setStatus(
      `현재 Watch Later ${currentCount}개와 비교해 복구 후보 ${candidates.length}개를 찾았습니다.${scan.truncated ? ' Chrome history 검색 상한에 도달해 일부 오래된 기록은 빠질 수 있습니다.' : ''}`
    );
  } finally {
    busy = false;
    $('#scan').disabled = false;
    render();
  }
}

async function persistJournal(journal) {
  journal.updatedAt = Date.now();
  await chrome.storage.local.set({ [JOURNAL_KEY]: journal });
  const stored = (await chrome.storage.local.get({ [JOURNAL_KEY]: null }))[JOURNAL_KEY];
  if (!stored || stored.id !== journal.id || stored.updatedAt !== journal.updatedAt) {
    throw new Error('복구 journal 저장 확인에 실패했습니다. 추가 작업을 중단합니다.');
  }
  return stored;
}

async function restoreSelected() {
  if (busy) return;
  const ids = selectedIds();
  if (!ids.length) return;
  if (!confirm(`선택한 ${ids.length}개 영상을 Watch Later에 다시 추가할까요?\n\n삭제 작업은 하지 않습니다. 각 영상은 추가 직전 journal에 기록되고 YouTube가 실제 멤버십을 확인한 뒤 다음 항목으로 진행합니다.`)) return;

  busy = true;
  render();
  const journal = {
    schema: 1,
    id: `pcwl-recovery:${crypto.randomUUID()}`,
    source: 'chrome-history-list-wl',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: 'prepared',
    items: ids.map(videoId => ({ videoId, status: 'prepared' }))
  };

  try {
    let durable = await persistJournal(journal);
    durable.state = 'restoring';
    durable = await persistJournal(durable);

    await withWatchLaterTab(async tabId => {
      const before = await sendWithRetry(tabId, { type: 'EYH_RECOVERY_GET_WL_SNAPSHOT' }, 90000);
      const present = new Set((before.entries || []).map(entry => entry.videoId));

      for (let index = 0; index < durable.items.length; index += 1) {
        const item = durable.items[index];
        if (present.has(item.videoId)) {
          item.status = 'already_present';
          item.completedAt = Date.now();
          durable = await persistJournal(durable);
          continue;
        }

        item.status = 'attempting';
        item.attemptStartedAt = Date.now();
        durable = await persistJournal(durable);
        setStatus(`${index + 1}/${durable.items.length} · ${item.videoId} Watch Later 멤버십 확인/복구 중…`);

        try {
          const result = await sendWithRetry(tabId, {
            type: 'EYH_RECOVERY_ADD_ONE',
            operationId: durable.id,
            videoId: item.videoId
          }, 120000);
          item.status = result.status === 'already_present' ? 'already_present' : 'restored';
          item.completedAt = Date.now();
          present.add(item.videoId);
        } catch (error) {
          item.status = 'failed';
          item.error = String(error?.message || error).slice(0, 300);
          item.completedAt = Date.now();
        }
        durable = await persistJournal(durable);
      }
    });

    durable.state = durable.items.some(item => item.status === 'failed') ? 'partial' : 'completed';
    durable.completedAt = Date.now();
    durable = await persistJournal(durable);

    const byId = new Map(durable.items.map(item => [item.videoId, item.status]));
    for (const item of candidates) {
      const status = byId.get(item.videoId);
      if (status === 'restored') item.recoveryStatus = '복구됨';
      else if (status === 'already_present') item.recoveryStatus = '이미 있음';
      else if (status === 'failed') item.recoveryStatus = '복구 실패';
    }
    const restored = durable.items.filter(item => item.status === 'restored').length;
    const existing = durable.items.filter(item => item.status === 'already_present').length;
    const failed = durable.items.filter(item => item.status === 'failed').length;
    currentCount += restored;
    render();
    setStatus(`복구 처리 완료 · 새로 추가 ${restored} · 이미 존재 ${existing} · 실패 ${failed}`, failed > 0);
  } catch (error) {
    setStatus(`복구 중단: ${error.message}`, true);
  } finally {
    busy = false;
    $('#scan').disabled = false;
    render();
  }
}

$('#scan').addEventListener('click', async () => {
  if (busy) return;
  // Permission request must be directly attached to this user gesture. It is removed immediately
  // after the history scan, before any YouTube comparison or recovery request begins.
  const granted = await chrome.permissions.request(HISTORY_PERMISSION).catch(() => false);
  if (!granted) {
    setStatus('Chrome 방문 기록 권한을 허용해야 list=WL 복구 후보를 찾을 수 있습니다.', true);
    return;
  }
  runScan().catch(error => {
    busy = false;
    $('#scan').disabled = false;
    setStatus(`복구 후보 스캔 실패: ${error.message}`, true);
  });
});

$('#selectAll').addEventListener('click', () => {
  for (const box of document.querySelectorAll('.candidate input[type="checkbox"]:not(:disabled)')) box.checked = true;
  updateSelectedCount();
});
$('#clearSelection').addEventListener('click', () => {
  for (const box of document.querySelectorAll('.candidate input[type="checkbox"]')) box.checked = false;
  updateSelectedCount();
});
$('#restore').addEventListener('click', () => restoreSelected());
