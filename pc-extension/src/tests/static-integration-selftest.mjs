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
const css = text('content.css');
const bridge = text('page-bridge.js');
const core = text('watch-later-core.js');
const options = text('options.js');
const optionsHtml = text('options.html');
const maintenance = text('maintenance.js');

assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'manifest version must be release semver');
for (const cs of manifest.content_scripts) assert.equal(cs.js[0], 'watch-later-core.js', `core must load first in ${cs.world}`);
assert.ok(manifest.content_scripts.some(cs => cs.world === 'ISOLATED' && cs.js.includes('maintenance.js')), 'maintenance must load in isolated YouTube pages');
assert.ok(manifest.content_scripts.some(cs => cs.world === 'ISOLATED' && cs.js.includes('surface-profiles.js')), 'page-profile renderer must load in isolated YouTube pages');
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

// Header is compact: no page/brand copy is rendered into the toolbar, only an accessible settings
// button. Page names remain available in the dialog and tooltip where they are useful.
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
