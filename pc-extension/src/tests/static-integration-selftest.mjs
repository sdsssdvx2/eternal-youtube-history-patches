import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './watch-later-safe-transaction-selftest.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const text = name => fs.readFileSync(path.join(src, name), 'utf8');
const manifest = JSON.parse(text('manifest.json'));
const backgroundEntry = text('background-entry.js');
const updateReconnect = text('pc-update-reconnect.js');
const content = text('content.js');
const css = text('content.css');
const stability = text('pc-stability-controller.js');
const inlineControls = text('pc-inline-controls.js');
const spaLifecycle = text('pc-spa-lifecycle.js');
const surface = text('surface-profiles.js');
const hotfix = text('pc-ui-hotfix.js');
const safety = text('watch-later-safety-main.js');
const safeCore = text('watch-later-safe-core.js');
const safeMain = text('watch-later-safe-main.js');
const safeCoordinator = text('watch-later-safe.js');
const safeAuto = text('watch-later-safe-auto.js');
const bridge = text('page-bridge.js');
const core = text('watch-later-core.js');
const recoveryContent = text('watch-later-recovery-content.js');
const options = text('options.js');
const optionsHtml = text('options.html');
const maintenance = text('maintenance.js');
const popup = text('popup.js');
const popupHtml = text('popup.html');

assert.equal(manifest.version, '0.10.16', 'display-cache preservation release must have a distinct version');
assert.equal(manifest.background?.service_worker, 'background-entry.js', 'background wrapper must run reconnect logic as well as the canonical worker');
assert.match(backgroundEntry, /import '\.\/background\.js'/);
assert.match(backgroundEntry, /import '\.\/pc-update-reconnect\.js'/);
assert.match(updateReconnect, /details\?\.reason !== 'update'/);
assert.match(updateReconnect, /chrome\.storage\.session/);
assert.match(updateReconnect, /chrome\.tabs\.reload/);
assert.match(updateReconnect, /chrome\.tabs\.onActivated/);
const mainWorld = manifest.content_scripts.find(cs => cs.world === 'MAIN');
const isolatedWorld = manifest.content_scripts.find(cs => cs.world === 'ISOLATED');
assert.ok(mainWorld && isolatedWorld, 'both MAIN and ISOLATED content-script worlds are required');
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js', 'legacy destructive safety boundary must load first in MAIN world');
assert.ok(mainWorld.js.indexOf('watch-later-core.js') < mainWorld.js.indexOf('watch-later-safe-core.js'), 'Watch Later parser must precede safe core in MAIN world');
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'), 'safe core must precede safe write bridge');
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'), 'safe bridge must be isolated from the legacy page bridge');
assert.equal(isolatedWorld.js[0], 'watch-later-core.js', 'Watch Later parser must load first in ISOLATED world');
assert.ok(isolatedWorld.js.indexOf('watch-later-core.js') < isolatedWorld.js.indexOf('watch-later-safe-core.js'), 'safe transaction core must load before isolated coordinators');
assert.ok(isolatedWorld.js.includes('content.js'), 'legacy content.js must remain the sole card renderer');
assert.ok(isolatedWorld.js.includes('pc-stability-controller.js'), 'lightweight stability/profile adapter must load');
assert.ok(isolatedWorld.js.includes('watch-later-safe.js'), 'manual safe Watch Later coordinator must be resident');
assert.ok(isolatedWorld.js.includes('watch-later-safe-auto.js'), 'automatic safe Watch Later coordinator must be resident');
assert.ok(isolatedWorld.js.includes('pc-inline-controls.js'), 'lightweight inline settings/Watch Later UI must be resident');
assert.ok(isolatedWorld.js.includes('pc-spa-lifecycle.js'), 'bounded SPA lifecycle reconciler must be resident');
assert.ok(isolatedWorld.js.indexOf('watch-later-safe-auto.js') < isolatedWorld.js.indexOf('pc-inline-controls.js'), 'inline UI must load after safe cleanup coordinators');
assert.ok(isolatedWorld.js.indexOf('pc-inline-controls.js') < isolatedWorld.js.indexOf('pc-spa-lifecycle.js'), 'SPA reconciler must load after the UI listeners it refreshes');
assert.ok(isolatedWorld.js.includes('watch-later-recovery-content.js'), 'ADD-only Watch Later recovery bridge must load');
assert.ok(isolatedWorld.js.includes('maintenance.js'), 'maintenance must load in isolated YouTube pages');
assert.ok(!isolatedWorld.js.includes('surface-profiles.js'), 'second card renderer must not load');
assert.ok(!isolatedWorld.js.includes('pc-ui-hotfix.js'), 'whole-document hotfix observer must not load');

assert.match(content, /async function scanAndMark\(\)/);
assert.match(content, /classList\.toggle\('eyh-watched'/);
assert.match(content, /classList\.toggle\('eyh-hidden'/);
assert.match(content, /const observer = new MutationObserver/);
assert.doesNotMatch(stability, /MutationObserver/);
assert.doesNotMatch(stability, /querySelectorAll\('a\[href\*=/);
assert.doesNotMatch(stability, /eyh-surface-watched/);
assert.doesNotMatch(stability, /eyh-surface-hidden/);
assert.match(stability, /content\.js is the sole card renderer/);
assert.doesNotMatch(inlineControls, /MutationObserver/);
assert.doesNotMatch(inlineControls, /querySelectorAll\('a\[href|classList\.toggle\('eyh-(?:watched|hidden|surface)/,
  'inline UI must never become another video-card renderer');

// v0.10.14 keeps the one renderer but stops waking it for unrelated YouTube DOM churn. The direct
// watch threshold is cached once/settings-change only, and old video listeners are abortable.
assert.match(content, /const VIDEO_ANCHOR_SELECTOR/);
assert.match(content, /function nodeMatchesOrContains\(/);
assert.match(content, /if \(!needsScan && nodeMatchesOrContains\(node, VIDEO_ANCHOR_SELECTOR\)\) needsScan = true/);
assert.match(content, /if \(needsScan\) scheduleScan\(\)/);
assert.match(content, /let directWatchSeconds = 5/);
assert.match(content, /directWatchSeconds = Math\.max\(1, Math\.min\(120/);
assert.doesNotMatch(content, /await chrome\.storage\.local\.get\(\{\s*directWatchSeconds/,
  'timeupdate path must never perform storage IPC for directWatchSeconds');
assert.match(content, /videoWatcherAbort = new AbortController\(\)/);
assert.match(content, /\{ passive: true, signal \}/);

// v0.10.15 keeps the missed-SPA fallback O(1), halves its visible wake rate, and stops it entirely
// while the tab is hidden. visibilitychange reconciles immediately before polling resumes.
assert.match(spaLifecycle, /HEARTBEAT_MS = 1000/);
assert.match(spaLifecycle, /location\.pathname/);
assert.match(spaLifecycle, /location\.search/);
assert.match(spaLifecycle, /document\.getElementById\('eyh-header-controls'\)/);
assert.match(spaLifecycle, /window\.dispatchEvent\(new Event\('yt-navigate-finish'\)\)/);
assert.match(spaLifecycle, /document\.visibilityState !== 'visible'/);
assert.match(spaLifecycle, /function stopHeartbeat\(\)/);
assert.match(spaLifecycle, /setTimeout\(\(\) => \{[\s\S]*?reconcile\(false\);[\s\S]*?scheduleHeartbeat\(\);[\s\S]*?\}, HEARTBEAT_MS\)/);
assert.doesNotMatch(spaLifecycle, /setInterval|MutationObserver|querySelectorAll|ytd-|yt-lockup|chrome\.storage/,
  'SPA lifecycle reconciler must stay O(1), hidden-tab idle, and must not scan cards or mutate settings');

// v0.10.16 treats display/policy changes as local repaint only. A quick mode click must not flush
// the warm ledger caches and cause CHECK_WATCHED to be reissued for every card. True ledger changes
// (active sync imports and explicit RESCAN) keep their existing cache invalidation paths.
const settingsListener = content.match(/chrome\.storage\.onChanged\.addListener\(\(changes, area\) => \{([\s\S]*?)\n  \}\);\n\n  const observer/)?.[1] || '';
assert.ok(settingsListener, 'storage settings listener must be present');
assert.doesNotMatch(settingsListener, /watchedCache\.clear\(\)|progressCache\.clear\(\)/,
  'display-only storage changes must preserve the ledger caches');
assert.match(settingsListener, /loadDisplaySettings\(\)\.then\(\(\) => scheduleScan\(\)\)/,
  'display-only storage changes should repaint locally');
assert.match(content, /if \(Number\(result\?\.pulled\?\.imported \|\| 0\) > 0\) \{[\s\S]*?watchedCache\.clear\(\);[\s\S]*?progressCache\.clear\(\)/,
  'real server imports must still invalidate cached ledger state');
assert.match(content, /msg\?\.type === 'RESCAN'[\s\S]*?watchedCache\.clear\(\); progressCache\.clear\(\)/,
  'explicit RESCAN must retain hard invalidation semantics');

assert.doesNotMatch(css, /\.eyh-hidden\s*,\s*\n\.eyh-surface-hidden\s*\{\s*\n\s*display:\s*none/i);
assert.match(css, /ytd-playlist-video-renderer\.eyh-hidden/);
assert.match(css, /yt-lockup-view-model\.eyh-hidden/);
assert.match(css, /Unknown markup\s+now fails open/i);

assert.match(content, /\['none','표시'\]/);
assert.match(content, /\['dim','흐림'\]/);
assert.match(content, /\['hide','숨김'\]/);
assert.match(stability, /PROFILE_ACTIVE_CLASS = 'eyh-profile-active'/);
assert.match(stability, /document\.documentElement\.dataset\.eyhProfileController = '1'/);
assert.match(stability, /button\.classList\.toggle\(PROFILE_ACTIVE_CLASS, active\)/);
assert.match(css, /data-eyh-profile-controller="1"[\s\S]*button\[data-eyh-mode\]\.eyh-active/);
assert.match(css, /button\[data-eyh-mode\]\.eyh-profile-active/);
assert.match(stability, /quickModeSeqBySurface/);
assert.match(stability, /pendingModeBySurface/);
assert.match(stability, /resolvedModeBySurface/,
  'resolved profile mode must survive until a late masthead mount can paint it');
assert.match(stability, /pending\?\.mode \|\| resolvedModeBySurface\.get\(key\)/,
  'a physical pending click must win while late masthead decoration replays state');
assert.match(stability, /resolvedModeBySurface\.set\(key, effective\.mode\)/);
assert.match(stability, /chooseCurrentSurfaceMode/);
assert.match(stability, /persistCurrentSurfaceMode/);
assert.match(stability, /watchedSurfaceProfiles: profiles/);
assert.doesNotMatch(stability, /chrome\.storage\.local\.set\(\{\s*watchedDisplayMode: mode,\s*watchLaterAutoCleanupEnabled: false\s*\}\)/,
  'quick mode must not perform the old preliminary storage write before canonical profile persistence');
assert.match(stability, /decorationTimers/);
assert.match(stability, /for \(const timer of decorationTimers\) clearTimeout\(timer\)/);
assert.match(inlineControls, /renderRetryTimers/);
assert.match(inlineControls, /for \(const timer of renderRetryTimers\) clearTimeout\(timer\)/);
assert.match(stability, /chrome\.storage\.local\.get\(\{ watchLaterAutoCleanupEnabled: false \}\)/,
  'legacy unsafe auto key must be checked before migration write');
assert.doesNotMatch(stability, /quickModeGeneration|quickModeWrite/,
  'navigation generations or serialized promise chains must not cancel a physical quick-mode click');

assert.match(stability, /root\.querySelector\('#eyh-surface-settings'\)\?\.remove\(\)/);
assert.match(stability, /document\.querySelector\('#eyh-surface-panel'\)\?\.remove\(\)/);
assert.match(inlineControls, /PANEL_ID = 'eyh-inline-settings-panel'/);
assert.match(inlineControls, /GEAR_ID = 'eyh-inline-settings'/);
assert.match(inlineControls, /INSTANCE_TOKEN = crypto\.randomUUID\(\)/);
assert.match(inlineControls, /gear\.dataset\.eyhInstance = INSTANCE_TOKEN/);
assert.match(inlineControls, /gear\.dataset\.eyhInstance !== INSTANCE_TOKEN/);
assert.match(inlineControls, /routeIdentity/);
assert.match(inlineControls, /panelRoute/);
assert.match(inlineControls, /document\.documentElement\.appendChild\(panel\)/);
assert.match(inlineControls, /document\.addEventListener\('click',[\s\S]*?#\$\{GEAR_ID\}[\s\S]*?stopImmediatePropagation\(\)/,
  'gear action must be delegated at document capture level');
assert.match(inlineControls, /#\$\{AUTO_BUTTON_ID\}/);
assert.match(inlineControls, /toggleSafeAuto/);
assert.match(inlineControls, /watchedSurfaceProfiles/);
assert.match(inlineControls, /watchedSurfaceDefaultProfile/);
assert.match(inlineControls, /공통 기본값 사용/);
assert.match(inlineControls, /지금 안전 정리/);
assert.match(inlineControls, /#eyh-watch-later-safe-cleanup/);
assert.match(inlineControls, /watchLaterSafeAutoCleanupEnabled/);
assert.match(inlineControls, /AUTO_BUTTON_ID = 'eyh-watch-later-safe-auto'/);
assert.match(inlineControls, /offerReloadForStaleContext/);
assert.match(inlineControls, /confirm\(/);
assert.match(inlineControls, /location\.reload\(\)/);
assert.match(inlineControls, /이 YouTube 탭만 새로고침/);
assert.match(stability, /path\.startsWith\('\/shorts\/'\)/);
assert.match(stability, /root\.style\.display = shorts \? 'none' : ''/);
assert.match(inlineControls, /path\.startsWith\('\/shorts\/'\)/);
assert.match(inlineControls, /if \(key === 'shorts'\)/);
const shortsBlock = stability.match(/if \(key === 'shorts'\) \{([\s\S]*?)\n    \}/)?.[1] || '';
assert.doesNotMatch(shortsBlock, /chrome\.storage\.local\.(?:set|get)|watchedDisplayMode|watchedMinProgressPct/,
  'Shorts must hide UI without mutating renderer/default storage');
assert.match(stability, /watchedSurfaceDefaultProfile: defaults/,
  'direct stable-line upgrades must snapshot the legacy default before page overrides');

assert.match(content, /watchLaterAutoCleanupEnabled = false/);
assert.match(stability, /watchLaterAutoCleanupEnabled: false/);
assert.match(stability, /changes\.watchLaterAutoCleanupEnabled\?\.newValue === true/);
assert.match(stability, /#eyh-watch-later-auto/);
assert.match(stability, /#eyh-watch-later-cleanup/);
assert.match(css, /#eyh-watch-later-auto[\s\S]*#eyh-watch-later-cleanup[\s\S]*display:\s*none\s*!important/);
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\(\)/);
assert.match(safety, /blocked-by-safety-lock/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_REQUEST'/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_ONE_REQUEST'/);
assert.doesNotMatch(safeAuto, /EYH_WL_REMOVE_REQUEST|EYH_WL_REMOVE_ONE_REQUEST/);

assert.match(safeCoordinator, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(safeCoordinator, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.match(safeAuto, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(safeAuto, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.match(safeAuto, /watchLaterSafeAutoCleanupEnabled/);
assert.match(options, /watchLaterSafeAutoCleanupEnabled/);
assert.doesNotMatch(optionsHtml, /watchLaterAutoCleanupEnabled" type="checkbox" disabled/);
assert.doesNotMatch(optionsHtml, /안전 잠금/);
assert.match(optionsHtml, /자동 안전 정리/);
assert.match(safeMain, /strictListWatchLater/);
assert.match(safeMain, /SAFE\.paginationDecision/);
assert.match(safeCore, /continuation이 반복/);
assert.match(safeCore, /continuation 후보가 둘 이상/);
assert.match(safeCore, /continuation은 남았지만 새 항목이 없어/);
assert.match(safeCore, /안전 페이지 한도/);

const persistBeforeSecondSnapshot = safeCoordinator.indexOf('let durable = await persistVerified(tx)');
const secondSnapshot = safeCoordinator.indexOf('revalidatePreparedSnapshot(durable)');
const enteringRemoving = safeCoordinator.indexOf("durable.state = 'removing'");
assert.ok(persistBeforeSecondSnapshot >= 0 && secondSnapshot > persistBeforeSecondSnapshot && enteringRemoving > secondSnapshot,
  'manual cleanup must persist journal and verify a second full snapshot before removing state');
const firstAttempting = safeCoordinator.indexOf("candidate.status = 'attempting'");
const persistAttempting = safeCoordinator.indexOf('durable = await persistVerified(durable)', firstAttempting);
const firstSafeRemove = safeCoordinator.indexOf("requestPage('EYH_WL_SAFE_REMOVE_REQUEST'");
assert.ok(firstAttempting >= 0 && persistAttempting > firstAttempting && firstSafeRemove > persistAttempting,
  'manual cleanup must durably persist attempting before every destructive request');

const autoPersist = safeAuto.indexOf('let durable = await persistVerified(tx)');
const autoSecondSnapshot = safeAuto.indexOf('revalidateSnapshot(durable)');
const autoRemoving = safeAuto.indexOf("durable.state = 'removing'");
assert.ok(autoPersist >= 0 && autoSecondSnapshot > autoPersist && autoRemoving > autoSecondSnapshot,
  'automatic cleanup must persist journal and verify a second full snapshot before removing state');
const autoAttempting = safeAuto.indexOf("candidate.status = 'attempting'");
const autoAttemptPersist = safeAuto.indexOf('durable = await persistVerified(durable)', autoAttempting);
const autoSafeRemove = safeAuto.indexOf("requestPage('EYH_WL_SAFE_REMOVE_REQUEST'");
assert.ok(autoAttempting >= 0 && autoAttemptPersist > autoAttempting && autoSafeRemove > autoAttemptPersist,
  'automatic cleanup must durably persist attempting before every destructive request');

for (const coordinator of [safeCoordinator, safeAuto]) {
  assert.match(coordinator, /function requireDeclaredCoverage\(parsedCount, expectedDeclared = null\)/);
  assert.match(coordinator, /if \(declared < parsedCount\)/);
  assert.match(coordinator, /declared - parsedCount/);
  assert.match(coordinator, /coverage\.unparsed !== Number\(tx\.unparsedCount \|\| 0\)/);
  assert.match(coordinator, /CORE\.sameSnapshotMembership/);
}
assert.match(safeAuto, /archivePreviousTransaction/);
assert.match(safeAuto, /미완료 정리 복구 기록/);

const freshResolve = safeMain.indexOf('const fresh = await resolveEntry(id)');
const exactCompare = safeMain.indexOf('fresh.setVideoId !== expected');
const destructiveAction = safeMain.indexOf("action: 'ACTION_REMOVE_VIDEO'");
assert.ok(freshResolve >= 0 && exactCompare > freshResolve && destructiveAction > exactCompare,
  'fresh videoId/setVideoId revalidation must precede ACTION_REMOVE_VIDEO');
assert.match(safeMain, /ACTION_ADD_VIDEO/);
assert.match(safeMain, /already_present/);

assert.match(core, /'lockupViewModel'/);
assert.match(core, /collectItemIds/);
assert.match(recoveryContent, /declared !== entries\.length/);
assert.match(recoveryContent, /unparsedCount: 0/);
assert.doesNotMatch(recoveryContent, /declared < entries\.length/);

assert.match(content, /GET_PAGE_DIAGNOSTICS/);
assert.match(maintenance, /EYH_REQUEST_HISTORY/);
assert.match(maintenance, /document\.visibilityState !== 'visible'/);
assert.match(core, /ACTION_REMOVE_VIDEO/);
assert.match(bridge, /setVideoId/);
assert.match(popupHtml, /id="watchLaterSafety"/);
assert.match(popup, /eyhLastAutoWatchLaterSweep/);

for (const id of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(optionsHtml.includes(`id="${id}"`), `missing default profile control ${id}`);
assert.match(options, /watchedSurfaceDefaultProfile: defaultProfile/);
assert.match(options, /watchedDisplayMode: presentation\.mode/);
assert.match(stability, /watchedSurfaceDefaultProfile/);
assert.match(stability, /effectivePresentation/);

assert.match(surface, /MutationObserver/);
assert.match(hotfix, /MutationObserver/);
assert.ok(!isolatedWorld.js.includes('surface-profiles.js'));
assert.ok(!isolatedWorld.js.includes('pc-ui-hotfix.js'));

console.log('PASS pc v0.10.16 startup-pinned + hidden-tab-idle + warm display-cache + reduced hot-path IPC/DOM churn + safe Watch Later integration self-test');
