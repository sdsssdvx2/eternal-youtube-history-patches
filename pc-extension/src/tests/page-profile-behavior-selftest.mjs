import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const controller = fs.readFileSync(path.join(src, 'pc-stability-controller.js'), 'utf8');

const clone = value => JSON.parse(JSON.stringify(value));
const defaultProfile = {
  dimEnabled: true,
  hideEnabled: false,
  linkedThresholds: false,
  sharedThreshold: 0,
  dimThreshold: 25,
  hideThreshold: 70
};
const playlistProfile = {
  dimEnabled: true,
  hideEnabled: false,
  linkedThresholds: false,
  sharedThreshold: 0,
  dimThreshold: 15,
  hideThreshold: 80
};
const watchProfile = {
  dimEnabled: true,
  hideEnabled: false,
  linkedThresholds: false,
  sharedThreshold: 0,
  dimThreshold: 20,
  hideThreshold: 75
};

const storageState = {
  watchedDisplayMode: 'dim',
  watchedMinProgressPct: 30,
  watchedSurfaceDefaultProfile: clone(defaultProfile),
  watchedSurfaceProfiles: {
    playlist_detail: clone(playlistProfile),
    watch: clone(watchProfile)
  },
  watchLaterAutoCleanupEnabled: false
};
const storageWrites = [];
const presentations = [];
const windowListeners = new Map();
const documentListeners = new Map();
let timerId = 0;

function addListener(map, type, fn) {
  const list = map.get(type) || [];
  list.push(fn);
  map.set(type, list);
}
function dispatch(map, type) {
  for (const fn of map.get(type) || []) fn({ type });
}

const context = vm.createContext({
  console,
  URLSearchParams,
  location: { pathname: '/playlist', search: '?list=PL_TEST' },
  setTimeout(fn) {
    fn();
    return ++timerId;
  },
  clearTimeout() {},
  document: {
    visibilityState: 'visible',
    querySelector() { return null; },
    addEventListener(type, fn) { addListener(documentListeners, type, fn); }
  },
  window: {
    addEventListener(type, fn) { addListener(windowListeners, type, fn); }
  },
  chrome: {
    runtime: { id: 'eternal-behavior-test' },
    storage: {
      local: {
        async get(defaults = {}) {
          return clone({ ...defaults, ...storageState });
        },
        async set(values) {
          const copied = clone(values);
          storageWrites.push(copied);
          Object.assign(storageState, copied);
        }
      },
      onChanged: {
        addListener(fn) { addListener(documentListeners, 'storage-onChanged', fn); }
      }
    }
  },
  EYHApplySurfacePresentation(presentation) {
    presentations.push(clone(presentation));
  }
});

vm.runInContext(controller, context, { filename: 'pc-stability-controller.js' });

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
};

await flush();
assert.deepEqual(presentations.at(-1), { mode: 'dim', threshold: 15 },
  'playlist route must resolve its own profile before any interaction');

const choose = context.EYHChooseSurfaceMode;
assert.equal(typeof choose, 'function', 'controller must expose the tab-local quick-mode entry point');

const writesBeforeHide = storageWrites.length;
choose('hide');
assert.deepEqual(presentations.at(-1), { mode: 'hide', threshold: 80 },
  'hide must repaint synchronously using the already-resolved playlist hide threshold');
assert.equal(storageWrites.length, writesBeforeHide,
  'immediate hide feedback must not wait for or synchronously perform storage persistence');

await flush();
assert.equal(storageState.watchedDisplayMode, 'dim',
  'page-specific mode must never overwrite the shared legacy display mode');
assert.equal(storageState.watchedMinProgressPct, 30,
  'page-specific mode must never overwrite the shared legacy threshold');
assert.equal(storageState.watchedSurfaceProfiles.playlist_detail.hideEnabled, true,
  'playlist override must persist as hide');
assert.equal(storageState.watchedSurfaceProfiles.playlist_detail.dimEnabled, false,
  'playlist override must disable dim when hide is selected');
assert.deepEqual(storageState.watchedSurfaceProfiles.watch, watchProfile,
  'playlist changes must not mutate the watch-page profile');

context.location.pathname = '/watch';
context.location.search = '?v=abcdefghijk';
dispatch(windowListeners, 'yt-navigate-finish');
await flush();
assert.deepEqual(presentations.at(-1), { mode: 'dim', threshold: 20 },
  'SPA navigation to watch must restore the watch profile instead of inheriting playlist hide');

context.location.pathname = '/playlist';
context.location.search = '?list=PL_TEST';
dispatch(windowListeners, 'yt-navigate-finish');
await flush();
assert.deepEqual(presentations.at(-1), { mode: 'hide', threshold: 80 },
  'returning to playlist must restore its persisted hide profile');

context.location.pathname = '/shorts/abcdefghijk';
context.location.search = '';
dispatch(windowListeners, 'yt-navigate-finish');
await flush();
assert.deepEqual(presentations.at(-1), { mode: 'none', threshold: 0 },
  'Shorts must fail open with no watched presentation');
const shortsPresentationCount = presentations.length;
const shortsWriteCount = storageWrites.length;
choose('hide');
await flush();
assert.equal(presentations.length, shortsPresentationCount,
  'quick-mode input on Shorts must be ignored');
assert.equal(storageWrites.length, shortsWriteCount,
  'Shorts must not persist a page presentation override');

for (const write of storageWrites) {
  assert.ok(!Object.hasOwn(write, 'watchedDisplayMode'),
    'surface persistence must never write the shared watchedDisplayMode key');
  assert.ok(!Object.hasOwn(write, 'watchedMinProgressPct'),
    'surface persistence must never write the shared watchedMinProgressPct key');
}

console.log('PASS v0.10.18 behavioral acceptance: immediate repaint + SPA surface isolation + Shorts fail-open');
