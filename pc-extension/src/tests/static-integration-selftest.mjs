import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const text = name => fs.readFileSync(path.join(src, name), 'utf8');
const manifest = JSON.parse(text('manifest.json'));
const content = text('content.js');
const surface = text('surface-profiles.js');
const hotfix = text('pc-ui-hotfix.js');
const safety = text('watch-later-safety-main.js');
const safeCore = text('watch-later-safe-core.js');
const safeMain = text('watch-later-safe-main.js');
const safeCoordinator = text('watch-later-safe.js');
const css = text('content.css');
const bridge = text('page-bridge.js');
const core = text('watch-later-core.js');
const options = text('options.js');
const optionsHtml = text('options.html');
const maintenance = text('maintenance.js');
const popup = text('popup.js');
const popupHtml = text('popup.html');

assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'manifest version must be release semver');
const mainWorld = manifest.content_scripts.find(cs => cs.world === 'MAIN');
const isolatedWorld = manifest.content_scripts.find(cs => cs.world === 'ISOLATED');
assert.ok(mainWorld && isolatedWorld, 'both MAIN and ISOLATED content-script worlds are required');
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js', 'legacy destructive safety boundary must load first in MAIN world');
assert.ok(mainWorld.js.indexOf('watch-later-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'), 'Watch Later core must precede safe write bridge');
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'), 'safe bridge must be isolated from the legacy page bridge');
assert.equal(isolatedWorld.js[0], 'watch-later-core.js', 'core must load first in ISOLATED world');
assert.ok(isolatedWorld.js.indexOf('watch-later-safe-core.js') < isolatedWorld.js.indexOf('watch-later-safe.js'), 'safe transaction core must precede coordinator');
assert.ok(isolatedWorld.js.includes('maintenance.js'), 'maintenance must load in isolated YouTube pages');
assert.ok(isolatedWorld.js.includes('surface-profiles.js'), 'page-profile renderer must load in isolated YouTube pages');
assert.ok(isolatedWorld.js.includes('pc-ui-hotfix.js'), 'PC UI/safety hotfix must load in isolated YouTube pages');
assert.ok(isolatedWorld.js.includes('watch-later-safe.js'), 'transactional Watch Later coordinator must load');
assert.match(content, /watchLaterAutoCleanupEnabled = false/);
assert.match(content, /watchLaterCleanupMinProgressPct = 60/);
assert.match(options, /watchLaterAutoCleanupEnabled: false/);
assert.match(options, /watchLaterCleanupMinProgressPct: 60/);
assert.match(core, /ACTION_REMOVE_VIDEO/);
assert.match(bridge, /setVideoId/);
assert.match(bridge, /verification/);
assert.match(bridge, /setTimeout\(r,500\)/);
assert.doesNotMatch(core + bridge, /ACTION_REMOVE_VIDEO_BY_VIDEO_ID/);
assert.match(content, /pct == null \|\| pct < watchLaterCleanupMinProgressPct/);
assert.match(content, /confirm\(`/);
assert.match(content, /#eyh-header-controls/);
assert.match(content, /GET_PAGE_DIAGNOSTICS/);
assert.match(maintenance, /EYH_REQUEST_HISTORY/);
assert.match(maintenance, /EYH_WL_LIST_REQUEST/);
assert.match(maintenance, /EYH_WL_REMOVE_REQUEST/);
assert.match(maintenance, /document\.visibilityState !== 'visible'/);
assert.match(maintenance, /HISTORY_INTERVAL_MS = 60 \* 60 \* 1000/);
assert.match(maintenance, /WATCH_LATER_INTERVAL_MS = 30 \* 60 \* 1000/);

// Legacy pre-v0.10.3 destructive message names stay permanently blocked. The new coordinator must
// never reopen them, so stale content scripts in old tabs cannot gain a delete path after an update.
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\(\)/);
assert.match(safety, /blocked-by-safety-lock/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_REQUEST'/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_ONE_REQUEST'/);
assert.match(hotfix, /watchLaterAutoCleanupEnabled: false/);
assert.match(hotfix, /button\.disabled = true/);
assert.match(safeCoordinator, /watchLaterAutoCleanupEnabled: false/);

// Transactional v0.10.4 path: complete snapshot, durable read-back verified journal, then one-item
// writes only. No destructive request may be issued before persistVerified(tx).
assert.match(safeCore, /MAX_SNAPSHOT_ENTRIES = 5000/);
assert.match(safeCore, /if \(hasMore\) throw new Error/);
assert.match(safeCore, /status: 'prepared'/);
assert.match(safeCoordinator, /YouTube 표시 개수 .*안전 파서/);
assert.match(safeCoordinator, /const recomputed = await sha256Hex\(CORE\.canonicalForDigest\(check\)\)/);
const persistBeforeDelete = safeCoordinator.indexOf('let durable = await persistVerified(tx)');
const firstSafeRemove = safeCoordinator.indexOf("requestPage('EYH_WL_SAFE_REMOVE_REQUEST'");
assert.ok(persistBeforeDelete >= 0 && firstSafeRemove > persistBeforeDelete, 'journal must be durably verified before first delete');
assert.match(safeCoordinator, /The next delete is forbidden until the result of this one is durably re-read and verified/);
assert.match(safeCoordinator, /durable = await persistVerified\(durable\)/);
assert.match(safeCoordinator, /EYH_WL_SAFE_ADD_REQUEST/);
assert.match(safeCoordinator, /마지막 정리 되돌리기/);

// MAIN-world safe remove must resolve current membership immediately before delete and require the
// fresh tuple to equal the snapshot tuple. Restore must use YouTube's idempotent add primitive and
// verify membership afterwards.
const freshResolve = safeMain.indexOf('const fresh = await resolveEntry(id)');
const exactCompare = safeMain.indexOf('fresh.setVideoId !== expected');
const destructiveAction = safeMain.indexOf("action: 'ACTION_REMOVE_VIDEO'");
assert.ok(freshResolve >= 0 && exactCompare > freshResolve && destructiveAction > exactCompare,
  'fresh videoId/setVideoId revalidation must precede ACTION_REMOVE_VIDEO');
assert.match(safeMain, /ACTION_ADD_VIDEO/);
assert.match(safeMain, /addedVideoId: id/);
assert.match(safeMain, /already_present/);
assert.match(safeMain, /journalDigest/);
assert.match(safeMain, /EYH_WL_SAFE_RESULT/);

// Users must be able to tell whether PC background cleanup previously ran without opening devtools.
assert.match(popupHtml, /id="watchLaterSafety"/);
assert.match(popup, /eyhLastAutoWatchLaterSweep/);
assert.match(popup, /최근 PC 자동 정리/);
assert.match(popup, /현재 자동 설정/);

// Page-profile presentation must never share the legacy renderer's toggle classes. v0.10.0 did,
// so the two scanners alternately added/removed the same classes and produced visible flicker.
assert.match(surface, /eyh-surface-watched/);
assert.match(surface, /eyh-surface-hidden/);
assert.doesNotMatch(surface, /classList\.toggle\('eyh-watched'/);
assert.doesNotMatch(surface, /classList\.toggle\('eyh-hidden'/);
assert.match(css, /\.eyh-surface-watched/);
assert.match(css, /\.eyh-surface-hidden/);
assert.match(surface, /scanGeneration/);
assert.match(surface, /generation !== scanGeneration/);

// Keep redundant masthead copy hidden, but restore the fast 표시/흐림/숨김 controls. Detailed
// per-page settings stay on the gear button, and invalidated old tabs must explain a one-tab reload.
assert.match(surface, /button\.textContent = '⚙'/);
assert.match(surface, /brand\.hidden = true/);
assert.doesNotMatch(surface, /brand\.textContent = `Eternal/);
assert.match(hotfix, /querySelectorAll\('button\[data-eyh-mode\]'\)/);
assert.match(hotfix, /button\.hidden = false/);
assert.match(hotfix, /showReloadNotice/);

// Common defaults must have the same expressive power as a page override.
for (const id of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(optionsHtml.includes(`id="${id}"`), `missing default profile control ${id}`);
assert.match(options, /dimEnabled: \$\('#watchedDefaultDimEnabled'\)\.checked/);
assert.match(options, /hideEnabled: \$\('#watchedDefaultHideEnabled'\)\.checked/);
assert.match(options, /watchedSurfaceDefaultProfile: defaultProfile/);
assert.match(surface, /delete profiles\[key\]/);
assert.match(surface, /기본값 사용/);
console.log('PASS pc integration static self-test');
