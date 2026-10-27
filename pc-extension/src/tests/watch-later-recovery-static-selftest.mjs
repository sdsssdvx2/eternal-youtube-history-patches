import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const text = name => fs.readFileSync(path.join(src, name), 'utf8');
const manifest = JSON.parse(text('manifest.json'));
const main = text('watch-later-recovery-main.js');
const content = text('watch-later-recovery-content.js');
const recovery = text('recovery.js');
const recoveryHtml = text('recovery.html');
const popup = text('popup.js');
const popupHtml = text('popup.html');

assert.equal(manifest.version, '0.10.7');
assert.deepEqual(manifest.optional_permissions, ['history'], 'history must remain optional, never install-time required');
assert.ok(!manifest.permissions.includes('history'), 'history must not be a permanent required permission');
const mainWorld = manifest.content_scripts.find(cs => cs.world === 'MAIN');
const isolated = manifest.content_scripts.find(cs => cs.world === 'ISOLATED');
assert.ok(mainWorld.js.includes('watch-later-recovery-main.js'));
assert.ok(isolated.js.includes('watch-later-recovery-content.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('watch-later-recovery-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-recovery-main.js') < mainWorld.js.indexOf('page-bridge.js'));

assert.match(main, /EYH_WL_RECOVERY_ADD_REQUEST/);
assert.match(main, /ACTION_ADD_VIDEO/);
assert.match(main, /addedVideoId: id/);
assert.match(main, /already_present/);
assert.doesNotMatch(main, /ACTION_REMOVE_VIDEO/,
  'recovery MAIN bridge must be structurally incapable of deleting Watch Later entries');
assert.doesNotMatch(main, /setVideoId/,
  'recovery MAIN bridge must not accept a destructive playlist-item identifier');

assert.match(content, /EYH_WL_SAFE_LIST_REQUEST/);
assert.match(content, /terminalReason !== 'no-continuation'/);
assert.match(content, /const countMismatch = declared != null && declared !== entries\.length/);
assert.match(content, /countMismatch,/);
assert.doesNotMatch(content, /표시 개수 .*복구 비교를 중단합니다/,
  'ADD-only recovery must warn on benign count mismatch instead of blocking the whole scan');
assert.match(content, /EYH_WL_RECOVERY_ADD_REQUEST/);
assert.doesNotMatch(content, /EYH_WL_SAFE_REMOVE_REQUEST/);

assert.match(recovery, /chrome\.permissions\.request\(HISTORY_PERMISSION\)/);
assert.match(recovery, /chrome\.permissions\.remove\(HISTORY_PERMISSION\)/);
const requestPermission = recovery.indexOf('chrome.permissions.request(HISTORY_PERMISSION)');
const runScan = recovery.indexOf('runScan().catch');
assert.ok(requestPermission >= 0 && runScan > requestPermission,
  'history permission request must stay directly tied to the recovery button gesture');
assert.match(recovery, /withFreshWatchLaterTab/);
assert.match(recovery, /chrome\.tabs\.create\(\{ url: WL_URL, active: false \}\)/);
assert.doesNotMatch(recovery, /chrome\.tabs\.query/,
  'recovery must never reuse an old YouTube tab whose extension context may be invalidated');
const startupDisable = recovery.lastIndexOf("$('#scan').disabled = true");
const startupRemove = recovery.lastIndexOf('chrome.permissions.remove(HISTORY_PERMISSION)');
const startupEnable = recovery.lastIndexOf("$('#scan').disabled = false");
assert.ok(startupDisable >= 0 && startupRemove > startupDisable && startupEnable > startupRemove,
  'recovery page must finish stale history-permission cleanup before enabling a new scan');
assert.match(recovery, /resetResults\(\);/);
assert.match(recovery, /list=WL/);
assert.match(recovery, /type: 'EYH_RECOVERY_GET_WL_SNAPSHOT'/);
assert.match(recovery, /type: 'EYH_RECOVERY_ADD_ONE'/);
assert.match(recovery, /status = 'attempting'/);
assert.match(recovery, /persistJournal\(durable\)/);
assert.doesNotMatch(recovery, /REMOVE_VIDEO|REMOVE_REQUEST/);
assert.match(recoveryHtml, /후보는 모두 처음에는 미선택/);
assert.match(recoveryHtml, /삭제하지 않습니다/);
assert.match(popupHtml, /id="recoverWatchLater"/);
assert.match(popup, /recovery\.html/);

console.log('PASS Watch Later recovery static safety self-test');
