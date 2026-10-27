import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
vm.runInThisContext(fs.readFileSync(path.join(src, 'watch-later-recovery-core.js'), 'utf8'));
const core = globalThis.EYHWatchLaterRecoveryCore;
assert.ok(core, 'recovery evidence core must load');

const good = core.parseHistoryItem({
  url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA&list=WL&index=4',
  title: 'Alpha title - YouTube',
  lastVisitTime: 1234
});
assert.deepEqual(good, {
  videoId: 'AAAAAAAAAAA',
  title: 'Alpha title',
  lastVisitTime: 1234,
  evidenceCount: 1
});

assert.equal(core.parseHistoryItem({
  url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', title: 'not WL'
}), null, 'plain watch history is not Watch Later evidence');
assert.equal(core.parseHistoryItem({
  url: 'https://evil.example/watch?v=AAAAAAAAAAA&list=WL'
}), null, 'non-YouTube URL must never become recovery evidence');
assert.equal(core.parseHistoryItem({
  url: 'https://www.youtube.com/watch?v=bad&list=WL'
}), null, 'invalid videoId must be rejected');

const evidence = core.collectEvidence([
  { url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA&list=WL&index=1', title: 'Alpha old - YouTube', lastVisitTime: 100 },
  { url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA&list=WL&index=9', title: 'Alpha new - YouTube', lastVisitTime: 300 },
  { url: 'https://m.youtube.com/watch?v=BBBBBBBBBBB&list=WL', title: 'Beta - YouTube', lastVisitTime: 200 },
  { url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', title: 'No WL', lastVisitTime: 999 }
]);
assert.equal(evidence.length, 2);
assert.equal(evidence[0].videoId, 'AAAAAAAAAAA');
assert.equal(evidence[0].title, 'Alpha new');
assert.equal(evidence[0].evidenceCount, 2);
assert.equal(evidence[1].videoId, 'BBBBBBBBBBB');

const candidates = core.buildRecoveryCandidates(
  evidence,
  [{ videoId: 'AAAAAAAAAAA', setVideoId: 'SET_A' }],
  { BBBBBBBBBBB: 42.25 }
);
assert.deepEqual(candidates, [{
  videoId: 'BBBBBBBBBBB',
  title: 'Beta',
  lastVisitTime: 200,
  evidenceCount: 1,
  progressPct: 42.25
}]);

assert.deepEqual(core.buildRecoveryCandidates(evidence, ['AAAAAAAAAAA', 'BBBBBBBBBBB']), [],
  'videos still present in Watch Later must never be offered as recovery candidates');

console.log('PASS Watch Later recovery evidence core self-test');
