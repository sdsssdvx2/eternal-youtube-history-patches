import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './watch-later-recovery-selftest.mjs';
import './watch-later-recovery-static-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const surface = fs.readFileSync(path.join(src, 'surface-profiles.js'), 'utf8');
const content = fs.readFileSync(path.join(src, 'content.js'), 'utf8');
const css = fs.readFileSync(path.join(src, 'content.css'), 'utf8');
const options = fs.readFileSync(path.join(src, 'options.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));

// v0.10.0 regression: two scanners toggled the exact same presentation classes.
assert.match(content, /classList\.toggle\('eyh-watched'/);
assert.match(content, /classList\.toggle\('eyh-hidden'/);
assert.doesNotMatch(surface, /classList\.toggle\('eyh-watched'/);
assert.doesNotMatch(surface, /classList\.toggle\('eyh-hidden'/);
assert.match(surface, /classList\.toggle\('eyh-surface-watched'/);
assert.match(surface, /classList\.toggle\('eyh-surface-hidden'/);
assert.match(css, /\.eyh-surface-watched/);
assert.match(css, /\.eyh-surface-hidden/);

// v0.10.6 regression: pc-ui-hotfix and surface-profiles repeatedly fought over hidden/active state.
const isolated = manifest.content_scripts.find(x => x.world === 'ISOLATED');
assert.ok(isolated, 'isolated content-script list missing');
assert.ok(!isolated.js.includes('pc-ui-hotfix.js'), 'competing pc-ui-hotfix must not load');
assert.match(surface, /function bindQuickButton\(button\)/);
assert.match(surface, /button\.hidden = false/);
assert.match(surface, /event\.stopImmediatePropagation\(\)/);
assert.match(surface, /applyQuickMode\(button\.dataset\.eyhMode\)/);
assert.match(surface, /watchedSurfaceProfiles: profiles/);

// A late async response from a previous YouTube SPA surface must not repaint the new surface.
assert.match(surface, /const generation = \+\+scanGeneration/);
assert.match(surface, /generation !== scanGeneration \|\| key !== surfaceKey\(\)/);

// Keep redundant brand text out of the masthead; quick controls and gear share one owner.
assert.match(surface, /button\.textContent = '⚙'/);
assert.match(surface, /brand\.hidden = true/);
assert.match(surface, /showReloadNotice\(\)/);
assert.match(surface, /openPanel\(\)/);

// Eternal's own header/panel mutations must not feed back into another whole-page scan.
assert.match(surface, /#eyh-header-controls, #eyh-surface-panel/);
assert.match(surface, /function scheduleScan\(delay = 140\)/);

// Shorts is a full-screen player, not a recommendation-card page. It carries no Eternal controls.
assert.match(surface, /if \(key === 'shorts'\) \{\s*clearAllManaged\(\)/s);
assert.match(surface, /if \(key === 'shorts'\) \{\s*root\.style\.display = 'none'/s);
assert.match(surface, /button\?\.remove\(\)/);
assert.match(surface, /root\.style\.removeProperty\('display'\)/);

// Common defaults and per-page overrides have identical dim/hide threshold expressiveness.
for (const token of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(options.includes(token), `missing full default-profile field: ${token}`);
assert.match(surface, /delete profiles\[key\]/);
assert.match(surface, /const hide = profile\.hideEnabled/);
assert.match(surface, /const dim = !hide && profile\.dimEnabled/);

console.log('PASS page-profile regression self-test');
