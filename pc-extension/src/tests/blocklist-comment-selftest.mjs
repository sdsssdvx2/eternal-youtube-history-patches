import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const read = name => fs.readFileSync(path.join(src, name), 'utf8');

// ---------------- Block list core ----------------
vm.runInThisContext(read('blocklist-core.js'));
const BL = globalThis.EYHBlocklistCore;
assert.ok(BL, 'block list core must load');

const empty = BL.compile({});
assert.equal(empty.active, false);
assert.equal(empty.match({ title: 'anything', channelName: 'x' }), null);

const bl = BL.compile({
  channels: [
    '@SpoilerChan', 'UCabcdefghijklmnopqrstuv', 'https://www.youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz',
    'https://www.youtube.com/@LinkHandle/videos', '정확한 채널', '# comment', '', '@spoilerchan'
  ],
  keywords: ['스포일러', 'Ｒｅａｃｔｉｏｎ', '/\\bmukbang\\b/', '/[unclosed/']
});
assert.equal(bl.active, true);
assert.equal(bl.counts.channels, 5, 'duplicate/comment/blank lines are dropped');
assert.equal(bl.counts.keywords, 3, 'invalid regex is reported, not compiled');
assert.equal(bl.errors.length, 1);
assert.equal(bl.match({ channelHref: '/@spoilerchan' })?.kind, 'channel', 'handle match is case-insensitive');
assert.equal(bl.match({ channelHref: '/channel/UCabcdefghijklmnopqrstuv' })?.kind, 'channel');
assert.equal(bl.match({ channelHref: 'https://www.youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz' })?.kind, 'channel');
assert.equal(bl.match({ channelHref: '/@LinkHandle' })?.kind, 'channel');
assert.equal(bl.match({ channelName: '  정확한   채널 ' })?.kind, 'channel', 'name match is whitespace-normalized');
assert.equal(bl.match({ channelName: 'SpoilerChan' })?.kind, 'channel', 'display name equal to a blocked handle');
assert.equal(bl.match({ channelName: '정확한 채널 팬' }), null, 'channel names match exactly, not by substring');
assert.equal(bl.match({ title: '오늘 스포일러 있음' })?.kind, 'keyword');
assert.equal(bl.match({ title: 'my reaction video' })?.kind, 'keyword', 'NFKC full-width keyword matches');
assert.equal(bl.match({ title: 'MUKBANG time' })?.kind, 'regex', 'regex gets the i flag');
assert.equal(bl.match({ title: 'mukbangers' }), null);
assert.equal(bl.match({ title: 'normal', channelName: 'other', channelHref: '/@other' }), null);
assert.equal(BL.compile({ enabled: false, channels: ['@x'] }).active, false, 'disabled list is inactive');
assert.notEqual(bl.signature, BL.compile({ channels: ['@x'] }).signature);
assert.equal(BL.channelEntryFromMeta({ channelHref: '/@Foo', channelName: 'Foo' }), '@Foo');
assert.equal(BL.channelEntryFromMeta({ channelHref: '/channel/UCabcdefghijklmnopqrstuv' }), 'UCabcdefghijklmnopqrstuv');
assert.equal(BL.channelEntryFromMeta({ channelName: 'Name Only' }), 'Name Only');
assert.equal(BL.channelEntryFromMeta({}), null);
assert.deepEqual(BL.addLine(['@a'], '@A'), ['@a'], 'addLine is case-insensitive idempotent');
assert.deepEqual(BL.addLine(['@a'], '@b'), ['@a', '@b']);

// ---------------- Comment search core ----------------
vm.runInThisContext(read('comment-search-core.js'));
const CS = globalThis.EYHCommentSearchCore;
assert.ok(CS, 'comment search core must load');

const watchNext = {
  contents: { twoColumnWatchNextResults: { results: { results: { contents: [
    { videoPrimaryInfoRenderer: {} },
    { itemSectionRenderer: { sectionIdentifier: 'related-items', contents: [
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'WRONG' } } } }] } },
    { itemSectionRenderer: { sectionIdentifier: 'comment-item-section', contents: [
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'COMMENTS_1' } } } }] } }
  ] } } } }
};
assert.equal(CS.initialCommentsToken(watchNext), 'COMMENTS_1');
assert.equal(CS.initialCommentsToken({ engagementPanels: [{ engagementPanelSectionListRenderer: {
  panelIdentifier: 'engagement-panel-comments-section',
  content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'PANEL_TOKEN' } } } }] } }] } }
} }] }), 'PANEL_TOKEN');
assert.equal(CS.initialCommentsToken({}), null);

// 2024+ view-model shape
const page1 = {
  onResponseReceivedEndpoints: [
    { reloadContinuationItemsCommand: { continuationItems: [
      { commentsHeaderRenderer: { countText: { runs: [{ text: '댓글 ' }, { text: '1,234' }, { text: '개' }] } } }
    ] } },
    { reloadContinuationItemsCommand: { continuationItems: [
      { commentThreadRenderer: {
        commentViewModel: { commentViewModel: { commentKey: 'K1' } },
        replies: { commentRepliesRenderer: { contents: [
          { continuationItemRenderer: { button: { buttonRenderer: { command: { continuationCommand: { token: 'REPLIES_1' } } } } } }] } }
      } },
      { commentThreadRenderer: { commentViewModel: { commentViewModel: { commentKey: 'K2' } } } },
      { commentThreadRenderer: { commentViewModel: { commentViewModel: { commentKey: 'MISSING' } } } },
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'NEXT_2' } } } }
    ] } }
  ],
  frameworkUpdates: { entityBatchUpdate: { mutations: [
    { entityKey: 'K1', payload: { commentEntityPayload: {
      properties: { commentId: 'Ugx1', content: { content: '3:15 여기 명장면 ㅋㅋ' }, publishedTime: '1일 전', replyLevel: 0 },
      author: { displayName: '@viewerOne', channelId: 'UC1' },
      toolbar: { likeCountNotliked: '1.2천', replyCount: '3' } } } },
    { entityKey: 'K2', payload: { commentEntityPayload: {
      properties: { commentId: 'Ugx2', content: { content: 'Great SONG' }, publishedTime: '2일 전' },
      author: { displayName: '@two' }, toolbar: { likeCountNotliked: '' } } } }
  ] } }
};
const p1 = CS.parseCommentsPage(page1);
assert.equal(p1.comments.length, 2, 'threads without an entity payload are skipped');
assert.deepEqual(p1.comments.map(c => c.id), ['Ugx1', 'Ugx2']);
assert.equal(p1.comments[0].author, '@viewerOne');
assert.equal(p1.comments[0].likes, '1.2천');
assert.equal(p1.comments[0].replies, 3);
assert.equal(p1.next, 'NEXT_2');
assert.deepEqual(p1.replyTokens, ['REPLIES_1']);
assert.equal(p1.totalText, '댓글 1,234개');

// legacy commentRenderer shape + reply page
const legacy = CS.parseCommentsPage({ onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
  { commentRenderer: { commentId: 'R1', authorText: { simpleText: 'Old Author' }, contentText: { runs: [{ text: 'reply ' }, { text: 'text' }] },
    voteCount: { simpleText: '5' }, publishedTimeText: { runs: [{ text: '3년 전' }] } } }
] } }] }, { isReplyPage: true });
assert.equal(legacy.comments.length, 1);
assert.equal(legacy.comments[0].text, 'reply text');
assert.equal(legacy.comments[0].isReply, true);
assert.equal(legacy.next, null);
assert.deepEqual(CS.parseCommentsPage(null).comments, [], 'unknown shapes fail soft');

const all = [...p1.comments, ...legacy.comments];
assert.deepEqual(CS.searchComments(all, '명장면').map(c => c.id), ['Ugx1']);
assert.deepEqual(CS.searchComments(all, 'great song').map(c => c.id), ['Ugx2'], 'case-insensitive');
assert.deepEqual(CS.searchComments(all, 'reply old').map(c => c.id), ['R1'], 'AND terms across text and author');
assert.deepEqual(CS.searchComments(all, '"text reply"'), [], 'quoted phrase must match in order');
assert.deepEqual(CS.searchComments(all, '"reply text"').map(c => c.id), ['R1']);
assert.deepEqual(CS.searchComments(all, '   '), []);
assert.deepEqual(CS.highlightRanges('Great SONG great', 'great'), [[0, 5], [11, 16]]);
assert.deepEqual(CS.highlightRanges('abc', ''), []);

// ---------------- Static wiring contracts ----------------
const manifest = JSON.parse(read('manifest.json'));
const mainWorld = manifest.content_scripts.find(cs => cs.world === 'MAIN');
const isolated = manifest.content_scripts.find(cs => cs.world === 'ISOLATED');
assert.ok(manifest.permissions.includes('contextMenus'));
assert.ok(mainWorld.js.indexOf('comment-search-core.js') < mainWorld.js.indexOf('comment-search-main.js'));
assert.ok(isolated.js.indexOf('blocklist-core.js') < isolated.js.indexOf('content.js'), 'block core loads before the renderer');
assert.ok(isolated.js.indexOf('comment-search-core.js') < isolated.js.indexOf('comment-search.js'));
const commentUi = read('comment-search.js');
const commentMain = read('comment-search-main.js');
assert.doesNotMatch(commentUi, /MutationObserver|innerHTML/, 'comment UI must not add a DOM observer or HTML injection');
assert.doesNotMatch(commentMain, /edit_playlist|SAPISID|Authorization/, 'comment bridge is read-only and unauthenticated');
const content = read('content.js');
assert.match(content, /const boundVideoEls = new WeakSet\(\)/, 'video listeners are bound once per element');
assert.match(content, /boundVideoEls\.has\(el\)/);
assert.match(content, /function adPlaying\(\)/, 'ad playback must never be recorded as main-video progress');
assert.doesNotMatch(content, /await chrome\.storage\.local\.get\(\{ directWatchSeconds: 5 \}\)/, 'no storage read per timeupdate');
assert.match(content, /classList\.toggle\('eyh-blocked'/);
const background = read('background.js');
assert.match(background, /function deleteOutboxEntries/, 'outbox delete must not drop re-queued keys');
assert.match(background, /current\.token === entry\.token/);
assert.doesNotMatch(background, /deleteOutboxKeys\(entries\.map/);
const options = read('options.js');
assert.doesNotMatch(options, /active: true, currentWindow: true/, 'diagnostics must not target the options tab itself');
const css = read('content.css');
assert.match(css, /yt-lockup-view-model\.eyh-blocked/);

console.log('PASS block list core + comment search core + v0.11 wiring contracts');
