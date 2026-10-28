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
const stability = text('pc-stability-controller.js');
const surface = text('surface-profiles.js');
const hotfix = text('pc-ui-hotfix.js');
const safety = text('watch-later-safety-main.js');
const safeCore = text('watch-later-safe-core.js');
const safeMain = text('watch-later-safe-main.js');
const safeCoordinator = text('watch-later-safe.js');
const bridge = text('page-bridge.js');
const core = text('watch-later-core.js');
const recoveryContent = text('watch-later-recovery-content.js');
const options = text('options.js');
const optionsHtml = text('options.html');
const maintenance = text('maintenance.js');
const popup = text('popup.js');
const popupHtml = text('popup.html');

assert.equal(manifest.version, '0.10.8', 'Watch Later/UI fix release must be distinguishable from prior builds');
const mainWorld = manifest.content_scripts.find(cs => cs.world === 'MAIN');
const isolatedWorld = manifest.content_scripts.find(cs => cs.world === 'ISOLATED');
assert.ok(mainWorld && isolatedWorld, 'both MAIN and ISOLATED content-script worlds are required');
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js', 'legacy destructive safety boundary must load first in MAIN world');
assert.ok(mainWorld.js.indexOf('watch-later-core.js') < mainWorld.js.indexOf('watch-later-safe-core.js'), 'Watch Later parser must precede safe core in MAIN world');
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'), 'safe core must precede safe write bridge');
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'), 'safe bridge must be isolated from the legacy page bridge');
assert.equal(isolatedWorld.js[0], 'watch-later-core.js', 'core must load first in ISOLATED world');
assert.ok(isolatedWorld.js.includes('content.js'), 'legacy content.js must remain the sole card renderer');
assert.ok(isolatedWorld.js.includes('pc-stability-controller.js'), 'lightweight stability/profile adapter must load');
assert.ok(isolatedWorld.js.includes('watch-later-recovery-content.js'), 'ADD-only Watch Later recovery bridge must load');
assert.ok(isolatedWorld.js.includes('maintenance.js'), 'maintenance must load in isolated YouTube pages');
assert.ok(!isolatedWorld.js.includes('surface-profiles.js'), 'second card renderer must not load');
assert.ok(!isolatedWorld.js.includes('pc-ui-hotfix.js'), 'whole-document hotfix observer must not load');
assert.ok(isolatedWorld.js.includes('watch-later-safe-core.js'), 'safe transaction core must load in isolated world');
assert.ok(isolatedWorld.js.includes('watch-later-safe.js'), 'safe transaction coordinator must be resident');
assert.ok(isolatedWorld.js.includes('watch-later-safe-core.js'), 'safe transaction core must load in ISOLATED world');

// The old stable renderer remains the only code that scans video cards and toggles legacy classes.
assert.match(content, /async function scanAndMark\(\)/);
assert.match(content, /classList\.toggle\('eyh-watched'/);
assert.match(content, /classList\.toggle\('eyh-hidden'/);
assert.match(content, /const observer = new MutationObserver/);
assert.doesNotMatch(stability, /MutationObserver/);
assert.doesNotMatch(stability, /querySelectorAll\('a\[href\*=/);
assert.doesNotMatch(stability, /eyh-surface-watched/);
assert.doesNotMatch(stability, /eyh-surface-hidden/);
assert.match(stability, /content\.js is the sole card renderer/);

// Restore the familiar quick buttons, remove the broken gear, and hide the masthead on Shorts.
assert.match(content, /\['none','표시'\]/);
assert.match(content, /\['dim','흐림'\]/);
assert.match(content, /\['hide','숨김'\]/);
assert.match(stability, /button\[data-eyh-mode\]/);
assert.match(stability, /setCurrentSurfaceMode/);
assert.match(stability, /watchedSurfaceProfiles: profiles/);
assert.match(stability, /root\.querySelector\('#eyh-surface-settings'\)\?\.remove\(\)/);
assert.match(stability, /path\.startsWith\('\/shorts\/'\)/);
assert.match(stability, /root\.style\.display = shorts \? 'none' : ''/);
const shortsBlock = stability.match(/if \(key === 'shorts'\) \{([\s\S]*?)\n    \}/)?.[1] || '';
assert.doesNotMatch(shortsBlock, /chrome\.storage\.local\.(?:set|get)|watchedDisplayMode|watchedMinProgressPct/,
  'Shorts must hide UI without mutating renderer/default storage');
assert.match(stability, /watchedSurfaceDefaultProfile: defaults/,
  'direct stable-line upgrades must snapshot the legacy default before page overrides');

// Legacy mutation messages remain blocked, while the strict transaction coordinator is the only
// resident destructive owner and may persist the user's opt-in automatic preference.
assert.match(content, /LEGACY_WATCH_LATER_MUTATION_DISABLED = true/);
assert.match(options, /watchLaterAutoCleanupEnabled: false,/);
assert.ok(options.includes("watchLaterAutoCleanupEnabled: $('#watchLaterAutoCleanupEnabled').checked"));
assert.doesNotMatch(stability, /changes\.watchLaterAutoCleanupEnabled\?\.newValue === true/);
assert.match(stability, /#eyh-watch-later-auto/);
assert.match(stability, /#eyh-watch-later-cleanup/);
assert.match(safeCoordinator, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.match(safeCoordinator, /scheduleAutomaticCleanup/);
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\(\)/);
assert.match(safety, /blocked-by-safety-lock/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_REQUEST'/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_ONE_REQUEST'/);
assert.match(content, /eyh-watch-later-hidden/);

// Keep the strict transaction implementation packaged/tested for later re-enable, but not resident.
assert.match(safeCoordinator, /EYH_WL_SAFE_LIST_REQUEST/);
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
  'durable journal and second full snapshot verification must precede removing state');
const firstAttempting = safeCoordinator.indexOf("candidate.status = 'attempting'");
const persistAttempting = safeCoordinator.indexOf('durable = await persistVerified(durable)', firstAttempting);
const firstSafeRemove = safeCoordinator.indexOf("requestPage('EYH_WL_SAFE_REMOVE_REQUEST'");
assert.ok(firstAttempting >= 0 && persistAttempting > firstAttempting && firstSafeRemove > persistAttempting,
  'attempting journal state must be durably verified before every destructive request');
const freshResolve = safeMain.indexOf('const fresh = await resolveEntry(id)');
const exactCompare = safeMain.indexOf('fresh.setVideoId !== expected');
const destructiveAction = safeMain.indexOf("action: 'ACTION_REMOVE_VIDEO'");
assert.ok(freshResolve >= 0 && exactCompare > freshResolve && destructiveAction > exactCompare,
  'fresh videoId/setVideoId revalidation must precede ACTION_REMOVE_VIDEO');
assert.match(safeMain, /ACTION_ADD_VIDEO/);
assert.match(safeMain, /already_present/);

// Recovery remains ADD-only and now requires exact membership completeness after modern renderer parsing.
assert.match(core, /'lockupViewModel'/);
assert.match(core, /collectItemIds/);
assert.match(recoveryContent, /declared !== entries\.length/);
assert.match(recoveryContent, /unparsedCount: 0/);
assert.doesNotMatch(recoveryContent, /declared < entries\.length/);

// Existing history/diagnostic infrastructure stays intact.
assert.match(content, /GET_PAGE_DIAGNOSTICS/);
assert.match(maintenance, /EYH_REQUEST_HISTORY/);
assert.match(maintenance, /document\.visibilityState !== 'visible'/);
assert.match(core, /ACTION_REMOVE_VIDEO/);
assert.match(bridge, /setVideoId/);
assert.match(popupHtml, /id="watchLaterSafety"/);
assert.match(popup, /eyhLastAutoWatchLaterSweep/);

// Common defaults retain full profile data; the adapter maps them into the single renderer.
for (const id of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(optionsHtml.includes(`id="${id}"`), `missing default profile control ${id}`);
assert.match(options, /watchedSurfaceDefaultProfile: defaultProfile/);
assert.match(options, /watchedDisplayMode: presentation\.mode/);
assert.match(stability, /watchedSurfaceDefaultProfile/);
assert.match(stability, /effectivePresentation/);

// Historical regression files may remain packaged for audit, but they must not be resident.
assert.match(surface, /MutationObserver/);
assert.match(hotfix, /MutationObserver/);
assert.ok(!isolatedWorld.js.includes('surface-profiles.js'));
assert.ok(!isolatedWorld.js.includes('pc-ui-hotfix.js'));

console.log('PASS pc single-renderer integration self-test');
