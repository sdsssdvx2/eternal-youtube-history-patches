import assert from 'node:assert/strict';
import '../watch-later-core.js';

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
console.log('PASS watch-later-core self-test');
