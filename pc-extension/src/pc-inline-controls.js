(() => {
  'use strict';

  const AUTO_KEY = 'watchLaterSafeAutoCleanupEnabled';
  const PANEL_ID = 'eyh-inline-settings-panel';
  const GEAR_ID = 'eyh-inline-settings';
  const AUTO_BUTTON_ID = 'eyh-watch-later-safe-auto';
  const RETRY_DELAYS = [0, 120, 500, 1400];
  let renderQueued = false;

  const LABELS = {
    home: '홈', watch: '영상 상세 · 관련 영상', subscriptions: '구독', channel: '채널',
    search: '검색 결과', watch_later: '나중에 볼 동영상', liked: '좋아요', playlists: '재생목록',
    playlist_detail: '재생목록 상세', history: '시청 기록', library: '내 페이지 · 라이브러리', other: '기타'
  };

  const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));

  function extensionAlive() {
    try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; }
  }

  function offerReloadForStaleContext() {
    const reload = confirm(
      'Eternal 확장이 업데이트되어 이 YouTube 탭의 이전 확장 컨텍스트가 끊겼습니다.\n\n' +
      '확장이나 설정을 다시 설치할 필요는 없습니다. 이 YouTube 탭만 새로고침하면 현재 설정을 그대로 유지한 채 다시 연결됩니다.\n\n지금 이 탭을 새로고침할까요?'
    );
    if (reload) location.reload();
  }

  function surfaceKey() {
    const path = location.pathname;
    const query = new URLSearchParams(location.search);
    if (path.startsWith('/shorts/')) return 'shorts';
    if (path === '/watch') return 'watch';
    if (path === '/results') return 'search';
    if (path.startsWith('/feed/subscriptions')) return 'subscriptions';
    if (path.startsWith('/feed/history')) return 'history';
    if (path.startsWith('/feed/playlists')) return 'playlists';
    if (path === '/feed/you' || path.startsWith('/feed/library')) return 'library';
    if (path === '/playlist') {
      const list = query.get('list') || '';
      if (list === 'WL') return 'watch_later';
      if (list === 'LL') return 'liked';
      return 'playlist_detail';
    }
    if (/^\/(?:@[^/]+|channel\/|c\/|user\/)/.test(path)) return 'channel';
    if (path === '/' || path === '') return 'home';
    return 'other';
  }

  function isWatchLaterPage() {
    return surfaceKey() === 'watch_later';
  }

  function normalizeProfile(profile, fallbackMode = 'dim', fallbackThreshold = 0) {
    if (!profile || typeof profile !== 'object') {
      const threshold = clamp(fallbackThreshold);
      return {
        dimEnabled: fallbackMode === 'dim', hideEnabled: fallbackMode === 'hide', linkedThresholds: true,
        sharedThreshold: threshold, dimThreshold: threshold, hideThreshold: threshold
      };
    }
    return {
      dimEnabled: Boolean(profile.dimEnabled),
      hideEnabled: Boolean(profile.hideEnabled),
      linkedThresholds: profile.linkedThresholds !== false,
      sharedThreshold: clamp(profile.sharedThreshold),
      dimThreshold: clamp(profile.dimThreshold),
      hideThreshold: clamp(profile.hideThreshold)
    };
  }

  async function readState() {
    const values = await chrome.storage.local.get({
      watchedDisplayMode: 'dim',
      watchedMinProgressPct: 0,
      watchedSurfaceDefaultProfile: null,
      watchedSurfaceProfiles: {},
      watchLaterCleanupMinProgressPct: 60,
      [AUTO_KEY]: false
    });
    const legacyMode = ['dim', 'hide', 'none'].includes(values.watchedDisplayMode) ? values.watchedDisplayMode : 'dim';
    const defaults = normalizeProfile(values.watchedSurfaceDefaultProfile, legacyMode, values.watchedMinProgressPct);
    const profiles = values.watchedSurfaceProfiles && typeof values.watchedSurfaceProfiles === 'object'
      ? values.watchedSurfaceProfiles : {};
    const key = surfaceKey();
    const hasOverride = Object.prototype.hasOwnProperty.call(profiles, key);
    return {
      values, profiles, defaults, key, hasOverride,
      profile: normalizeProfile(hasOverride ? profiles[key] : defaults, legacyMode, values.watchedMinProgressPct)
    };
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
    }, kind === 'error' ? 14000 : 8000);
  }

  function ensurePanelStyles() {
    if (document.getElementById('eyh-inline-settings-style')) return;
    const style = document.createElement('style');
    style.id = 'eyh-inline-settings-style';
    style.textContent = `
      #${PANEL_ID}{position:fixed;z-index:2147483646;top:64px;right:18px;width:min(380px,calc(100vw - 36px));box-sizing:border-box;padding:16px;border:1px solid rgba(0,0,0,.16);border-radius:14px;background:#fff;color:#0f0f0f;box-shadow:0 10px 34px rgba(0,0,0,.28);font:14px/1.4 Roboto,Arial,sans-serif}
      html[dark] #${PANEL_ID},body[dark] #${PANEL_ID},ytd-app[dark] #${PANEL_ID}{border-color:rgba(255,255,255,.18);background:#212121;color:#f1f1f1}
      #${PANEL_ID}>strong{display:block;margin-bottom:6px;font-size:16px}
      #${PANEL_ID} .eyh-inline-note{margin-bottom:10px;opacity:.72;font-size:12px}
      #${PANEL_ID} .eyh-inline-row{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:34px;margin:2px 0}
      #${PANEL_ID} .eyh-inline-row input[type=number]{width:74px;box-sizing:border-box;padding:5px 7px;border:1px solid rgba(127,127,127,.45);border-radius:7px;background:transparent;color:inherit}
      #${PANEL_ID} .eyh-inline-section{margin-top:12px;padding-top:10px;border-top:1px solid rgba(127,127,127,.25);font-weight:600}
      #${PANEL_ID} .eyh-inline-actions{display:flex;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin-top:12px}
      #${PANEL_ID} button{border:0;border-radius:16px;padding:7px 12px;cursor:pointer;background:rgba(127,127,127,.18);color:inherit}
      #${PANEL_ID} button.primary{background:var(--yt-spec-call-to-action,#065fd4);color:#fff}
    `;
    document.documentElement.appendChild(style);
  }

  function closePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function field(label, input) {
    const row = document.createElement('label');
    row.className = 'eyh-inline-row';
    const text = document.createElement('span');
    text.textContent = label;
    row.append(text, input);
    return row;
  }

  function checkbox(checked) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    return input;
  }

  function numberInput(value, min = 0, max = 100) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(Math.max(min, Math.min(max, Number(value) || 0)));
    return input;
  }

  async function openPanel() {
    closePanel();
    if (surfaceKey() === 'shorts') return;
    if (!extensionAlive()) {
      offerReloadForStaleContext();
      return;
    }
    ensurePanelStyles();
    const state = await readState();
    if (state.key !== surfaceKey() || state.key === 'shorts') return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Eternal 현재 페이지 설정');

    const title = document.createElement('strong');
    title.textContent = `${LABELS[state.key] || LABELS.other} · Eternal 설정`;
    panel.appendChild(title);

    const note = document.createElement('div');
    note.className = 'eyh-inline-note';
    note.textContent = state.hasOverride
      ? '이 페이지에 저장된 개별 설정입니다. 변경 후 적용을 누르면 바로 반영됩니다.'
      : '현재 공통 기본값을 보여줍니다. 적용하면 이 페이지의 개별 설정으로 저장됩니다.';
    panel.appendChild(note);

    const dim = checkbox(state.profile.dimEnabled);
    const hide = checkbox(state.profile.hideEnabled);
    const linked = checkbox(state.profile.linkedThresholds);
    const shared = numberInput(state.profile.sharedThreshold);
    const dimPct = numberInput(state.profile.dimThreshold);
    const hidePct = numberInput(state.profile.hideThreshold);
    panel.append(field('시청한 영상 흐리게', dim), field('시청한 영상 숨기기', hide), field('진행률 기준 같이 사용', linked));
    const sharedRow = field('공통 최소 진행률 (%)', shared);
    const dimRow = field('흐림 최소 진행률 (%)', dimPct);
    const hideRow = field('숨김 최소 진행률 (%)', hidePct);
    panel.append(sharedRow, dimRow, hideRow);
    const refreshRows = () => {
      sharedRow.hidden = !linked.checked;
      dimRow.hidden = linked.checked;
      hideRow.hidden = linked.checked;
    };
    linked.addEventListener('change', refreshRows);
    refreshRows();

    let autoCleanup = null;
    let cleanupPct = null;
    if (state.key === 'watch_later') {
      const section = document.createElement('div');
      section.className = 'eyh-inline-section';
      section.textContent = '나중에 볼 동영상 정리';
      panel.appendChild(section);
      autoCleanup = checkbox(Boolean(state.values[AUTO_KEY]));
      cleanupPct = numberInput(state.values.watchLaterCleanupMinProgressPct || 60, 1, 100);
      panel.append(field('자동 안전 정리', autoCleanup), field('정리 기준 (%)', cleanupPct));
    }

    const actions = document.createElement('div');
    actions.className = 'eyh-inline-actions';
    if (state.key === 'watch_later') {
      const cleanNow = document.createElement('button');
      cleanNow.type = 'button';
      cleanNow.textContent = '지금 안전 정리';
      cleanNow.addEventListener('click', () => {
        closePanel();
        const button = document.querySelector('#eyh-watch-later-safe-cleanup');
        if (button && !button.disabled) button.click();
        else setStatus('안전 정리 버튼을 준비 중입니다. 잠시 후 다시 눌러주세요.');
      });
      actions.appendChild(cleanNow);
      const undo = document.querySelector('#eyh-watch-later-safe-undo');
      if (undo && !undo.hidden) {
        const undoNow = document.createElement('button');
        undoNow.type = 'button';
        undoNow.textContent = '마지막 정리 되돌리기';
        undoNow.addEventListener('click', () => { closePanel(); undo.click(); });
        actions.appendChild(undoNow);
      }
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '공통 기본값 사용';
    reset.addEventListener('click', async () => {
      const latest = await readState();
      const profiles = { ...latest.profiles };
      delete profiles[latest.key];
      await chrome.storage.local.set({ watchedSurfaceProfiles: profiles });
      closePanel();
      setStatus(`${LABELS[latest.key] || '현재 페이지'}: 공통 기본값으로 전환`);
      scheduleRenderRetries();
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '취소';
    cancel.addEventListener('click', closePanel);

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = '적용';
    save.className = 'primary';
    save.addEventListener('click', async () => {
      const latest = await readState();
      if (latest.key !== state.key) { closePanel(); return; }
      const profile = normalizeProfile({
        dimEnabled: dim.checked,
        hideEnabled: hide.checked,
        linkedThresholds: linked.checked,
        sharedThreshold: shared.value,
        dimThreshold: dimPct.value,
        hideThreshold: hidePct.value
      });
      const patch = { watchedSurfaceProfiles: { ...latest.profiles, [state.key]: profile } };
      if (state.key === 'watch_later') {
        patch[AUTO_KEY] = Boolean(autoCleanup.checked);
        patch.watchLaterCleanupMinProgressPct = Math.max(1, Math.min(100, Number(cleanupPct.value) || 60));
      }
      await chrome.storage.local.set(patch);
      closePanel();
      setStatus(`${LABELS[state.key] || '현재 페이지'} 설정 적용됨`);
      scheduleRenderRetries();
    });

    actions.append(reset, cancel, save);
    panel.appendChild(actions);
    document.body.appendChild(panel);
  }

  async function render() {
    renderQueued = false;
    const root = document.querySelector('#eyh-header-controls');
    if (!root) return;
    const key = surfaceKey();
    if (key === 'shorts') {
      root.querySelector(`#${GEAR_ID}`)?.remove();
      root.querySelector(`#${AUTO_BUTTON_ID}`)?.remove();
      closePanel();
      return;
    }

    let gear = root.querySelector(`#${GEAR_ID}`);
    if (!gear) {
      gear = document.createElement('button');
      gear.type = 'button';
      gear.id = GEAR_ID;
      gear.className = 'eyh-header-button eyh-surface-compact';
      gear.textContent = '⚙';
      gear.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        openPanel().catch(error => setStatus(`설정 열기 실패: ${error.message}`, 'error'));
      }, true);
      root.insertBefore(gear, root.querySelector('#eyh-header-status'));
    }
    const state = await readState().catch(() => null);
    if (!state || state.key !== surfaceKey()) return;
    const effective = state.profile.linkedThresholds ? state.profile.sharedThreshold
      : Math.max(state.profile.dimEnabled ? state.profile.dimThreshold : 0,
                 state.profile.hideEnabled ? state.profile.hideThreshold : 0);
    gear.title = `${LABELS[state.key] || LABELS.other} 설정 · ${state.hasOverride ? '개별 설정' : '공통 기본값'} · 기준 ${effective}%`;
    gear.setAttribute('aria-label', gear.title);

    let autoButton = root.querySelector(`#${AUTO_BUTTON_ID}`);
    if (!isWatchLaterPage()) {
      autoButton?.remove();
      return;
    }
    if (!autoButton) {
      autoButton = document.createElement('button');
      autoButton.type = 'button';
      autoButton.id = AUTO_BUTTON_ID;
      autoButton.className = 'eyh-header-button';
      autoButton.addEventListener('click', async event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!extensionAlive()) {
          offerReloadForStaleContext();
          return;
        }
        const current = await chrome.storage.local.get({ [AUTO_KEY]: false });
        const enabled = !Boolean(current[AUTO_KEY]);
        await chrome.storage.local.set({ [AUTO_KEY]: enabled });
        setStatus(enabled ? 'Watch Later 자동 안전 정리 켜짐' : '자동 안전 정리 꺼짐');
        scheduleRender();
      }, true);
    }
    const cleanup = root.querySelector('#eyh-watch-later-safe-cleanup');
    const undo = root.querySelector('#eyh-watch-later-safe-undo');
    const status = root.querySelector('#eyh-header-status');
    const before = cleanup || undo || status;
    if (autoButton.parentElement !== root || (before && autoButton.nextSibling !== before)) {
      root.insertBefore(autoButton, before || null);
    }
    const enabled = Boolean(state.values[AUTO_KEY]);
    autoButton.textContent = enabled ? '자동✓' : '자동';
    autoButton.classList.toggle('eyh-active', enabled);
    autoButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    autoButton.title = enabled ? 'Watch Later 자동 안전 정리 켜짐' : 'Watch Later 자동 안전 정리 켜기';
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => render().catch(() => { renderQueued = false; }));
  }

  function scheduleRenderRetries() {
    for (const delay of RETRY_DELAYS) setTimeout(scheduleRender, delay);
  }

  if (!extensionAlive()) return;
  window.addEventListener('yt-navigate-finish', () => { closePanel(); scheduleRenderRetries(); }, true);
  window.addEventListener('popstate', () => { closePanel(); scheduleRenderRetries(); }, true);
  document.addEventListener('click', event => {
    const panel = document.getElementById(PANEL_ID);
    if (panel && !panel.contains(event.target) && !event.target?.closest?.(`#${GEAR_ID}`)) closePanel();
  }, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.watchedSurfaceProfiles || changes.watchedSurfaceDefaultProfile
        || changes.watchLaterCleanupMinProgressPct || changes[AUTO_KEY]) scheduleRender();
  });
  scheduleRenderRetries();
})();