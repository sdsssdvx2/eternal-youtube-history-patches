const $ = s => document.querySelector(s);

function formatSweep(sweep) {
  if (!sweep || typeof sweep !== 'object' || !Number(sweep.at)) {
    return 'Watch Later 안전 잠금: 켜짐 · 기록된 PC 자동 정리 실행 없음';
  }
  const when = new Date(Number(sweep.at)).toLocaleString();
  if (sweep.error) return `Watch Later 안전 잠금: 켜짐 · 최근 PC 자동 정리 시도 ${when} · 오류: ${String(sweep.error)}`;
  return `Watch Later 안전 잠금: 켜짐 · 최근 PC 자동 정리 ${when} · 기준 ${Number(sweep.threshold || 0)}% · 확인 ${Number(sweep.scanned || 0)} · 대상 ${Number(sweep.qualified || 0)} · 삭제 ${Number(sweep.removed || 0)} · 실패 ${Number(sweep.failures || 0)}`;
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
    watchedThumbnailOpacityPct: 65,
    watchedThumbnailGrayscale: false,
    watchedLinkCardInfo: false,
    watchLaterAutoCleanupEnabled: false,
    eyhLastAutoWatchLaterSweep: null
  });
  const modeLabel = cfg.watchedDisplayMode === 'hide' ? '숨기기' : cfg.watchedDisplayMode === 'none' ? '표시 변경 안 함' : '옅게 표시';
  const styleLabel = cfg.watchedDisplayMode === 'dim' ? ` · 불투명도 ${Math.max(10, Math.min(100, Number(cfg.watchedThumbnailOpacityPct) || 65))}% · 흑백 ${cfg.watchedThumbnailGrayscale ? '켬' : '끔'} · 영상 정보 연동 ${cfg.watchedLinkCardInfo ? '켬' : '끔'}` : '';
  $('#displayRule').textContent = `시청 영상: ${modeLabel}${styleLabel} · 최소 진행률 ${Number(cfg.watchedMinProgressPct || 0)}%`;
  $('#watchLaterSafety').textContent = `${formatSweep(cfg.eyhLastAutoWatchLaterSweep)} · 현재 자동 설정 ${cfg.watchLaterAutoCleanupEnabled ? '켜짐(안전 잠금으로 실행 차단)' : '꺼짐'}`;
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
$('#options').addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
refresh();
