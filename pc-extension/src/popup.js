const $ = s => document.querySelector(s);

function formatSafeTx(tx) {
  if (!tx || typeof tx !== 'object' || !Number(tx.updatedAt || tx.completedAt)) return '최근 정리 기록 없음';
  const when = new Date(Number(tx.completedAt || tx.updatedAt)).toLocaleString('ko-KR');
  const labels = { completed: '완료', partial: '부분 완료(되돌리기 가능)', aborted: '중단', undone: '되돌림', undo_partial: '되돌리기 일부 실패', removing: '진행 중/중단됨', prepared: '준비됨' };
  return `최근 정리 ${when} · ${labels[tx.state] || tx.state} · 제거 ${Number(tx.removedCount || 0)}개`;
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'GET_CLIENT_STATUS' }).catch(() => null);
  const serverCount = Number(s?.server?.count);
  const cacheCount = Number(s?.cacheCount || 0);
  const useServer = Number.isFinite(serverCount);
  $('#count').textContent = (useServer ? serverCount : cacheCount).toLocaleString();
  $('#countLabel').textContent = useServer ? '서버 원장 영상' : '이 PC 표시 캐시 영상';
  const ec = Number(s?.server?.eventCount ?? s?.eventCount ?? 0);
  $('#eventCount').textContent = ec.toLocaleString();
  $('#eventStat').hidden = ec <= 0;
  const cfg = await chrome.storage.local.get({
    watchedDisplayMode: 'dim',
    watchedMinProgressPct: 0,
    watchedSurfaceDefaultProfile: null,
    watchedThumbnailOpacityPct: 65,
    watchedThumbnailGrayscale: false,
    watchLaterSafeAutoCleanupEnabled: false,
    watchLaterCleanupMinProgressPct: 60,
    eyhWatchLaterSafeTransactionV1: null,
    eyhBlockEnabled: true,
    eyhBlockChannels: [],
    eyhBlockKeywords: []
  });
  const p = cfg.watchedSurfaceDefaultProfile;
  let mode = cfg.watchedDisplayMode, threshold = Number(cfg.watchedMinProgressPct || 0);
  if (p && typeof p === 'object') {
    mode = p.hideEnabled ? 'hide' : p.dimEnabled ? 'dim' : 'none';
    threshold = Number((p.linkedThresholds !== false ? p.sharedThreshold : (p.hideEnabled ? p.hideThreshold : p.dimThreshold)) || 0);
  }
  const modeLabel = mode === 'hide' ? '숨기기' : mode === 'none' ? '표시 변경 안 함' : '흐리게';
  const styleLabel = mode === 'dim' ? ` · 불투명도 ${Math.max(10, Math.min(100, Number(cfg.watchedThumbnailOpacityPct) || 65))}%${cfg.watchedThumbnailGrayscale ? ' · 흑백' : ''}` : '';
  $('#displayRule').textContent = `시청 영상 기본값: ${modeLabel}${styleLabel} · 최소 진행률 ${threshold}% (페이지별 설정은 YouTube 상단 ⚙)`;
  const wlPct = Math.max(1, Math.min(100, Number(cfg.watchLaterCleanupMinProgressPct) || 60));
  $('#watchLaterSafety').textContent = `나중에 볼 동영상 ${wlPct}%+ 자동 정리: ${cfg.watchLaterSafeAutoCleanupEnabled ? '켜짐' : '꺼짐'} · ${formatSafeTx(cfg.eyhWatchLaterSafeTransactionV1)}`;
  const blockCount = (Array.isArray(cfg.eyhBlockChannels) ? cfg.eyhBlockChannels.length : 0) + (Array.isArray(cfg.eyhBlockKeywords) ? cfg.eyhBlockKeywords.length : 0);
  $('#blockRule').textContent = blockCount ? `차단 목록 ${cfg.eyhBlockEnabled !== false ? '사용' : '꺼짐'} · ${blockCount}개 항목` : '차단 목록 비어 있음 (YouTube에서 우클릭 → Eternal: 이 채널 차단)';
}

async function sync(maxPages, label) {
  $('#status').textContent = `${label} 중… 이 작업을 누른 경우에만 YouTube History 페이지를 확인합니다.`;
  const r = await chrome.runtime.sendMessage({ type: 'SYNC_HISTORY_NOW', maxPages });
  if (r?.ok) {
    const inserted = Number(r.inserted || 0);
    const latestTitle = r.latestRecord?.title ? String(r.latestRecord.title) : '(제목 없음)';
    const pathLabel = r.syncPath === 'existing-history-tab' ? '열어둔 시청 기록 탭' : '임시 시청 기록 탭';
    $('#status').textContent = `${pathLabel}에서 ${Number(r.fetched || 0)}개 확인 · 신규 ${inserted}개${r.latestRecord ? ` · 최신 “${latestTitle.slice(0, 55)}”` : ''}.`;
  } else {
    $('#status').textContent = r?.error || '수동 복구 실패';
  }
  await refresh();
}

$('#openHistory').addEventListener('click', async () => {
  const cfg = await chrome.storage.local.get({ workerUrl: '', cloudEnabled: false });
  if (!cfg.cloudEnabled || !cfg.workerUrl) {
    $('#status').textContent = '설정에서 D1 중앙 원장을 먼저 연결해 주세요.';
    return;
  }
  chrome.tabs.create({ url: cfg.workerUrl.replace(/\/+$/, '') + '/' });
  window.close();
});
$('#syncRecent').addEventListener('click', () => sync(3, '최근 누락 복구'));
$('#syncFull').addEventListener('click', () => sync(500, '과거 누락 복구'));
$('#recoverWatchLater').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('recovery.html') });
  window.close();
});
$('#options').addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
refresh();
