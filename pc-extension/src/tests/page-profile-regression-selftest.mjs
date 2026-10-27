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
assert.doesNotMatch(stability, /openPanel/);
assert.doesNotMatch(stability, /eyh-surface-panel/);

// Shorts is a no-op presentation surface and carries no Eternal masthead UI.
assert.match(stability, /path\.startsWith\('\/shorts\/'\)/);
assert.match(stability, /watchedDisplayMode: 'none', watchedMinProgressPct: 0/);
assert.match(stability, /root\.style\.display = shorts \? 'none' : ''/);

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

console.log('PASS lightweight page-profile regression self-test');
