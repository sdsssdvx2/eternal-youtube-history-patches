import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './watch-later-recovery-selftest.mjs';
import './watch-later-recovery-static-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const adapter = fs.readFileSync(path.join(src, 'page-profile-adapter.js'), 'utf8');
const content = fs.readFileSync(path.join(src, 'content.js'), 'utf8');
const options = fs.readFileSync(path.join(src, 'options.js'), 'utf8');

// The proven 0.9.x content script is again the single watched-card renderer. The two later
// all-page mutation/scanner layers caused v0.10.x jank and UI ownership races and must not load.
assert.match(content, /classList\.toggle\('eyh-watched'/);
assert.match(content, /classList\.toggle\('eyh-hidden'/);
const allPageIsolated = manifest.content_scripts.find(entry =>
  entry.world === 'ISOLATED' && entry.matches?.includes('https://www.youtube.com/*'));
assert.ok(allPageIsolated, 'missing all-page isolated content-script entry');
assert.ok(allPageIsolated.js.includes('content.js'), 'stable content renderer must load');
assert.ok(allPageIsolated.js.includes('page-profile-adapter.js'), 'lightweight profile adapter must load');
assert.ok(!allPageIsolated.js.includes('surface-profiles.js'), 'duplicate surface scanner must not load');
assert.ok(!allPageIsolated.js.includes('pc-ui-hotfix.js'), 'header MutationObserver hotfix must not load');
assert.ok(!allPageIsolated.js.includes('watch-later-safe.js'), 'heavy Watch Later transaction UI must be playlist-scoped');
assert.ok(!allPageIsolated.js.includes('watch-later-recovery-content.js'), 'recovery bridge must be playlist-scoped');

// The adapter may translate page/default profiles and bind controls, but it must never become a
// second DOM scanner/observer. Navigation + bounded header retries are intentionally sufficient.
assert.doesNotMatch(adapter, /MutationObserver/);
assert.doesNotMatch(adapter, /querySelectorAll\('a\[href\*=/);
assert.match(adapter, /watchedSurfaceProfiles/);
assert.match(adapter, /watchedSurfaceDefaultProfile/);
assert.match(adapter, /button\[data-eyh-mode\]/);
assert.match(adapter, /stopImmediatePropagation\(\)/);
assert.match(adapter, /#eyh-surface-settings/);
assert.match(adapter, /\.remove\(\)/);

// Shorts has no Eternal masthead UI. Leaving Shorts restores the existing stable quick controls.
assert.match(adapter, /if \(key === 'shorts'\)[\s\S]*root\.style\.display = 'none'/);
assert.match(adapter, /root\.style\.removeProperty\('display'\)/);

// Legacy destructive buttons stay hidden; only the playlist-scoped journaled safe transaction
// implementation can expose cleanup/undo.
assert.match(adapter, /#eyh-watch-later-auto/);
assert.match(adapter, /#eyh-watch-later-cleanup/);
assert.match(adapter, /watchLaterAutoCleanupEnabled: false/);
const playlistIsolated = manifest.content_scripts.find(entry =>
  entry.world === 'ISOLATED' && entry.matches?.includes('https://www.youtube.com/playlist*'));
assert.ok(playlistIsolated?.js.includes('watch-later-safe.js'));
assert.ok(playlistIsolated?.js.includes('watch-later-recovery-content.js'));

// Common/default profile data and per-page overrides remain stored even though presentation is
// deliberately reduced to the stable one-mode renderer for this recovery release.
for (const token of [
  'watchedDefaultDimEnabled', 'watchedDefaultHideEnabled', 'watchedDefaultLinkedThresholds',
  'watchedDefaultSharedThreshold', 'watchedDefaultDimThreshold', 'watchedDefaultHideThreshold'
]) assert.ok(options.includes(token), `missing retained default-profile field: ${token}`);
assert.match(adapter, /profiles: values\.watchedSurfaceProfiles/);
assert.match(adapter, /\[state\.key\]: next/);

console.log('PASS single-renderer page-profile stability self-test');
