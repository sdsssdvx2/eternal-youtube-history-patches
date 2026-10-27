import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './watch-later-recovery-selftest.mjs';
import './watch-later-recovery-static-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const stability = fs.readFileSync(path.join(src, 'pc-stability-controller.js'), 'utf8');
const content = fs.readFileSync(path.join(src, 'content.js'), 'utf8');
const options = fs.readFileSync(path.join(src, 'options.js'), 'utf8');
const optionsHtml = fs.readFileSync(path.join(src, 'options.html'), 'utf8');

const isolated = manifest.content_scripts.find(cs => cs.world === 'ISOLATED');
assert.ok(isolated, 'missing isolated world content script');

// Regression contract: one and only one resident video-card renderer.
assert.ok(isolated.js.includes('content.js'));
assert.ok(isolated.js.includes('pc-stability-controller.js'));
assert.ok(!isolated.js.includes('surface-profiles.js'));
assert.ok(!isolated.js.includes('pc-ui-hotfix.js'));
assert.ok(!isolated.js.includes('watch-later-safe.js'));
assert.match(content, /classList\.toggle\('eyh-watched'/);
assert.match(content, /classList\.toggle\('eyh-hidden'/);
assert.match(content, /const observer = new MutationObserver/);
assert.doesNotMatch(stability, /MutationObserver/);
assert.doesNotMatch(stability, /classList\.toggle/);
assert.doesNotMatch(stability, /querySelectorAll\('a\[href/);

// Familiar quick controls remain, but their choice is persisted as the current page profile.
assert.match(content, /\['none','표시'\]/);
assert.match(content, /\['dim','흐림'\]/);
assert.match(content, /\['hide','숨김'\]/);
assert.match(stability, /setCurrentSurfaceMode/);
assert.match(stability, /watchedSurfaceProfiles: profiles/);
assert.match(stability, /dimEnabled: mode === 'dim'/);
assert.match(stability, /hideEnabled: mode === 'hide'/);

// The broken gear/panel layer is not resident. Stale remnants are actively removed.
assert.match(stability, /#eyh-surface-settings/);
assert.match(stability, /#eyh-surface-panel/);
assert.doesNotMatch(stability, /openPanel/);
assert.doesNotMatch(stability, /eyh-surface-compact/);
assert.match(optionsHtml, /안정화 버전에서는 별도의 ⚙ 페이지 패널을 띄우지 않습니다/);

// Shorts carries no Eternal masthead UI and, importantly, never rewrites the global legacy mode.
assert.match(stability, /path\.startsWith\('\/shorts\/'\)/);
assert.match(stability, /root\.style\.display = shorts \? 'none' : ''/);
assert.match(stability, /if \(key === 'shorts'\) \{[\s\S]*?scheduleHeaderDecoration\(\);[\s\S]*?return;[\s\S]*?\}/);
const shortsBlock = stability.match(/if \(key === 'shorts'\) \{([\s\S]*?)\n    \}/)?.[1] || '';
assert.doesNotMatch(shortsBlock, /chrome\.storage\.local\.(?:set|get)/,
  'Shorts must not corrupt the legacy/default presentation state');

// A direct 0.9.x -> 0.10.7 upgrade snapshots the legacy default before any page override is stored.
assert.match(stability, /if \(!hasStoredDefault\)/);
assert.match(stability, /watchedSurfaceDefaultProfile: defaults/);

// Common defaults and page overrides still retain full threshold expressiveness in storage.
for (const token of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(options.includes(token), `missing full default-profile field: ${token}`);
assert.match(stability, /watchedSurfaceDefaultProfile/);
assert.match(stability, /linkedThresholds/);
assert.match(stability, /sharedThreshold/);
assert.match(stability, /dimThreshold/);
assert.match(stability, /hideThreshold/);
assert.match(options, /watchedDisplayMode: presentation\.mode/,
  'options must feed the single renderer instead of disabling it');
assert.match(options, /watchLaterAutoCleanupEnabled: false/);
assert.match(optionsHtml, /자동 정리 \(현재 안전 잠금\)/);

console.log('PASS lightweight page-profile regression self-test');
