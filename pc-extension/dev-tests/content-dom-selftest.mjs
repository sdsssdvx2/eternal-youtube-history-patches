// Optional DOM behaviour test for the resident card renderer, block list and comment search.
// Needs jsdom, which is NOT a repository dependency (CI keeps running the zero-dependency
// self-tests in src/tests). Run locally:
//   npm install --prefix /tmp/jsd jsdom@25
//   JSDOM_DIR=/tmp/jsd node pc-extension/dev-tests/content-dom-selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../src');
const read = name => fs.readFileSync(path.join(src, name), 'utf8');
let JSDOM;
try {
  const require = createRequire(path.join(process.env.JSDOM_DIR || here, 'noop.js'));
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('SKIP content DOM self-test (jsdom not installed; set JSDOM_DIR)');
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Let pending throttled scans finish before tearing the window down.
const observerSafeClose = window => setTimeout(() => window.close(), 1500);

function makeChrome(store, ledger, sent) {
  const listeners = { storage: [], runtime: [] };
  return {
    listeners,
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '0.11.1' }),
      sendMessage: async msg => {
        sent.push(msg);
        if (msg.type === 'CHECK_WATCHED') {
          const watched = {}, progress = {};
          for (const id of msg.ids) { watched[id] = id in ledger; progress[id] = ledger[id] ?? null; }
          return { watched, progress };
        }
        return { ok: true };
      },
      onMessage: { addListener: fn => listeners.runtime.push(fn) }
    },
    storage: {
      local: {
        get: async defaults => {
          const out = {};
          if (Array.isArray(defaults)) { for (const k of defaults) out[k] = store[k]; return out; }
          for (const [k, v] of Object.entries(defaults || {})) out[k] = k in store ? structuredClone(store[k]) : v;
          return out;
        },
        set: async values => {
          const changes = {};
          for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = structuredClone(v); }
          for (const fn of listeners.storage) fn(changes, 'local');
        }
      },
      onChanged: { addListener: fn => listeners.storage.push(fn) }
    }
  };
}

function card(doc, { id, title, channel, handle }) {
  const root = doc.createElement('ytd-rich-item-renderer');
  root.innerHTML = `<ytd-thumbnail><a id="thumbnail" href="/watch?v=${id}"><img></a></ytd-thumbnail>
    <div id="details"><h3><a id="video-title-link" href="/watch?v=${id}" title="${title}"><span id="video-title">${title}</span></a></h3>
    <ytd-channel-name><a href="/${handle}">${channel}</a></ytd-channel-name></div>`;
  return root;
}

// ---------------- Card renderer + block list ----------------
{
  const dom = new JSDOM(`<!doctype html><html><body><ytd-masthead><div id="end"></div></ytd-masthead><div id="grid"></div>
    <div class="html5-video-player" id="movie_player"><video class="html5-main-video"></video></div></body></html>`,
  { url: 'https://www.youtube.com/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const store = {
    watchedSurfaceDefaultProfile: { dimEnabled: true, hideEnabled: false, linkedThresholds: true, sharedThreshold: 0, dimThreshold: 0, hideThreshold: 0 },
    eyhBlockChannels: ['@blocked'], eyhBlockKeywords: ['스포일러'], directWatchSeconds: 5
  };
  const ledger = { AAAAAAAAAAA: 80, BBBBBBBBBBB: 10 };
  const sent = [];
  const chrome = makeChrome(store, ledger, sent);
  window.chrome = chrome;
  window.crypto.randomUUID ??= () => Math.random().toString(36).slice(2);

  // Count listener registrations on the shared <video> element.
  const video = window.document.querySelector('video');
  let timeupdateListeners = 0;
  const origAdd = video.addEventListener.bind(video);
  video.addEventListener = (type, fn, opts) => { if (type === 'timeupdate') timeupdateListeners += 1; return origAdd(type, fn, opts); };

  const grid = window.document.getElementById('grid');
  grid.append(
    card(window.document, { id: 'AAAAAAAAAAA', title: 'watched one', channel: 'Good', handle: '@good' }),
    card(window.document, { id: 'BBBBBBBBBBB', title: 'barely watched', channel: 'Good', handle: '@good' }),
    card(window.document, { id: 'CCCCCCCCCCC', title: 'from blocked channel', channel: 'Bad', handle: '@blocked' }),
    card(window.document, { id: 'DDDDDDDDDDD', title: '오늘의 스포일러', channel: 'Good', handle: '@good' })
  );
  // Live search results (2026-11-15): a Shorts tile is ytm-shorts-lockup-view-model-v2 > ytm-shorts-lockup-view-model.
  const shorts = window.document.createElement('ytm-shorts-lockup-view-model-v2');
  shorts.innerHTML = `<ytm-shorts-lockup-view-model><a href="/shorts/EEEEEEEEEEE"><img></a>
    <h3><a href="/shorts/EEEEEEEEEEE"><span>스포일러 쇼츠</span></a></h3></ytm-shorts-lockup-view-model>`;
  grid.append(shorts);
  for (const f of ['watch-later-core.js', 'blocklist-core.js', 'content.js']) window.eval(read(f));
  await sleep(900);

  const roots = [...grid.children];
  const thumbOf = r => r.querySelector('ytd-thumbnail');
  assert.ok(thumbOf(roots[0]).classList.contains('eyh-watched') || roots[0].querySelector('.eyh-watched'), 'watched card is dimmed');
  assert.ok(roots[1].querySelector('.eyh-watched'), '0% threshold dims any ledger record');
  assert.ok(!roots[0].classList.contains('eyh-blocked'));
  assert.ok(roots[2].classList.contains('eyh-blocked'), 'blocked channel card is hidden');
  assert.ok(roots[3].classList.contains('eyh-blocked'), 'keyword card is hidden');
  assert.ok(shorts.classList.contains('eyh-blocked'), 'the outer Shorts wrapper is hidden, not only the inner lockup');
  assert.ok(!shorts.querySelector('ytm-shorts-lockup-view-model').classList.contains('eyh-blocked'));
  assert.ok(window.document.querySelector('#eyh-header-controls'), 'masthead controls mounted');

  // Display threshold change → repaint only matching cards.
  await chrome.storage.local.set({ watchedSurfaceDefaultProfile: { ...store.watchedSurfaceDefaultProfile, sharedThreshold: 50 } });
  await sleep(300);
  assert.ok(roots[0].querySelector('.eyh-watched'), '80% still dimmed at 50% threshold');
  assert.ok(!roots[1].querySelector('.eyh-watched'), '10% no longer dimmed at 50% threshold');

  // Framework rewrote class attribute → renderer must restore on next scan despite its cache.
  const dimmedEl = roots[0].querySelector('.eyh-watched');
  dimmedEl.className = '';
  grid.append(window.document.createElement('div'));
  await sleep(900);
  assert.ok(dimmedEl.classList.contains('eyh-watched'), 'class rewrite is repaired');

  // Removing the block entry unhides.
  await chrome.storage.local.set({ eyhBlockChannels: [] });
  await sleep(300);
  assert.ok(!roots[2].classList.contains('eyh-blocked'), 'unblocked channel card is visible again');
  assert.ok(roots[3].classList.contains('eyh-blocked'), 'keyword block remains');

  // Same <video> reused across SPA navigations: exactly one timeupdate listener.
  for (const v of ['EEEEEEEEEEE', 'FFFFFFFFFFF', 'GGGGGGGGGGG']) {
    window.history.pushState({}, '', `/watch?v=${v}`);
    window.dispatchEvent(new window.Event('yt-navigate-finish'));
    await sleep(50);
  }
  assert.equal(timeupdateListeners, 1, 'video listeners are not re-bound per navigation');

  // Ad playback must not record a watch or progress.
  Object.defineProperty(video, 'duration', { configurable: true, get: () => 15 });
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 14 });
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
  window.document.getElementById('movie_player').classList.add('ad-showing');
  sent.length = 0;
  video.dispatchEvent(new window.Event('timeupdate'));
  await sleep(50);
  assert.equal(sent.filter(m => m.type === 'UPSERT_WATCH' || m.type === 'UPDATE_PROGRESS').length, 0, 'ad time is ignored');
  window.document.getElementById('movie_player').classList.remove('ad-showing');
  Object.defineProperty(video, 'duration', { configurable: true, get: () => 100 });
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 30 });
  video.dispatchEvent(new window.Event('timeupdate'));
  await sleep(50);
  assert.equal(sent.filter(m => m.type === 'UPSERT_WATCH').length, 1, 'main video records once after threshold');
  video.dispatchEvent(new window.Event('timeupdate'));
  await sleep(50);
  assert.equal(sent.filter(m => m.type === 'UPSERT_WATCH').length, 1, 'no duplicate watch event');

  // Right-click block flow.
  window.confirm = () => true;
  window.alert = () => {};
  const target = roots[1].querySelector('#video-title');
  target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  const handler = chrome.listeners.runtime[0];
  const reply = await new Promise(resolve => handler({ type: 'EYH_BLOCK_CONTEXT_TARGET', linkUrl: '' }, {}, resolve));
  assert.equal(reply.ok, true);
  assert.deepEqual(store.eyhBlockChannels, ['@good'], 'context-menu block stores the card channel handle');
  await sleep(700);
  // (window left open: closing jsdom with pending renderer timers only produces teardown noise)
}

// ---------------- Comment search (UI + MAIN bridge with mocked InnerTube) ----------------
{
  const dom = new JSDOM(`<!doctype html><html><body><ytd-masthead><div id="end"><div id="eyh-header-controls"><span id="eyh-header-status"></span></div></div></ytd-masthead></body></html>`,
    { url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  window.chrome = makeChrome({}, {}, []);
  window.crypto.randomUUID ??= () => Math.random().toString(36).slice(2);
  window.CSS ??= { escape: s => s };
  // jsdom's postMessage does not set event.source; YouTube/Chrome do (same window).
  window.postMessage = data => setTimeout(() => {
    const ev = new window.MessageEvent('message', { data });
    Object.defineProperty(ev, 'source', { value: window });
    window.dispatchEvent(ev);
  }, 0);
  const calls = [];
  const page = (items, next) => ({
    onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
      ...items.map(([id, text]) => ({ commentRenderer: { commentId: id, authorText: { simpleText: 'a' }, contentText: { runs: [{ text }] } } })),
      ...(next ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: next } } } }] : [])
    ] } }]
  });
  window.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    let json;
    if (body.videoId) json = { contents: { twoColumnWatchNextResults: { results: { results: { contents: [
      { itemSectionRenderer: { sectionIdentifier: 'comment-item-section', contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'T1' } } } }] } }] } } } } };
    else if (body.continuation === 'T1') json = page([['c1', '첫 댓글'], ['c2', '노래 좋다']], 'T2');
    else json = page([['c3', '이 노래 최고'], ['c2', '노래 좋다']], null);
    return { ok: true, status: 200, json: async () => json };
  };
  for (const f of ['comment-search-core.js', 'comment-search-main.js', 'comment-search.js']) window.eval(read(f));
  await sleep(50);
  const button = window.document.getElementById('eyh-comment-search');
  assert.ok(button, '댓글 button is added on watch pages');
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(1200);
  const panel = window.document.getElementById('eyh-comment-panel');
  assert.ok(panel, 'panel opens');
  const input = panel.querySelector('.eyh-cs-input');
  input.value = '노래';
  input.dispatchEvent(new window.Event('input'));
  await sleep(150);
  const items = panel.querySelectorAll('.eyh-cs-item');
  assert.equal(items.length, 2, 'duplicate comment ids across pages are merged');
  assert.equal(panel.querySelectorAll('mark').length, 2, 'matches are highlighted with <mark>');
  assert.match(panel.querySelector('.eyh-cs-status').textContent, /2|3/);
  assert.match(panel.querySelector('.eyh-cs-status').textContent, /전부 불러옴/);
  assert.equal(calls.length, 3, 'one watch request + two continuation pages');
  window.history.pushState({}, '', '/');
  window.dispatchEvent(new window.Event('yt-navigate-finish'));
  await sleep(50);
  assert.equal(window.document.getElementById('eyh-comment-search'), null, 'button removed off watch pages');
  window.close();
}

console.log('PASS content DOM behaviour: dim/hide repaint, class-rewrite repair, block list, single video binding, ad guard, context-menu block, comment search');
process.exit(0);
