import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../watch-later-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const safety = fs.readFileSync(path.join(src, 'watch-later-safety-main.js'), 'utf8');
const stability = fs.readFileSync(path.join(src, 'pc-stability-controller.js'), 'utf8');
const safeCoordinator = fs.readFileSync(path.join(src, 'watch-later-safe.js'), 'utf8');
const safeAuto = fs.readFileSync(path.join(src, 'watch-later-safe-auto.js'), 'utf8');
const inlineControls = fs.readFileSync(path.join(src, 'pc-inline-controls.js'), 'utf8');
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

const modern = {
  contents: [
    {
      lockupViewModel: {
        contentId: 'modernabc12',
        metadata: { lockupMetadataViewModel: { title: { content: 'Modern row' } } },
        menu: {
          menuRenderer: {
            items: [{ menuServiceItemRenderer: { serviceEndpoint: { playlistEditEndpoint: { actions: [
              { setVideoId: 'LOCKUP_SET_001' }
            ] } } } }]
          }
        }
      }
    },
    {
      playlistVideoViewModel: {
        videoId: 'modernxyz34',
        rendererContext: { commandContext: { onTap: { innertubeCommand: { playlistEditEndpoint: {
          actions: [{ playlistSetVideoId: 'VIEWMODEL_SET_002' }]
        } } } } }
      }
    },
    {
      videoLockupViewModel: {
        videoId: 'ambiguous01',
        related: { videoId: 'ambiguous02' },
        menu: { serviceEndpoint: { setVideoId: 'AMBIG_SET_003' } }
      }
    }
  ],
  continuationContents: {
    playlistVideoListContinuation: {
      continuations: [{ nextContinuationData: { continuation: 'CONTINUATION_TOKEN_2' } }]
    }
  }
};
assert.deepEqual(C.extractPlaylistEntries(modern), [
  { videoId: 'modernabc12', setVideoId: 'LOCKUP_SET_001' },
  { videoId: 'modernxyz34', setVideoId: 'VIEWMODEL_SET_002' }
]);
assert.deepEqual(C.extractContinuationTokens(modern), ['CONTINUATION_TOKEN_2']);

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

// The emergency MAIN-world boundary remains permanent for legacy direct-delete messages. v0.10.16
// keeps only the separately journaled SAFE protocol resident; the old preference/buttons stay off.
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
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js', 'legacy safety boundary must load before page-bridge');
assert.ok(mainWorld.js.indexOf('watch-later-safety-main.js') < mainWorld.js.indexOf('watch-later-safe-core.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'));
assert.ok(isolated.js.includes('watch-later-safe-core.js'), 'transaction core must be resident for safe cleanup');
assert.ok(isolated.js.includes('watch-later-safe.js'), 'manual journaled cleanup must be resident');
assert.ok(isolated.js.includes('watch-later-safe-auto.js'), 'opt-in journaled automatic cleanup must be resident');
assert.ok(isolated.js.includes('pc-inline-controls.js'), 'working inline settings/safe cleanup UI must be resident');
assert.ok(isolated.js.includes('pc-spa-lifecycle.js'), 'missed SPA route changes must be reconciled');
assert.equal(manifest.version, '0.10.16');

console.log('PASS watch-later-core + modern lockup + legacy-blocked/safe-resident + inline-controls self-test');
