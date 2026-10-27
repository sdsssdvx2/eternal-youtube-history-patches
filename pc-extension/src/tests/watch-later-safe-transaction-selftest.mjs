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
assert.equal(core.SCHEMA, 2, 'v0.10.5 transaction schema must mark pre-request attempting state');

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

assert.equal(core.sameSnapshotMembership(entries, [...entries].reverse()), true,
  'snapshot equality should ignore harmless ordering changes');
assert.equal(core.sameSnapshotMembership(entries, [
  entries[0], entries[1], { videoId: 'CCCCCCCCCCC', setVideoId: 'SET_CHANGED' }
]), false, 'snapshot equality must reject videoId/setVideoId membership changes');

assert.deepEqual(core.paginationDecision([], [], { pages: 1, added: 3, maxPages: 250 }), {
  complete: true,
  next: null,
  terminalReason: 'no-continuation'
});
assert.deepEqual(core.paginationDecision(['TOKEN_NEXT_0001'], [], { pages: 1, added: 3, maxPages: 250 }), {
  complete: false,
  next: 'TOKEN_NEXT_0001',
  terminalReason: null
});
assert.throws(() => core.paginationDecision(['TOKEN_REPEAT_01'], ['TOKEN_REPEAT_01'], {
  pages: 2, added: 2, maxPages: 250
}), /반복/);
assert.throws(() => core.paginationDecision(['TOKEN_A_0001', 'TOKEN_B_0002'], [], {
  pages: 1, added: 2, maxPages: 250
}), /둘 이상/);
assert.throws(() => core.paginationDecision(['TOKEN_NEXT_0001'], [], {
  pages: 2, added: 0, maxPages: 250
}), /새 항목이 없어/);
assert.throws(() => core.paginationDecision(['TOKEN_NEXT_0001'], [], {
  pages: 250, added: 1, maxPages: 250
}), /페이지 한도/);

const before = core.canonicalForDigest(tx);
tx.declaredCount = 3;
const withCount = core.canonicalForDigest(tx);
assert.notEqual(before, withCount, 'schema-2 digest must bind the independent visible count');
tx.candidates[0].status = 'removed';
const after = core.canonicalForDigest(tx);
assert.notEqual(withCount, after, 'journal digest payload must change with destructive result state');
core.recalcCounts(tx);
assert.equal(tx.removedCount, 1);
assert.equal(tx.failureCount, 0);
tx.candidates[1].status = 'identity_mismatch';
core.recalcCounts(tx);
assert.equal(tx.failureCount, 1);

assert.deepEqual(core.undoVideoIds(tx), ['AAAAAAAAAAA'],
  'schema-2 rollback must not re-add identity-mismatch items that were never removed');
tx.candidates[1].status = 'attempting';
assert.deepEqual(core.undoVideoIds(tx), ['AAAAAAAAAAA', 'CCCCCCCCCCC'],
  'an in-flight attempting item is intentionally rollback-eligible');
tx.candidates[0].undoStatus = 'restored';
assert.deepEqual(core.undoVideoIds(tx), ['CCCCCCCCCCC'],
  'already restored items should not be retried during partial undo recovery');
tx.candidates[1].undoStatus = 'already_present';
core.recalcCounts(tx);
assert.equal(tx.undoRestoredCount, 2);
assert.equal(tx.undoFailureCount, 0);
assert.deepEqual(core.undoVideoIds(tx), []);

const legacy = {
  schema: 1,
  candidates: [
    { videoId: 'AAAAAAAAAAA', status: 'prepared', undoStatus: 'pending' },
    { videoId: 'CCCCCCCCCCC', status: 'identity_mismatch', undoStatus: 'pending' }
  ]
};
assert.deepEqual(core.undoVideoIds(legacy), ['AAAAAAAAAAA', 'CCCCCCCCCCC'],
  'v0.10.4 schema-1 journals need broad rollback because pre-request attempting was not persisted');

console.log('PASS Watch Later safe transaction core self-test');
