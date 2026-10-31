import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './watch-later-recovery-selftest.mjs';
import './watch-later-recovery-static-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const text = name => fs.readFileSync(path.join(src, name), 'utf8');
const manifest = JSON.parse(text('manifest.json'));
const stability = text('pc-stability-controller.js');
const content = text('content.js');
const safeCoordinator = text('watch-later-safe.js');
const safeAuto = text('watch-later-safe-auto.js');
const options = text('options.js');
const optionsHtml = text('options.html');
const backgroundEntry = text('background-entry.js');

assert.equal(manifest.version, '0.10.18');
const isolatedWorlds = manifest.content_scripts.filter(cs => cs.world === 'ISOLATED');
assert.equal(isolatedWorlds.length, 1, 'only one isolated runtime may be resident');
const isolated = isolatedWorlds[0];
assert.ok(isolated.js.includes('content.js'));
assert.ok(isolated.js.includes('pc-stability-controller.js'));
assert.ok(isolated.js.includes('watch-later-safe.js'));
assert.ok(isolated.js.includes('watch-later-safe-auto.js'));
assert.ok(!isolated.js.includes('surface-profiles.js'));
assert.ok(!isolated.js.includes('pc-ui-hotfix.js'));
assert.ok(!isolated.js.includes('pc-profile-bootstrap.js'));
assert.doesNotMatch(backgroundEntry, /pc-update-reconnect/);

// content.js remains the only card renderer.
assert.match(content, /classList\.toggle\('eyh-watched'/);
assert.match(content, /classList\.toggle\('eyh-hidden'/);
assert.match(content, /const observer = new MutationObserver/);
assert.doesNotMatch(stability, /MutationObserver/);
assert.doesNotMatch(stability, /classList\.toggle\('eyh-(?:watched|hidden|surface)/,
  'profile adapter may paint header buttons but never card presentation classes');
assert.doesNotMatch(stability, /querySelectorAll\('a\[href/);
assert.doesNotMatch(safeCoordinator, /classList\.toggle|new\s+MutationObserver/);
assert.doesNotMatch(safeAuto, /classList\.toggle|new\s+MutationObserver/);

// Current-surface profile is persistent; renderer state is local to each tab.
assert.match(content, /function surfaceKey\(\)/);
assert.match(content, /watchedSurfaceProfiles/);
assert.match(content, /watchedSurfaceDefaultProfile/);
assert.match(content, /globalThis\.EYHApplySurfacePresentation/);
assert.match(stability, /function surfaceKey\(\)/);
assert.match(stability, /chooseCurrentSurfaceMode/);
assert.match(stability, /persistCurrentSurfaceMode/);
assert.match(stability, /pendingModeBySurface/);
assert.match(stability, /quickModeSeqBySurface/);
assert.match(stability, /watchedSurfaceProfiles: profiles/);
assert.match(stability, /dimEnabled: mode === 'dim'/);
assert.match(stability, /hideEnabled: mode === 'hide'/);
assert.match(stability, /globalThis\.EYHApplySurfacePresentation/);
assert.match(stability, /globalThis\.EYHChooseSurfaceMode/);
assert.doesNotMatch(stability, /watchedDisplayMode\s*:/,
  'page-specific mode must never be transported through a shared storage key');
assert.doesNotMatch(stability, /watchedMinProgressPct\s*:/,
  'page-specific threshold must never be transported through a shared storage key');
assert.doesNotMatch(stability, /quickModeGeneration|quickModeWrite/);

const persistBlock = stability.match(/async function persistCurrentSurfaceMode[\s\S]*?\n  }\n\n  function chooseCurrentSurfaceMode/)?.[0] || '';
assert.ok(persistBlock);
assert.match(persistBlock, /watchedSurfaceProfiles: profiles/);
assert.doesNotMatch(persistBlock, /watchedDisplayMode|watchedMinProgressPct/);
const clickBlock = stability.match(/function chooseCurrentSurfaceMode[\s\S]*?\n  }\n\n  globalThis\.EYHChooseSurfaceMode/)?.[0] || '';
assert.ok(clickBlock);
assert.match(clickBlock, /paintQuickMode\(mode\)/);
assert.match(clickBlock, /applyRendererPresentation\(mode, null\)/,
  'click must visibly apply before async persistence');

// Navigation and cross-tab storage notifications re-resolve only the receiving tab's current URL.
assert.match(content, /const key = surfaceKey\(\)/);
assert.match(content, /Object\.prototype\.hasOwnProperty\.call\(profiles, key\)/);
assert.match(content, /const onYoutubeNavigation = \(\) => \{[\s\S]*?loadDisplaySettings\(\)\.then\(\(\) => scheduleScan\(0\)\)/);
const settingsBlock = content.match(/chrome\.storage\.onChanged\.addListener\(\(changes, area\) => \{([\s\S]*?)\n  \}\);\n\n  const observer/)?.[1] || '';
assert.match(settingsBlock, /changes\.watchedSurfaceProfiles/);
assert.match(settingsBlock, /changes\.watchedSurfaceDefaultProfile/);
assert.doesNotMatch(settingsBlock, /watchedCache\.clear\(\)|progressCache\.clear\(\)/);
assert.match(settingsBlock, /scheduleScan\(0\)/);

// Shorts remains presentation-off without mutating persistent settings.
assert.match(stability, /path\.startsWith\('\/shorts\/'\)/);
assert.match(stability, /root\.style\.display = shorts \? 'none' : ''/);
assert.match(stability, /if \(key === 'shorts'\) \{[\s\S]*?applyRendererPresentation\('none', 0\)/);
const shortsBlock = stability.match(/if \(key === 'shorts'\) \{([\s\S]*?)\n      return;/)?.[1] || '';
assert.doesNotMatch(shortsBlock, /chrome\.storage\.local\.set/);

// Options still own the common default profile, which is distinct from per-surface overrides.
for (const token of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(options.includes(token), `missing default profile control ${token}`);
assert.match(options, /watchedSurfaceDefaultProfile: defaultProfile/);
assert.match(options, /watchLaterSafeAutoCleanupEnabled/);
assert.match(optionsHtml, /자동 안전 정리/);

// Safe Watch Later cleanup/undo remains independent from presentation.
assert.match(safeCoordinator, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(safeCoordinator, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.match(safeAuto, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(safeAuto, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.doesNotMatch(safeCoordinator, /EYH_WL_REMOVE_REQUEST|EYH_WL_REMOVE_ONE_REQUEST/);
assert.doesNotMatch(safeAuto, /EYH_WL_REMOVE_REQUEST|EYH_WL_REMOVE_ONE_REQUEST/);

console.log('PASS v0.10.18 tab-local page-profile + immediate quick-mode + safe cleanup coexistence regression self-test');
