const $ = s => document.querySelector(s);

async function requestWorkerPermission(url) {
  if (!url) return true;
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('Worker URL은 https:// 주소여야 합니다.');
  const originPattern = `${u.protocol}//${u.host}/*`;
  const has = await chrome.permissions.contains({ origins: [originPattern] });
  return has || await chrome.permissions.request({ origins: [originPattern] });
}

async function load() {
  const v = await chrome.storage.local.get({
    directWatchSeconds: 5,
    watchedDisplayMode: 'dim',
    watchedMinProgressPct: 0,
    watchedThumbnailOpacityPct: 65,
    watchedThumbnailGrayscale: false,
    watchedLinkCardInfo: false,
    watchLaterAutoCleanupEnabled: false,
    watchLaterCleanupMinProgressPct: 60,
    autoHistoryPages: 3,
    cloudEnabled: false,
    workerUrl: '',
    apiToken: ''
  });
  $('#directWatchSeconds').value = v.directWatchSeconds;
  $('#watchedDisplayMode').value = ['dim','hide','none'].includes(v.watchedDisplayMode) ? v.watchedDisplayMode : 'dim';
  $('#watchedMinProgressPct').value = v.watchedMinProgressPct;
  $('#watchedThumbnailOpacityPct').value = Math.max(10, Math.min(100, Number(v.watchedThumbnailOpacityPct) || 65));
  $('#watchedThumbnailGrayscale').checked = Boolean(v.watchedThumbnailGrayscale);
  $('#watchedLinkCardInfo').checked = Boolean(v.watchedLinkCardInfo);
  $('#watchLaterAutoCleanupEnabled').checked = Boolean(v.watchLaterAutoCleanupEnabled);
  $('#watchLaterCleanupMinProgressPct').value = Math.max(1, Math.min(100, Number(v.watchLaterCleanupMinProgressPct) || 60));
  $('#autoHistoryPages').value = v.autoHistoryPages;
  $('#cloudEnabled').checked = Boolean(v.cloudEnabled);
  $('#workerUrl').value = v.workerUrl || '';
  $('#apiToken').value = v.apiToken || '';
  await refreshStatus();
}

async function save() {
  const workerUrl = $('#workerUrl').value.trim().replace(/\/+$/, '');
  const enabled = $('#cloudEnabled').checked;
  if (enabled && workerUrl && !(await requestWorkerPermission(workerUrl))) throw new Error('Worker 도메인 접근 권한이 필요합니다.');
  await chrome.storage.local.set({
    directWatchSeconds: Math.max(1, Math.min(120, Number($('#directWatchSeconds').value) || 5)),
    watchedDisplayMode: ['dim','hide','none'].includes($('#watchedDisplayMode').value) ? $('#watchedDisplayMode').value : 'dim',
    watchedMinProgressPct: Math.max(0, Math.min(100, Number($('#watchedMinProgressPct').value) || 0)),
    watchedThumbnailOpacityPct: Math.max(10, Math.min(100, Number($('#watchedThumbnailOpacityPct').value) || 65)),
    watchedThumbnailGrayscale: $('#watchedThumbnailGrayscale').checked,
    watchedLinkCardInfo: $('#watchedLinkCardInfo').checked,
    watchLaterAutoCleanupEnabled: $('#watchLaterAutoCleanupEnabled').checked,
    watchLaterCleanupMinProgressPct: Math.max(1, Math.min(100, Number($('#watchLaterCleanupMinProgressPct').value) || 60)),
    autoHistoryPages: Math.max(1, Math.min(50, Number($('#autoHistoryPages').value) || 3)),
    cloudEnabled: enabled,
    workerUrl,
    apiToken: $('#apiToken').value,
    autoSyncEnabled: false,
    autoSyncMode: 'manual'
  });
  $('#status').textContent = '저장했습니다. v0.7은 백그라운드 주기 동기화를 만들지 않습니다.';
  await refreshStatus();
}

async function refreshStatus() {
  const s = await chrome.runtime.sendMessage({ type: 'GET_CLIENT_STATUS' }).catch(() => null);
  if (!s) { $('#cloudQueueStatus').textContent = '상태를 읽지 못했습니다.'; return; }
  const server = s.server;
  const parts = [`PC 표시 캐시 ${Number(s.cacheCount || 0).toLocaleString()}개`, `전송 대기 ${Number(s.pending || 0).toLocaleString()}건`];
  if (server) parts.unshift(`D1 영상 ${Number(server.count || 0).toLocaleString()}개 / 이벤트 ${Number(server.eventCount || 0).toLocaleString()}회`);
  if (s.lastCloudPullAt) parts.push(`마지막 활성 동기화 ${new Date(Number(s.lastCloudPullAt)).toLocaleString('ko-KR')}`);
  if (s.lastCloudPullError) parts.push(`최근 동기화 오류: ${s.lastCloudPullError}`);
  if (s.lastCloudFlushError) parts.push(`최근 전송 오류: ${s.lastCloudFlushError}`);
  $('#cloudQueueStatus').textContent = parts.join(' · ');
}

$('#save').addEventListener('click', () => save().catch(e => $('#status').textContent = e.message));
$('#testCloud').addEventListener('click', async () => {
  try {
    await save();
    const s = await chrome.runtime.sendMessage({ type: 'GET_CLOUD_STATS' });
    $('#status').textContent = `D1 연결 정상: 영상 ${Number(s.count || 0).toLocaleString()}개 / 이벤트 ${Number(s.eventCount || 0).toLocaleString()}회`;
  } catch (e) { $('#status').textContent = `연결 실패: ${e.message}`; }
  await refreshStatus();
});
$('#rebuildCache').addEventListener('click', async () => {
  if (!confirm('D1 중앙 원장의 영상 목록을 이 PC 표시 캐시에 다시 내려받습니다. 계속할까요?')) return;
  $('#status').textContent = 'D1에서 PC 표시 캐시를 재구축하는 중…';
  const r = await chrome.runtime.sendMessage({ type: 'REBUILD_CACHE_FROM_D1' });
  $('#status').textContent = r?.error ? `실패: ${r.error}` : `완료: ${Number(r.imported || 0).toLocaleString()}개 확인`;
  await refreshStatus();
});
$('#flushQueue').addEventListener('click', async () => {
  $('#status').textContent = '대기 기록 전송 중…';
  const r = await chrome.runtime.sendMessage({ type: 'FLUSH_CLOUD_QUEUE' });
  $('#status').textContent = r?.error ? `실패: ${r.error}` : `전송 완료 · 남은 대기 ${Number(r.pending || 0)}건`;
  await refreshStatus();
});
$('#openCloudHistory').addEventListener('click', async () => {
  const v = await chrome.storage.local.get({ workerUrl: '', cloudEnabled: false });
  if (!v.cloudEnabled || !v.workerUrl) { $('#status').textContent = 'D1 중앙 원장을 먼저 연결해 주세요.'; return; }
  chrome.tabs.create({ url: v.workerUrl.replace(/\/+$/, '') + '/' });
});
load();


$('#runDiagnostics').addEventListener('click', async () => {
  const out = $('#diagnostics');
  out.textContent = '진단 중…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/www\.youtube\.com\//.test(tab.url || '')) {
      throw new Error('현재 창의 활성 탭이 youtube.com이 아닙니다.');
    }
    const page = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_DIAGNOSTICS' });
    const client = await chrome.runtime.sendMessage({ type: 'GET_CLIENT_STATUS' }).catch(() => null);
    out.textContent = JSON.stringify({ generatedAt: new Date().toISOString(), page, client }, null, 2);
  } catch (e) {
    out.textContent = `진단 실패: ${e.message}`;
  }
});
