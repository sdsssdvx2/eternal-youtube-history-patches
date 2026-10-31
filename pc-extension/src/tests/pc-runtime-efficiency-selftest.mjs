import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const text = name => fs.readFileSync(path.join(src, name), 'utf8');
const content = text('content.js');
const spa = text('pc-spa-lifecycle.js');
const manifest = JSON.parse(text('manifest.json'));

assert.equal(manifest.version, '0.10.14');

// Playback hot path: settings are cached. timeupdate/playing must not perform storage IPC.
assert.match(content, /let directWatchSeconds = 5/);
assert.match(content, /directWatchSeconds = Math\.max\(1, Math\.min\(120,/);
const bindStart = content.indexOf('async function bindVideoWatcher()');
const bindEnd = content.indexOf('function idFromAnchor', bindStart);
assert.ok(bindStart >= 0 && bindEnd > bindStart, 'video watcher block not found');
const bindBlock = content.slice(bindStart, bindEnd);
assert.doesNotMatch(bindBlock, /chrome\.storage\.local\.get/,
  'playback events must not query extension storage');
assert.match(bindBlock, /Number\(el\.currentTime \|\| 0\) >= directWatchSeconds/);

// YouTube reuses media elements across SPA videos. Old listeners must be explicitly detached.
assert.match(content, /let currentVideoHandlers = null/);
assert.match(content, /function unbindVideoWatcher\(\)/);
for (const eventName of ['timeupdate', 'playing', 'ended']) {
  assert.match(content, new RegExp(`removeEventListener\\('${eventName}'`),
    `missing ${eventName} listener cleanup`);
}
assert.match(bindBlock, /unbindVideoWatcher\(\);[\s\S]*currentVideoHandlers = \{ onTime, onEnded \}/,
  'rebinding must detach the previous media handlers first');

// Presentation changes can reuse ledger data; only true data refresh paths may clear the caches.
const storageListenerStart = content.indexOf("chrome.storage.onChanged.addListener");
const observerStart = content.indexOf('const observer = new MutationObserver', storageListenerStart);
assert.ok(storageListenerStart >= 0 && observerStart > storageListenerStart);
const storageListener = content.slice(storageListenerStart, observerStart);
assert.match(storageListener, /changes\.directWatchSeconds/);
assert.doesNotMatch(storageListener, /watchedCache\.clear\(\)|progressCache\.clear\(\)/,
  'presentation settings must not invalidate watched/progress ledger caches');

// Mutation bursts schedule one debounced scan; scanAndMark owns media rebinding.
const observerEnd = content.indexOf('observer.observe', observerStart);
const observerBlock = content.slice(observerStart, observerEnd);
assert.match(observerBlock, /scheduleScan\(\)/);
assert.doesNotMatch(observerBlock, /bindVideoWatcher\(/,
  'MutationObserver must not query the video element separately on every DOM burst');
assert.match(content, /const needsNativeProgress = watchedMinProgressPct > 0/,
  'native progress/layout probing should be skipped when it cannot affect threshold matching');

// pc-stability-controller owns visible quick-mode state after startup.
assert.match(content, /dataset\.eyhProfileController !== '1'/);

// SPA watchdog is adaptive and sleeping while hidden, not a permanent 500ms interval.
assert.match(spa, /FAST_HEARTBEAT_MS = 500/);
assert.match(spa, /STEADY_HEARTBEAT_MS = 2500/);
assert.match(spa, /FAST_WINDOW_MS = 12_000/);
assert.match(spa, /document\.visibilityState !== 'visible'/);
assert.match(spa, /setTimeout\(tick, nextDelay\)/);
assert.doesNotMatch(spa, /setInterval\(/);
assert.doesNotMatch(spa, /MutationObserver|querySelectorAll|chrome\.storage/,
  'SPA watchdog must remain O(1) and storage-free');

console.log('PASS PC v0.10.14 long-session runtime efficiency contract');
