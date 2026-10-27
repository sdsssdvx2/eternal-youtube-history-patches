import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './watch-later-recovery-selftest.mjs';
import './watch-later-recovery-static-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const surface = fs.readFileSync(path.join(src, 'surface-profiles.js'), 'utf8');
const hotfix = fs.readFileSync(path.join(src, 'pc-ui-hotfix.js'), 'utf8');
const content = fs.readFileSync(path.join(src, 'content.js'), 'utf8');
const css = fs.readFileSync(path.join(src, 'content.css'), 'utf8');
const options = fs.readFileSync(path.join(src, 'options.js'), 'utf8');

// v0.10.0 regression: two scanners toggled the exact same presentation classes.
assert.match(content, /classList\.toggle\('eyh-watched'/);
assert.match(content, /classList\.toggle\('eyh-hidden'/);
assert.doesNotMatch(surface, /classList\.toggle\('eyh-watched'/);
assert.doesNotMatch(surface, /classList\.toggle\('eyh-hidden'/);
assert.match(surface, /classList\.toggle\('eyh-surface-watched'/);
assert.match(surface, /classList\.toggle\('eyh-surface-hidden'/);
assert.match(css, /\.eyh-surface-watched/);
assert.match(css, /\.eyh-surface-hidden/);

// A late async response from a previous YouTube SPA surface must not repaint the new surface.
assert.match(surface, /const generation = \+\+scanGeneration/);
assert.match(surface, /generation !== scanGeneration \|\| key !== surfaceKey\(\)/);

// Keep redundant brand/page text out of the masthead, but never remove the proven quick controls.
assert.match(surface, /button\.textContent = '⚙'/);
assert.match(surface, /brand\.hidden = true/);
assert.match(hotfix, /querySelectorAll\('button\[data-eyh-mode\]'\)/);
assert.match(hotfix, /button\.hidden = false/);
assert.match(hotfix, /applyQuickMode\(mode\)/);
assert.match(hotfix, /dimEnabled: mode === 'dim'/);
assert.match(hotfix, /hideEnabled: mode === 'hide'/);

// An old tab whose extension context was invalidated must explain itself instead of silently eating
// the gear click. A single reload is sufficient; extension removal/re-registration is never needed.
assert.match(hotfix, /EXTENSION_CONTEXT_INVALIDATED/);
assert.match(hotfix, /showReloadNotice\(\)/);
assert.match(hotfix, /이 탭만 한 번 새로고침/);

// Shorts is a full-screen player, not a recommendation-card page. It must carry neither profile
// rendering nor any Eternal masthead controls; leaving Shorts must still remount normal controls.
assert.match(surface, /if \(key === 'shorts'\) \{\s*clearAllManaged\(\)/s);
assert.match(surface, /if \(key === 'shorts'\) \{\s*button\?\.remove\(\)/s);
assert.match(surface, /const key = surfaceKey\(\);\s*if \(key === 'shorts'\) return;/s);
assert.match(hotfix, /if \(key === 'shorts'\)[\s\S]*root\.style\.display = 'none'/);
assert.match(hotfix, /root\.style\.removeProperty\('display'\)/);

// Common defaults and per-page overrides have identical dim/hide threshold expressiveness.
for (const token of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(options.includes(token), `missing full default-profile field: ${token}`);
assert.match(surface, /delete profiles\[key\]/);
assert.match(surface, /const hide = profile\.hideEnabled/);
assert.match(surface, /const dim = !hide && profile\.dimEnabled/);

console.log('PASS page-profile regression self-test');
