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
const background = text('background.js');
const content = text('content.js');
const css = text('content.css');
const stability = text('pc-stability-controller.js');
const inlineControls = text('pc-inline-controls.js');
const spaLifecycle = text('pc-spa-lifecycle.js');
const safety = text('watch-later-safety-main.js');
const safeCore = text('watch-later-safe-core.js');
const safeMain = text('watch-later-safe-main.js');
const safeCoordinator = text('watch-later-safe.js');
const safeAuto = text('watch-later-safe-auto.js');
const recoveryContent = text('watch-later-recovery-content.js');
const maintenance = text('maintenance.js');
const options = text('options.js');
const optionsHtml = text('options.html');

assert.equal(manifest.version, '0.10.18');
assert.equal(manifest.background?.service_worker, 'background-entry.js');
assert.match(backgroundEntry, /^import '\.\/background\.js';\s*$/m);
assert.doesNotMatch(backgroundEntry, /pc-update-reconnect/,
  'extension update must never programmatically reload YouTube playback tabs');
assert.equal(fs.existsSync(path.join(src, 'pc-update-reconnect.js')), false,
  'automatic post-update tab reloader must not ship');
assert.equal(fs.existsSync(path.join(src, 'pc-profile-bootstrap.js')), false,
  'v0.10.17 document_start profile bootstrap must not ship');

const mainWorld = manifest.content_scripts.find(cs => cs.world === 'MAIN');
const isolatedWorlds = manifest.content_scripts.filter(cs => cs.world === 'ISOLATED');
assert.ok(mainWorld, 'MAIN world is required');
assert.equal(isolatedWorlds.length, 1, 'exactly one ISOLATED runtime is allowed');
const isolated = isolatedWorlds[0];
assert.equal(isolated.run_at, 'document_idle');
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js');
assert.ok(mainWorld.js.indexOf('watch-later-core.js') < mainWorld.js.indexOf('watch-later-safe-core.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'));
for (const required of [
  'content.js', 'pc-stability-controller.js', 'watch-later-safe-core.js',
  'watch-later-safe.js', 'watch-later-safe-auto.js', 'pc-inline-controls.js',
  'pc-spa-lifecycle.js', 'watch-later-recovery-content.js', 'maintenance.js'
]) assert.ok(isolated.js.includes(required), `missing resident ${required}`);
for (const forbidden of ['surface-profiles.js', 'pc-ui-hotfix.js', 'pc-profile-bootstrap.js']) {
  assert.ok(!isolated.js.includes(forbidden), `forbidden second renderer/bootstrap ${forbidden}`);
}

// One renderer only: content.js owns card presentation; UI/profile coordinators must not scan cards.
assert.match(content, /async function scanAndMark\(\)/);
assert.match(content, /classList\.toggle\('eyh-watched'/);
assert.match(content, /classList\.toggle\('eyh-hidden'/);
assert.match(content, /const observer = new MutationObserver/);
assert.doesNotMatch(stability, /MutationObserver|eyh-surface-watched|eyh-surface-hidden|querySelectorAll\('a\[href/);
assert.doesNotMatch(inlineControls, /MutationObserver|classList\.toggle\('eyh-(?:watched|hidden|surface)/);
assert.doesNotMatch(safeCoordinator, /classList\.toggle|new\s+MutationObserver/);
assert.doesNotMatch(safeAuto, /classList\.toggle|new\s+MutationObserver/);

// v0.10.18 root fix: page presentation is resolved and applied in the current tab only.
assert.match(content, /function surfaceKey\(\)/);
assert.match(content, /watchedSurfaceDefaultProfile/);
assert.match(content, /watchedSurfaceProfiles/);
assert.match(content, /globalThis\.EYHApplySurfacePresentation/);
assert.match(content, /scheduleScan\(0\)/, 'quick presentation changes need an immediate local repaint');
assert.match(stability, /globalThis\.EYHApplySurfacePresentation/);
assert.match(stability, /globalThis\.EYHChooseSurfaceMode/);
assert.match(stability, /watchedSurfaceProfiles: profiles/);
assert.match(stability, /applyRendererPresentation\(mode, null\)/,
  'physical quick-mode clicks must update the current renderer before storage round trips');
const persistBlock = stability.match(/async function persistCurrentSurfaceMode[\s\S]*?\n  }\n\n  function chooseCurrentSurfaceMode/)?.[0] || '';
assert.ok(persistBlock, 'surface persistence block must exist');
assert.match(persistBlock, /watchedSurfaceProfiles: profiles/);
assert.doesNotMatch(persistBlock, /watchedDisplayMode|watchedMinProgressPct/,
  'a page-specific click must not leak through shared renderer keys');

const settingsBlock = content.match(/chrome\.storage\.onChanged\.addListener\(\(changes, area\) => \{([\s\S]*?)\n  \}\);\n\n  const observer/)?.[1] || '';
assert.ok(settingsBlock, 'content settings listener must exist');
assert.match(settingsBlock, /changes\.watchedSurfaceDefaultProfile/);
assert.match(settingsBlock, /changes\.watchedSurfaceProfiles/);
assert.doesNotMatch(settingsBlock, /watchedCache\.clear\(\)|progressCache\.clear\(\)/,
  'presentation changes must keep the ledger cache warm');
assert.match(settingsBlock, /loadDisplaySettings\(\)\.then\(\(\) => scheduleScan\(0\)\)/,
  'surface setting changes must repaint immediately');
assert.match(content, /msg\?\.type === 'RESCAN'[\s\S]*?watchedCache\.clear\(\); progressCache\.clear\(\)/,
  'explicit RESCAN retains hard cache invalidation');
assert.match(content, /Number\(result\?\.pulled\?\.imported \|\| 0\) > 0[\s\S]*?watchedCache\.clear\(\);[\s\S]*?progressCache\.clear\(\)/,
  'real server imports retain hard cache invalidation');

// Shorts stays a local presentation no-op and cannot rewrite persistent page/default state.
assert.match(stability, /if \(key === 'shorts'\) \{[\s\S]*?applyRendererPresentation\('none', 0\)/);
const shortsBlock = stability.match(/if \(key === 'shorts'\) \{([\s\S]*?)\n      return;/)?.[1] || '';
assert.doesNotMatch(shortsBlock, /chrome\.storage\.local\.set/);

// Playback progress in the Eternal ledger is monotonic; a reload/low sample may not lower max progress.
assert.match(background, /if \(oldPct != null && pct <= oldPct\) return;/);

// Header gear remains capture-delegated, while stale contexts require an explicit user confirmation.
assert.match(inlineControls, /PANEL_ID = 'eyh-inline-settings-panel'/);
assert.match(inlineControls, /GEAR_ID = 'eyh-inline-settings'/);
assert.match(inlineControls, /INSTANCE_TOKEN = crypto\.randomUUID\(\)/);
assert.match(inlineControls, /document\.addEventListener\('click',[\s\S]*?stopImmediatePropagation\(\)/);
assert.match(inlineControls, /offerReloadForStaleContext/);
assert.match(inlineControls, /confirm\(/);
assert.match(inlineControls, /location\.reload\(\)/);

// Keep the simple v0.10.12 SPA fallback; it is O(1) and never scans cards or storage.
assert.match(spaLifecycle, /HEARTBEAT_MS = 500/);
assert.match(spaLifecycle, /setInterval\(\(\) => reconcile\(false\), HEARTBEAT_MS\)/);
assert.doesNotMatch(spaLifecycle, /MutationObserver|querySelectorAll|ytd-|yt-lockup|chrome\.storage/);

// Fail closed on unknown card containers; hiding must only target known renderer roots.
assert.doesNotMatch(css, /\.eyh-hidden\s*,\s*\n\.eyh-surface-hidden\s*\{/);
assert.match(css, /ytd-playlist-video-renderer\.eyh-hidden/);
assert.match(css, /yt-lockup-view-model\.eyh-hidden/);
assert.match(css, /Unknown markup\s+now fails open/i);

// Watch Later destructive legacy path stays blocked; only journaled SAFE coordinators are resident.
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\(\)/);
assert.match(safety, /blocked-by-safety-lock/);
assert.match(safeCoordinator, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(safeCoordinator, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.match(safeAuto, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(safeAuto, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_REQUEST'|requestPage\('EYH_WL_REMOVE_ONE_REQUEST'/);
assert.doesNotMatch(safeAuto, /EYH_WL_REMOVE_REQUEST|EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safeMain, /strictListWatchLater/);
assert.match(safeCore, /continuation이 반복/);
assert.match(safeCore, /continuation 후보가 둘 이상/);
assert.match(safeCore, /안전 페이지 한도/);

const manualPersist = safeCoordinator.indexOf('let durable = await persistVerified(tx)');
const manualRevalidate = safeCoordinator.indexOf('revalidatePreparedSnapshot(durable)');
const manualRemoving = safeCoordinator.indexOf("durable.state = 'removing'");
assert.ok(manualPersist >= 0 && manualRevalidate > manualPersist && manualRemoving > manualRevalidate,
  'manual cleanup must persist and revalidate before entering removing state');
const manualAttempt = safeCoordinator.indexOf("candidate.status = 'attempting'");
const manualAttemptPersist = safeCoordinator.indexOf('durable = await persistVerified(durable)', manualAttempt);
const manualRemove = safeCoordinator.indexOf("requestPage('EYH_WL_SAFE_REMOVE_REQUEST'");
assert.ok(manualAttempt >= 0 && manualAttemptPersist > manualAttempt && manualRemove > manualAttemptPersist,
  'manual cleanup must durably persist attempting before destructive request');
const autoPersist = safeAuto.indexOf('let durable = await persistVerified(tx)');
const autoRevalidate = safeAuto.indexOf('revalidateSnapshot(durable)');
const autoRemoving = safeAuto.indexOf("durable.state = 'removing'");
assert.ok(autoPersist >= 0 && autoRevalidate > autoPersist && autoRemoving > autoRevalidate,
  'automatic cleanup must persist and revalidate before removing');

assert.match(recoveryContent, /declared !== entries\.length/);
assert.match(maintenance, /document\.visibilityState !== 'visible'/);
assert.match(options, /watchLaterSafeAutoCleanupEnabled/);
assert.match(optionsHtml, /자동 안전 정리/);

console.log('PASS pc v0.10.18 safe rollback + tab-local surface profiles + no auto reload + Watch Later safety');
