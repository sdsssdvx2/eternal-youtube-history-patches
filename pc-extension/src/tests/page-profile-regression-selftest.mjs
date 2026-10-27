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
const content = text('content.js');
const guard = text('pc-stability-guard.js');
const guardCss = text('pc-stability-guard.css');
const options = text('options.js');
const isolated = manifest.content_scripts.find(cs => cs.world === 'ISOLATED');

// v0.10.x regression root cause: multiple scripts independently owned the same masthead/card state.
// Stability mode must inject exactly one watched-card renderer: content.js.
assert.ok(isolated, 'missing isolated content-script world');
assert.ok(isolated.js.includes('content.js'));
assert.ok(!isolated.js.includes('surface-profiles.js'));
assert.ok(!isolated.js.includes('pc-ui-hotfix.js'));
assert.ok(isolated.js.includes('pc-stability-guard.js'));
assert.equal((content.match(/new MutationObserver/g) || []).length, 1,
  'content.js must remain the sole full-page presentation observer');
assert.doesNotMatch(guard, /MutationObserver/,
  'stability guard must never watch the YouTube DOM');

// Fast 표시/흐림/숨김 controls must update the same state the renderer reads.
assert.match(content, /watchedDisplayMode = mode/);
assert.match(content, /watchedDisplayMode === 'dim'/);
assert.match(content, /watchedDisplayMode === 'hide'/);
assert.match(content, /watchedDisplayMode !== 'none'/);
assert.match(options, /watchedDisplayMode: legacyMode/);
assert.doesNotMatch(options, /watchedDisplayMode: 'none'/);

// No gear/settings overlay exists in stability mode. The previous profile data is kept only in
// storage/source for future reimplementation; it cannot mutate the live YouTube DOM.
assert.ok(!isolated.js.includes('surface-profiles.js'));
assert.doesNotMatch(guard, /eyh-surface-settings/);
assert.doesNotMatch(guardCss, /eyh-surface-settings/);
assert.match(options, /pageProfilesPreservedButInactive/);

// Shorts suppression is URL-driven and declarative, not another presentation scanner.
assert.match(guard, /location\.pathname\.startsWith\('\/shorts\/'\)/);
assert.match(guard, /classList\.toggle\('eyh-shorts-surface', shorts\)/);
assert.match(guardCss, /html\.eyh-shorts-surface #eyh-header-controls/);

// The safety lock stays visible in behavior without bringing back the old DOM hotfix observer.
assert.match(guard, /watchLaterAutoCleanupEnabled: false/);
assert.match(guardCss, /#eyh-watch-later-auto/);
assert.match(guardCss, /#eyh-watch-later-cleanup/);

console.log('PASS single-owner presentation stability regression self-test');
