import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../watch-later-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const text = name => fs.readFileSync(path.join(src, name), 'utf8');
const safety = text('watch-later-safety-main.js');
const stability = text('pc-stability-controller.js');
const safeCoordinator = text('watch-later-safe.js');
const safeAuto = text('watch-later-safe-auto.js');
const inlineControls = text('pc-inline-controls.js');
const backgroundEntry = text('background-entry.js');
const manifest = JSON.parse(text('manifest.json'));

const C = globalThis.EYHWatchLaterCore;
assert.ok(C, 'core should attach to globalThis');
assert.equal(C.isWatchLaterUrl('https://www.youtube.com/playlist?list=WL'), true);
assert.equal(C.isWatchLaterUrl('https://www.youtube.com/watch?v=abcdefghijk&list=WL'), true);
assert.equal(C.isWatchLaterUrl('https://www.youtube.com/playlist?list=PL123'), false);
assert.equal(C.normalizeProgressPct(120), 100);
assert.equal(C.normalizeProgressPct(-4), 0);
assert.equal(C.normalizeProgressPct('not-a-number'), null);

const initial = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            sectionListRenderer: {
              contents: [{
                itemSectionRenderer: {
                  contents: [{
                    playlistVideoListRenderer: {
                      contents: [
                        { playlistVideoRenderer: { videoId: 'abcdefghijk', setVideoId: 'SET_001_valid' } },
                        { playlistVideoRenderer: { videoId: 'lmnopqrstuv', setVideoId: 'SET_002_valid' } },
                        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'CONTINUATION_TOKEN_1' } } } }
                      ]
                    }
                  }]
                }
              }]
            }
          }
        }
      }]
    }
  }
};
const entries = C.extractPlaylistEntries(initial);
assert.deepEqual(entries, [
  { videoId: 'abcdefghijk', setVideoId: 'SET_001_valid' },
  { videoId: 'lmnopqrstuv', setVideoId: 'SET_002_valid' }
]);
assert.deepEqual(C.extractContinuationTokens(initial), ['CONTINUATION_TOKEN_1']);
assert.deepEqual(C.qualifyCleanup(entries, { abcdefghijk: 61.2, lmnopqrstuv: 59.9 }, 60), [
  { videoId: 'abcdefghijk', setVideoId: 'SET_001_valid', progressPct: 61.2 }
]);
assert.deepEqual(C.qualifyCleanup(entries, { abcdefghijk: null }, 60), []);
assert.deepEqual(C.buildRemoveActions([
  { videoId: 'abcdefghijk', setVideoId: 'SET_001_valid' },
  { videoId: 'abcdefghijk', setVideoId: 'SET_001_valid' }
]), [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'SET_001_valid' }]);

// Permanent fail-closed boundary for legacy destructive requests.
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\(\)/);
assert.match(safety, /blocked-by-safety-lock/);
assert.match(stability, /watchLaterAutoCleanupEnabled: false/);
assert.match(stability, /#eyh-watch-later-auto/);
assert.match(stability, /#eyh-watch-later-cleanup/);
assert.match(safeCoordinator, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(safeCoordinator, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.match(safeAuto, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(safeAuto, /EYH_WL_SAFE_REMOVE_REQUEST/);
assert.match(inlineControls, /watchLaterSafeAutoCleanupEnabled/);
assert.match(inlineControls, /#eyh-watch-later-safe-cleanup/);
assert.doesNotMatch(inlineControls, /EYH_WL_REMOVE_REQUEST|EYH_WL_REMOVE_ONE_REQUEST/);
assert.doesNotMatch(safeCoordinator, /EYH_WL_REMOVE_REQUEST|EYH_WL_REMOVE_ONE_REQUEST/);
assert.doesNotMatch(safeAuto, /EYH_WL_REMOVE_REQUEST|EYH_WL_REMOVE_ONE_REQUEST/);

const mainWorld = manifest.content_scripts.find(entry => entry.world === 'MAIN');
const isolated = manifest.content_scripts.find(entry => entry.world === 'ISOLATED');
assert.ok(mainWorld, 'MAIN-world content script is required');
assert.ok(isolated, 'ISOLATED-world content script is required');
assert.equal(manifest.content_scripts.filter(entry => entry.world === 'ISOLATED').length, 1,
  'v0.10.18 must not reintroduce the v0.10.17 document_start bootstrap');
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js', 'legacy safety boundary must load first');
assert.ok(mainWorld.js.indexOf('watch-later-safety-main.js') < mainWorld.js.indexOf('watch-later-safe-core.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'));
assert.ok(isolated.js.includes('watch-later-safe-core.js'));
assert.ok(isolated.js.includes('watch-later-safe.js'));
assert.ok(isolated.js.includes('watch-later-safe-auto.js'));
assert.ok(isolated.js.includes('pc-inline-controls.js'));
assert.ok(isolated.js.includes('pc-spa-lifecycle.js'));
assert.doesNotMatch(backgroundEntry, /pc-update-reconnect/,
  'extension updates must never auto-reload an active YouTube playback tab');
assert.equal(manifest.version, '0.10.18');

console.log('PASS watch-later core + fail-closed safe path + v0.10.18 no-auto-reload contract');
