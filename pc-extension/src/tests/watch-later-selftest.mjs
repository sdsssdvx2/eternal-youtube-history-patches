import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../watch-later-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const safety = fs.readFileSync(path.join(src, 'watch-later-safety-main.js'), 'utf8');
const hotfix = fs.readFileSync(path.join(src, 'pc-ui-hotfix.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));

const C = globalThis.EYHWatchLaterCore;
assert.ok(C, 'core should attach to globalThis');
assert.equal(C.isWatchLaterUrl('https://www.youtube.com/playlist?list=WL'), true);
assert.equal(C.isWatchLaterUrl('https://www.youtube.com/watch?v=abcdefghijk&list=WL'), true);
assert.equal(C.isWatchLaterUrl('https://www.youtube.com/playlist?list=PL123'), false);
assert.equal(C.normalizeProgressPct(120), 100);
assert.equal(C.normalizeProgressPct(-4), 0);
assert.equal(C.normalizeProgressPct('not-a-number'), null);

const initial = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: [
  { playlistVideoRenderer: { videoId: 'abcdefghijk', setVideoId: 'SET_001_valid' } },
  { playlistVideoRenderer: { videoId: 'lmnopqrstuv', setVideoId: 'SET_002_valid' } },
  { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'CONTINUATION_TOKEN_1' } } } }
] } }] } }] } } } }] } } };
const entries = C.extractPlaylistEntries(initial);
assert.deepEqual(entries, [{ videoId: 'abcdefghijk', setVideoId: 'SET_001_valid' }, { videoId: 'lmnopqrstuv', setVideoId: 'SET_002_valid' }]);
assert.deepEqual(C.extractContinuationTokens(initial), ['CONTINUATION_TOKEN_1']);

// /next membership lookups commonly expose playlistPanelVideoRenderer.playlistSetVideoId
// instead of playlistVideoRenderer.setVideoId. Both must resolve to the same safe tuple.
const membership = {
  contents: {
    singleColumnWatchNextResults: {
      playlist: {
        playlist: {
          contents: [
            { playlistPanelVideoRenderer: { videoId: 'abcdefghijk', playlistSetVideoId: 'PANEL_SET_001' } }
          ]
        }
      }
    }
  }
};
assert.deepEqual(C.extractPlaylistEntries(membership), [
  { videoId: 'abcdefghijk', setVideoId: 'PANEL_SET_001' }
]);

assert.deepEqual(C.qualifyCleanup(entries, { abcdefghijk: 61.2, lmnopqrstuv: 59.9 }, 60), [{ videoId: 'abcdefghijk', setVideoId: 'SET_001_valid', progressPct: 61.2 }]);
assert.deepEqual(C.qualifyCleanup(entries, { abcdefghijk: 60 }, 60), [{ videoId: 'abcdefghijk', setVideoId: 'SET_001_valid', progressPct: 60 }]);
assert.deepEqual(C.qualifyCleanup(entries, { abcdefghijk: null }, 60), []);
assert.deepEqual(C.qualifyCleanup(entries, {}, 1), []);
assert.deepEqual(C.qualifyCleanup([
  { videoId: 'abcdefghijk', setVideoId: 'bad set id with spaces' }
], { abcdefghijk: 100 }, 60), []);
assert.deepEqual(C.buildRemoveActions([
  { videoId: 'abcdefghijk', setVideoId: 'SET_001_valid' },
  { videoId: 'abcdefghijk', setVideoId: 'SET_001_valid' },
  { videoId: 'bad', setVideoId: 'SET_999_valid' }
]), [
  { action: 'ACTION_REMOVE_VIDEO', setVideoId: 'SET_001_valid' },
  { action: 'ACTION_REMOVE_VIDEO', setVideoId: 'SET_999_valid' }
]);

// The v0.10.3 emergency boundary remains permanent in v0.10.6: destructive legacy requests are
// intercepted in MAIN world before the old page bridge can call browse/edit_playlist. The recovery
// feature added in v0.10.6 is a separate ADD-only path and must not reopen these messages.
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\(\)/);
assert.match(safety, /blocked-by-safety-lock/);
assert.match(hotfix, /watchLaterAutoCleanupEnabled: false/);
assert.match(hotfix, /#eyh-watch-later-auto/);
assert.match(hotfix, /#eyh-watch-later-cleanup/);

const mainWorld = manifest.content_scripts.find(entry => entry.world === 'MAIN');
assert.ok(mainWorld, 'MAIN-world content script is required');
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js', 'safety boundary must load before page-bridge');
assert.ok(mainWorld.js.indexOf('watch-later-safety-main.js') < mainWorld.js.indexOf('watch-later-safe-core.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'));
assert.equal(manifest.version, '0.10.6');

console.log('PASS watch-later-core + fail-closed safety self-test');
