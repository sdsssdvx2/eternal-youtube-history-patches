import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
vm.runInThisContext(fs.readFileSync(path.join(src, 'watch-later-safe-core.js'), 'utf8'));
const core = globalThis.EYHWatchLaterSafeCore;
assert.ok(core, 'safe transaction core must load');

const entries = [
  { videoId: 'AAAAAAAAAAA', setVideoId: 'SET_A' },
  { videoId: 'BBBBBBBBBBB', setVideoId: 'SET_B' },
  { videoId: 'CCCCCCCCCCC', setVideoId: 'SET_C' }
];
const tx = core.buildTransaction({
  id: 'pcwl:test-transaction',
  now: 123456789,
  entries,
  progressById: { AAAAAAAAAAA: 96.5, BBBBBBBBBBB: 89.9, CCCCCCCCCCC: 100 },
  cleanupThreshold: 90,
  pages: 2,
  hasMore: false
});
assert.equal(tx.snapshot.length, 3);
assert.deepEqual(tx.candidates.map(x => x.videoId), ['AAAAAAAAAAA', 'CCCCCCCCCCC']);
assert.equal(tx.candidates[0].status, 'prepared');
assert.equal(tx.threshold, 90);
assert.equal(tx.state, 'prepared');

assert.throws(() => core.buildTransaction({
  id: 'bad-more', entries, progressById: {}, cleanupThreshold: 90, hasMore: true
}), /끝까지 읽지 못해/);
assert.throws(() => core.normalizeSnapshot([
  { videoId: 'AAAAAAAAAAA', setVideoId: 'SET_A' },
  { videoId: 'AAAAAAAAAAA', setVideoId: 'SET_OTHER' }
]), /setVideoId가 둘 이상/);
assert.throws(() => core.normalizeSnapshot([
  { videoId: 'AAAAAAAAAAA', setVideoId: 'SET_SAME' },
  { videoId: 'BBBBBBBBBBB', setVideoId: 'SET_SAME' }
]), /서로 다른 videoId/);
assert.throws(() => core.normalizeSnapshot(entries, 2), /안전 한도 2개/);
assert.throws(() => core.normalizeSnapshot([{ videoId: 'bad', setVideoId: 'SET_A' }]), /식별자가 모호/);

const before = core.canonicalForDigest(tx);
tx.candidates[0].status = 'removed';
const after = core.canonicalForDigest(tx);
assert.notEqual(before, after, 'journal digest payload must change with destructive result state');
core.recalcCounts(tx);
assert.equal(tx.removedCount, 1);
assert.equal(tx.failureCount, 0);
tx.candidates[1].status = 'identity_mismatch';
core.recalcCounts(tx);
assert.equal(tx.failureCount, 1);

assert.deepEqual(core.undoVideoIds(tx), ['AAAAAAAAAAA', 'CCCCCCCCCCC']);
tx.candidates[0].undoStatus = 'restored';
tx.candidates[1].undoStatus = 'already_present';
core.recalcCounts(tx);
assert.equal(tx.undoRestoredCount, 2);
assert.equal(tx.undoFailureCount, 0);

console.log('PASS Watch Later safe transaction core self-test');
