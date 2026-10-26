import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const surface = fs.readFileSync(path.join(src, 'surface-profiles.js'), 'utf8');
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

// The toolbar is intentionally compact; page names belong in the dialog/tooltip, not the masthead.
assert.match(surface, /button\.textContent = '⚙'/);
assert.match(surface, /brand\.hidden = true/);

// Common defaults and per-page overrides have identical dim/hide threshold expressiveness.
for (const token of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(options.includes(token), `missing full default-profile field: ${token}`);
assert.match(surface, /delete profiles\[key\]/);
assert.match(surface, /const hide = profile\.hideEnabled/);
assert.match(surface, /const dim = !hide && profile\.dimEnabled/);

console.log('PASS page-profile regression self-test');
