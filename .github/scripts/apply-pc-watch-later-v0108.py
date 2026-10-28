from pathlib import Path


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {n}')
    return text.replace(old, new, 1)

# manifest: safe transaction coordinator becomes resident, legacy delete bridge remains separately blocked.
p = 'pc-extension/src/manifest.json'
s = read(p)
s = once(s, '"version": "0.10.7"', '"version": "0.10.8"', 'manifest version')
s = once(s,
'''        "watch-later-core.js",\n        "content.js",\n        "pc-stability-controller.js",\n        "watch-later-recovery-content.js",''',
'''        "watch-later-core.js",\n        "watch-later-safe-core.js",\n        "content.js",\n        "pc-stability-controller.js",\n        "watch-later-safe.js",\n        "watch-later-recovery-content.js",''',
'manifest safe coordinator')
write(p, s)

# content renderer: preserve playlist virtualization in hide mode and permanently retire legacy mutation calls.
p = 'pc-extension/src/content.js'
s = read(p)
s = once(s, '  const WL = globalThis.EYHWatchLaterCore;\n',
'''  const WL = globalThis.EYHWatchLaterCore;\n  // Destructive Watch Later writes are owned exclusively by watch-later-safe.js.\n  const LEGACY_WATCH_LATER_MUTATION_DISABLED = true;\n''', 'content legacy safety constant')
s = once(s,
'''        c.classList.toggle('eyh-watched', dimmed); c.classList.toggle('eyh-watched-linked', dimmed && watchedLinkCardInfo);\n        c.classList.toggle('eyh-watched-grayscale', dimmed && watchedThumbnailGrayscale); c.classList.toggle('eyh-hidden', matches && watchedDisplayMode === 'hide');\n''',
'''        c.classList.toggle('eyh-watched', dimmed); c.classList.toggle('eyh-watched-linked', dimmed && watchedLinkCardInfo);\n        c.classList.toggle('eyh-watched-grayscale', dimmed && watchedThumbnailGrayscale);\n        const hidden = matches && watchedDisplayMode === 'hide';\n        // display:none on playlist rows can make YouTube's virtualized Watch Later list stop\n        // materializing continuation rows. Collapse the row instead so the list keeps its DOM\n        // sentinel/continuation machinery while the watched item is effectively invisible.\n        const collapsedWatchLater = hidden && isWatchLaterPage() && c.matches?.('ytd-playlist-video-renderer');\n        c.classList.toggle('eyh-hidden', hidden && !collapsedWatchLater);\n        c.classList.toggle('eyh-watch-later-hidden', Boolean(collapsedWatchLater));\n''', 'content watch later hidden class')
s = once(s,
'''  async function maybeAutoCleanupWatchLaterPage() {\n    if (!watchLaterAutoCleanupEnabled || !isWatchLaterPage()) return;\n''',
'''  async function maybeAutoCleanupWatchLaterPage() {\n    if (LEGACY_WATCH_LATER_MUTATION_DISABLED) return;\n    if (!watchLaterAutoCleanupEnabled || !isWatchLaterPage()) return;\n''', 'content disable legacy full auto')
s = once(s,
'''  async function maybeAutoRemoveCurrentFromWatchLater(videoId, progressPct) {\n    if (!watchLaterAutoCleanupEnabled || !WL) return;''',
'''  async function maybeAutoRemoveCurrentFromWatchLater(videoId, progressPct) {\n    if (LEGACY_WATCH_LATER_MUTATION_DISABLED) return;\n    if (!watchLaterAutoCleanupEnabled || !WL) return;''', 'content disable legacy remove one')
write(p, s)

# CSS: collapsed Watch Later rows remain mounted for YouTube virtualization/continuation.
p = 'pc-extension/src/content.css'
s = read(p)
anchor = '''.eyh-hidden,\n.eyh-surface-hidden {\n  display: none !important;\n}\n'''
insert = anchor + '''\n/* Watch Later is virtualized. Removing every loaded row with display:none can prevent YouTube\n   from materializing the continuation sentinel and leave a blank page. Keep hidden rows mounted\n   as a 1px inert shell instead; other surfaces retain ordinary display:none behavior. */\nytd-playlist-video-renderer.eyh-watch-later-hidden {\n  display: block !important;\n  box-sizing: border-box !important;\n  height: 1px !important;\n  min-height: 1px !important;\n  max-height: 1px !important;\n  margin: 0 !important;\n  padding: 0 !important;\n  border: 0 !important;\n  overflow: hidden !important;\n  visibility: hidden !important;\n  opacity: 0 !important;\n  pointer-events: none !important;\n}\n'''
s = once(s, anchor, insert, 'content css collapsed rows')
write(p, s)

# Stability adapter must no longer overwrite the opt-in safe cleanup preference.
p = 'pc-extension/src/pc-stability-controller.js'
s = read(p)
s = once(s,
'''      watchedSurfaceProfiles: profiles,\n      watchedDisplayMode: effective.mode,\n      watchedMinProgressPct: effective.threshold,\n      watchLaterAutoCleanupEnabled: false\n''',
'''      watchedSurfaceProfiles: profiles,\n      watchedDisplayMode: effective.mode,\n      watchedMinProgressPct: effective.threshold\n''', 'stability mode write')
s = once(s,
'''  // Keep the old destructive/automatic path truly dormant, not merely blocked at its final bridge.\n  chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});\n  chrome.storage.onChanged.addListener((changes, area) => {\n    if (area !== 'local') return;\n    if (changes.watchLaterAutoCleanupEnabled?.newValue === true) {\n      chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});\n    }\n    if (changes.watchedSurfaceProfiles || changes.watchedSurfaceDefaultProfile) {\n''',
'''  // The legacy mutation bridge remains blocked in MAIN world. The separate transactional-safe\n  // coordinator owns the user's Watch Later auto-cleanup preference and must not be overwritten here.\n  chrome.storage.onChanged.addListener((changes, area) => {\n    if (area !== 'local') return;\n    if (changes.watchedSurfaceProfiles || changes.watchedSurfaceDefaultProfile) {\n''', 'stability auto lock removal')
write(p, s)

# Options page: expose the safe auto preference with concise explanation.
p = 'pc-extension/src/options.html'
s = read(p)
s = once(s, '<section><h2>Watch Later 정리 안전 잠금</h2>', '<section><h2>나중에 볼 동영상 정리</h2>', 'options heading')
s = once(s, '<label><input id="watchLaterAutoCleanupEnabled" type="checkbox" disabled> 자동 정리 (현재 안전 잠금)</label>', '<label><input id="watchLaterAutoCleanupEnabled" type="checkbox"> 자동 정리</label>', 'options auto checkbox')
s = once(s,
'''<p class="note">이 안정화 버전에서는 <strong>자동/legacy 삭제 경로를 강제로 꺼 둡니다.</strong> 과거 Watch Later 손실 원인이 완전히 검증되기 전에는 이 설정을 켤 수 없습니다. 복구 기능은 ADD-only이며, YouTube 표시 개수와 strict parser의 전체 membership 개수가 정확히 일치할 때만 후보 비교를 진행합니다.</p>''',
'''<p class="note">기존 삭제 경로는 계속 차단합니다. 정리는 <strong>전체 목록 2회 대조 + 삭제 직전 식별자 재검증 + 영구 journal</strong>을 통과한 안전 경로만 사용하며, 이상이 생기면 즉시 중단합니다. 마지막 정리는 되돌릴 수 있습니다. 자동 정리는 나중에 볼 동영상 페이지가 열려 있을 때 실행됩니다.</p>''', 'options safety note')
write(p, s)

p = 'pc-extension/src/options.js'
s = read(p)
s = once(s, "  $('#watchLaterAutoCleanupEnabled').checked = false;", "  $('#watchLaterAutoCleanupEnabled').checked = Boolean(v.watchLaterAutoCleanupEnabled);", 'options load auto')
s = once(s,
'''    // Automatic/destructive Watch Later cleanup remains safety-locked in the stability release.\n    watchLaterAutoCleanupEnabled: false,\n''',
'''    // Only the transactional-safe coordinator observes this preference; legacy writes stay blocked.\n    watchLaterAutoCleanupEnabled: $('#watchLaterAutoCleanupEnabled').checked,\n''', 'options save auto')
s = once(s, "  $('#watchLaterAutoCleanupEnabled').checked = false;\n  $('#status').textContent = '공통 기본값을 저장했습니다. 기존 페이지별 설정은 유지되며 YouTube의 빠른 표시/흐림/숨김 버튼으로 현재 페이지 설정을 바꿀 수 있습니다.';",
'''  $('#status').textContent = '설정을 저장했습니다. 나중에 볼 자동 정리는 안전 transaction 경로만 사용합니다.';''', 'options post save')
write(p, s)

# Safe coordinator: opt-in automatic runs reuse the exact same fail-closed transaction path.
p = 'pc-extension/src/watch-later-safe.js'
s = read(p)
s = once(s, '  let decorateQueued = false;\n',
'''  let decorateQueued = false;\n  let autoTimer = null;\n  let lastAutoAttemptAt = 0;\n  const AUTO_MIN_INTERVAL_MS = 5 * 60 * 1000;\n''', 'safe auto state')
s = once(s, '  async function runSafeCleanup() {\n', '  async function runSafeCleanup({ automatic = false } = {}) {\n', 'safe cleanup signature')
s = once(s,
'''      if (!confirm(\n        `Eternal 진행률 ${tx.threshold}% 이상인 Watch Later 영상 ${tx.candidates.length}개를 안전 정리할까요?\\n\\n` +\n        `${preview}${more}\\n\\n삭제 전에 전체 Watch Later 스냅샷과 대상 journal을 저장하고, 사용자 확인 뒤 전체 목록을 한 번 더 대조한 다음 각 항목의 현재 식별자를 다시 검증합니다. 마지막 정리는 되돌릴 수 있습니다.`\n      )) {\n        setStatus('안전 정리를 취소했습니다.');\n        return;\n      }\n''',
'''      if (!automatic && !confirm(\n        `Eternal 진행률 ${tx.threshold}% 이상인 Watch Later 영상 ${tx.candidates.length}개를 정리할까요?\\n\\n` +\n        `${preview}${more}\\n\\n삭제 전·후 안전 검증과 복구 기록을 남깁니다.`\n      )) {\n        setStatus('정리를 취소했습니다.');\n        return;\n      }\n''', 'safe confirmation')
s = once(s,
'''    let cleanup = root.querySelector('#eyh-watch-later-safe-cleanup');\n    let undo = root.querySelector('#eyh-watch-later-safe-undo');\n''',
'''    let auto = root.querySelector('#eyh-watch-later-safe-auto');\n    let cleanup = root.querySelector('#eyh-watch-later-safe-cleanup');\n    let undo = root.querySelector('#eyh-watch-later-safe-undo');\n    if (!auto) {\n      auto = document.createElement('button');\n      auto.type = 'button';\n      auto.id = 'eyh-watch-later-safe-auto';\n      auto.className = 'eyh-header-button';\n      auto.addEventListener('click', async event => {\n        event.preventDefault();\n        event.stopImmediatePropagation();\n        const state = await storageGet({ watchLaterAutoCleanupEnabled: false });\n        const enabled = !Boolean(state.watchLaterAutoCleanupEnabled);\n        await storageSet({ watchLaterAutoCleanupEnabled: enabled });\n        setStatus(enabled ? '나중에 볼 자동 정리 켜짐' : '자동 정리 꺼짐');\n        scheduleDecorate();\n        if (enabled) scheduleAutomaticCleanup(700);\n      }, true);\n      root.appendChild(auto);\n    }\n''', 'safe auto button')
s = once(s,
'''    const state = await storageGet({ watchLaterCleanupMinProgressPct: 60, [TX_KEY]: null }).catch(() => null);\n    if (!state) {\n      cleanup.hidden = !page;\n      undo.hidden = true;\n      return;\n    }\n    const min = CORE.threshold(state.watchLaterCleanupMinProgressPct);\n    cleanup.textContent = `${min}%+ 안전 정리`;\n''',
'''    const state = await storageGet({ watchLaterCleanupMinProgressPct: 60, watchLaterAutoCleanupEnabled: false, [TX_KEY]: null }).catch(() => null);\n    if (!state) {\n      auto.hidden = !page;\n      cleanup.hidden = !page;\n      undo.hidden = true;\n      return;\n    }\n    const min = CORE.threshold(state.watchLaterCleanupMinProgressPct);\n    auto.hidden = !page;\n    auto.disabled = busy;\n    auto.textContent = state.watchLaterAutoCleanupEnabled ? '자동✓' : '자동';\n    auto.classList.toggle('eyh-active', Boolean(state.watchLaterAutoCleanupEnabled));\n    auto.title = state.watchLaterAutoCleanupEnabled ? `${min}% 이상 자동 정리 켜짐` : '안전 자동 정리 켜기';\n    cleanup.textContent = `${min}%+ 정리`;\n''', 'safe decorate state')
s = once(s,
'''  function scheduleDecorate() {\n    if (decorateQueued) return;\n    decorateQueued = true;\n    queueMicrotask(() => decorate().catch(() => { decorateQueued = false; }));\n  }\n\n  if (!CORE || !WL) return;\n  // Automatic cleanup remains deliberately disabled in v0.10.5. Only the new explicit transaction\n  // path below can perform a destructive request; legacy remove messages stay blocked in MAIN world.\n  if (extensionAlive()) chrome.storage.local.set({ watchLaterAutoCleanupEnabled: false }).catch(() => {});\n\n  const observer = new MutationObserver(mutations => {\n''',
'''  function scheduleDecorate() {\n    if (decorateQueued) return;\n    decorateQueued = true;\n    queueMicrotask(() => decorate().catch(() => { decorateQueued = false; }));\n  }\n\n  function scheduleAutomaticCleanup(delay = 900) {\n    if (autoTimer) clearTimeout(autoTimer);\n    autoTimer = setTimeout(async () => {\n      autoTimer = null;\n      if (busy || !isWatchLaterPage()) return;\n      const state = await storageGet({ watchLaterAutoCleanupEnabled: false }).catch(() => null);\n      if (!state?.watchLaterAutoCleanupEnabled) return;\n      const now = Date.now();\n      if (now - lastAutoAttemptAt < AUTO_MIN_INTERVAL_MS) return;\n      lastAutoAttemptAt = now;\n      runSafeCleanup({ automatic: true }).catch(error => setStatus(error.message, 'error'));\n    }, delay);\n  }\n\n  if (!CORE || !WL) return;\n  // Legacy remove message names stay blocked in MAIN world. Automatic cleanup, when enabled,\n  // reuses this same strict transaction path rather than the historical content.js mutation path.\n\n  const observer = new MutationObserver(mutations => {\n''', 'safe automatic scheduler')
s = once(s,
'''  window.addEventListener('yt-navigate-finish', scheduleDecorate, true);\n  window.addEventListener('popstate', scheduleDecorate, true);\n  chrome.storage.onChanged.addListener((changes, area) => {\n    if (area === 'local' && (changes.watchLaterCleanupMinProgressPct || changes[TX_KEY])) scheduleDecorate();\n  });\n  setTimeout(scheduleDecorate, 0);\n''',
'''  const onNavigation = () => { scheduleDecorate(); scheduleAutomaticCleanup(); };\n  window.addEventListener('yt-navigate-finish', onNavigation, true);\n  window.addEventListener('popstate', onNavigation, true);\n  chrome.storage.onChanged.addListener((changes, area) => {\n    if (area !== 'local') return;\n    if (changes.watchLaterCleanupMinProgressPct || changes.watchLaterAutoCleanupEnabled || changes[TX_KEY]) scheduleDecorate();\n    if (changes.watchLaterAutoCleanupEnabled?.newValue === true) scheduleAutomaticCleanup(500);\n  });\n  setTimeout(() => { scheduleDecorate(); scheduleAutomaticCleanup(); }, 0);\n''', 'safe events')
write(p, s)

# Tests: lock old mutation bridge, but require the safe coordinator to be resident and preference-enabled.
p = 'pc-extension/src/tests/static-integration-selftest.mjs'
s = read(p)
s = once(s, "assert.equal(manifest.version, '0.10.7', 'stability release must be distinguishable from the regressed builds');",
"assert.equal(manifest.version, '0.10.8', 'Watch Later/UI fix release must be distinguishable from prior builds');", 'static version')
s = once(s, "assert.ok(!isolatedWorld.js.includes('watch-later-safe.js'), 'destructive coordinator UI remains dormant during recovery/stability release');",
"assert.ok(isolatedWorld.js.includes('watch-later-safe-core.js'), 'safe transaction core must load in isolated world');\nassert.ok(isolatedWorld.js.includes('watch-later-safe.js'), 'safe transaction coordinator must be resident');", 'static safe resident')
s = once(s,
'''// Legacy auto cleanup must be dormant both at preference level and at the MAIN-world mutation edge.\nassert.match(content, /watchLaterAutoCleanupEnabled = false/);\nassert.match(options, /watchLaterAutoCleanupEnabled: false/);\nassert.match(stability, /watchLaterAutoCleanupEnabled: false/);\nassert.match(stability, /changes\\.watchLaterAutoCleanupEnabled\\?\\.newValue === true/);\nassert.match(stability, /#eyh-watch-later-auto/);\nassert.match(stability, /#eyh-watch-later-cleanup/);\n''',
'''// Legacy mutation messages remain blocked, while the strict transaction coordinator is the only\n// resident destructive owner and may persist the user's opt-in automatic preference.\nassert.match(content, /LEGACY_WATCH_LATER_MUTATION_DISABLED = true/);\nassert.doesNotMatch(options, /watchLaterAutoCleanupEnabled: false/);\nassert.doesNotMatch(stability, /changes\\.watchLaterAutoCleanupEnabled\\?\\.newValue === true/);\nassert.match(stability, /#eyh-watch-later-auto/);\nassert.match(stability, /#eyh-watch-later-cleanup/);\nassert.match(safeCoordinator, /EYH_WL_SAFE_REMOVE_REQUEST/);\nassert.match(safeCoordinator, /scheduleAutomaticCleanup/);\n''', 'static auto assertions')
s = once(s, "assert.doesNotMatch(safeCoordinator, /requestPage\\('EYH_WL_REMOVE_REQUEST'/);\nassert.doesNotMatch(safeCoordinator, /requestPage\\('EYH_WL_REMOVE_ONE_REQUEST'/);",
"assert.doesNotMatch(safeCoordinator, /requestPage\\('EYH_WL_REMOVE_REQUEST'/);\nassert.doesNotMatch(safeCoordinator, /requestPage\\('EYH_WL_REMOVE_ONE_REQUEST'/);\nassert.match(content, /eyh-watch-later-hidden/);", 'static legacy block')
write(p, s)

p = 'pc-extension/src/tests/page-profile-regression-selftest.mjs'
s = read(p)
s = once(s, "assert.ok(!isolated.js.includes('watch-later-safe.js'));", "assert.ok(isolated.js.includes('watch-later-safe-core.js'));\nassert.ok(isolated.js.includes('watch-later-safe.js'));", 'profile safe resident')
s = once(s, '// A direct 0.9.x -> 0.10.7 upgrade snapshots the legacy default before any page override is stored.', '// A direct 0.9.x -> 0.10.8 upgrade snapshots the legacy default before any page override is stored.', 'profile version comment')
s = once(s, "assert.match(options, /watchLaterAutoCleanupEnabled: false/);\nassert.match(optionsHtml, /자동 정리 \\(현재 안전 잠금\\)/);",
"assert.match(options, /watchLaterAutoCleanupEnabled: \\$('#watchLaterAutoCleanupEnabled'\\)\\.checked/);\nassert.doesNotMatch(optionsHtml, /현재 안전 잠금/);\nassert.match(content, /eyh-watch-later-hidden/);", 'profile auto assertions')
write(p, s)

print('PASS guarded PC v0.10.8 rewrite')
