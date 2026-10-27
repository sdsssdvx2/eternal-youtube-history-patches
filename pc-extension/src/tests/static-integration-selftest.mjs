import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './watch-later-safe-transaction-selftest.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const text = name => fs.readFileSync(path.join(src, name), 'utf8');
const manifest = JSON.parse(text('manifest.json'));
const content = text('content.js');
const surface = text('surface-profiles.js');
const safety = text('watch-later-safety-main.js');
const safeCore = text('watch-later-safe-core.js');
const safeMain = text('watch-later-safe-main.js');
const safeCoordinator = text('watch-later-safe.js');
const recoveryContent = text('watch-later-recovery-content.js');
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
assert.ok(mainWorld.js.indexOf('watch-later-core.js') < mainWorld.js.indexOf('watch-later-safe-core.js'), 'Watch Later parser must precede safe core in MAIN world');
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'), 'safe core must precede safe write bridge');
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'), 'safe bridge must be isolated from the legacy page bridge');
assert.equal(isolatedWorld.js[0], 'watch-later-core.js', 'core must load first in ISOLATED world');
assert.ok(isolatedWorld.js.indexOf('watch-later-safe-core.js') < isolatedWorld.js.indexOf('watch-later-safe.js'), 'safe transaction core must precede coordinator');
assert.ok(isolatedWorld.js.includes('maintenance.js'), 'maintenance must load in isolated YouTube pages');
assert.ok(isolatedWorld.js.includes('surface-profiles.js'), 'page-profile renderer must load in isolated YouTube pages');
assert.ok(!isolatedWorld.js.includes('pc-ui-hotfix.js'), 'competing PC UI observer must not load');
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
assert.match(safeCoordinator, /watchLaterAutoCleanupEnabled: false/);

// v0.10.5 must not inherit the legacy list-completeness ambiguity. The destructive coordinator uses
// a separate strict server-only list protocol, and the MAIN-world enumerator rejects loops, multiple
// continuation candidates, zero-add continuation pages, and the page cap through paginationDecision.
assert.match(safeCoordinator, /EYH_WL_SAFE_LIST_REQUEST/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_LIST_REQUEST'/);
assert.match(safeMain, /strictListWatchLater/);
assert.match(safeMain, /SAFE\.paginationDecision/);
assert.match(safeMain, /terminalReason: decision\.terminalReason/);
assert.match(safeCore, /continuation이 반복/);
assert.match(safeCore, /continuation 후보가 둘 이상/);
assert.match(safeCore, /continuation은 남았지만 새 항목이 없어/);
assert.match(safeCore, /안전 페이지 한도/);
assert.match(safeCoordinator, /YouTube 화면의 Watch Later 전체 개수를 확인할 수 없어/);
assert.match(safeCoordinator, /listed\.terminalReason !== 'no-continuation'/);

// Transactional path: persist the full snapshot, re-enumerate the entire playlist after user
// confirmation, require exact membership equality, and only then enter the destructive phase.
assert.match(safeCore, /MAX_SNAPSHOT_ENTRIES = 5000/);
assert.match(safeCore, /sameSnapshotMembership/);
assert.match(safeCore, /if \(hasMore\) throw new Error/);
assert.match(safeCore, /status: 'prepared'/);
assert.match(safeCoordinator, /const recomputed = await sha256Hex\(CORE\.canonicalForDigest\(tx\)\)/);
const persistBeforeSecondSnapshot = safeCoordinator.indexOf('let durable = await persistVerified(tx)');
const secondSnapshot = safeCoordinator.indexOf('revalidatePreparedSnapshot(durable)');
const enteringRemoving = safeCoordinator.indexOf("durable.state = 'removing'");
assert.ok(persistBeforeSecondSnapshot >= 0 && secondSnapshot > persistBeforeSecondSnapshot && enteringRemoving > secondSnapshot,
  'durable journal and second full snapshot verification must precede removing state');
assert.match(safeCoordinator, /CORE\.sameSnapshotMembership\(tx\.snapshot, current\)/);

// Crash-safety invariant: each individual candidate is durably marked attempting before the safe
// remove request. A non-removed result halts the remaining deletion sequence immediately.
const firstAttempting = safeCoordinator.indexOf("candidate.status = 'attempting'");
const persistAttempting = safeCoordinator.indexOf('durable = await persistVerified(durable)', firstAttempting);
const firstSafeRemove = safeCoordinator.indexOf("requestPage('EYH_WL_SAFE_REMOVE_REQUEST'");
assert.ok(firstAttempting >= 0 && persistAttempting > firstAttempting && firstSafeRemove > persistAttempting,
  'attempting journal state must be durably verified before every destructive request');
assert.match(safeCoordinator, /The next delete is forbidden until the result of this one is durably re-read and verified/);
assert.match(safeCoordinator, /if \(candidate\.status !== 'removed'\)/);
assert.match(safeCoordinator, /haltReason = candidate\.status/);

// MAIN-world safe remove still resolves current membership immediately before delete and requires
// fresh tuple equality. Restore stays idempotent. Schema-2 undo narrows recovery to removed or
// uncertain attempts, while schema-1 remains broad for v0.10.4 crash compatibility.
const freshResolve = safeMain.indexOf('const fresh = await resolveEntry(id)');
const exactCompare = safeMain.indexOf('fresh.setVideoId !== expected');
const destructiveAction = safeMain.indexOf("action: 'ACTION_REMOVE_VIDEO'");
assert.ok(freshResolve >= 0 && exactCompare > freshResolve && destructiveAction > exactCompare,
  'fresh videoId/setVideoId revalidation must precede ACTION_REMOVE_VIDEO');
assert.match(safeMain, /ACTION_ADD_VIDEO/);
assert.match(safeMain, /addedVideoId: id/);
assert.match(safeMain, /already_present/);
assert.match(safeMain, /operationId\.startsWith\('pcwl:'\)/);
assert.match(safeMain, /EYH_WL_SAFE_RESULT/);
assert.match(safeCore, /UNDO_UNCERTAIN_STATES/);
assert.match(safeCore, /Number\(tx\?\.schema \|\| 0\) < 2/);
assert.match(safeCoordinator, /candidate\.undoStatus = 'not_needed'/);
assert.match(safeCoordinator, /candidate\.undoStatus = 'attempting'/);
assert.match(safeCoordinator, /마지막 정리 되돌리기/);

// Recovery is ADD-only: a header count mismatch is diagnostic, not a reason to block candidate
// discovery. Every selected candidate is re-resolved by safeAdd before any mutation.
assert.match(recoveryContent, /const countMismatch = declared != null && declared !== entries\.length/);
assert.match(recoveryContent, /countMismatch,/);
assert.doesNotMatch(recoveryContent, /표시 개수 .*복구 비교를 중단합니다/);

// Users must be able to tell whether PC background cleanup previously ran without opening devtools.
assert.match(popupHtml, /id="watchLaterSafety"/);
assert.match(popup, /eyhLastAutoWatchLaterSweep/);
assert.match(popup, /최근 PC 자동 정리/);
assert.match(popup, /현재 자동 설정/);

// Page-profile presentation must never share the legacy renderer's toggle classes. One script owns
// quick buttons, detailed profile settings, and card presentation; no attribute-observer hotfix may compete.
assert.match(surface, /eyh-surface-watched/);
assert.match(surface, /eyh-surface-hidden/);
assert.doesNotMatch(surface, /classList\.toggle\('eyh-watched'/);
assert.doesNotMatch(surface, /classList\.toggle\('eyh-hidden'/);
assert.match(css, /\.eyh-surface-watched/);
assert.match(css, /\.eyh-surface-hidden/);
assert.match(surface, /scanGeneration/);
assert.match(surface, /generation !== scanGeneration/);
assert.match(surface, /function bindQuickButton\(button\)/);
assert.match(surface, /button\.hidden = false/);
assert.match(surface, /event\.stopImmediatePropagation\(\)/);
assert.match(surface, /applyQuickMode\(button\.dataset\.eyhMode\)/);
assert.match(surface, /showReloadNotice/);
assert.match(surface, /#eyh-header-controls, #eyh-surface-panel/);

// Keep redundant masthead copy hidden; detailed per-page settings stay on the gear button.
assert.match(surface, /button\.textContent = '⚙'/);
assert.match(surface, /brand\.hidden = true/);
assert.doesNotMatch(surface, /brand\.textContent = `Eternal/);

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
