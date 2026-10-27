import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './watch-later-safe-transaction-selftest.mjs';
import './watch-later-recovery-selftest.mjs';
import './watch-later-recovery-static-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const text = name => fs.readFileSync(path.join(src, name), 'utf8');
const manifest = JSON.parse(text('manifest.json'));
const content = text('content.js');
const guard = text('pc-stability-guard.js');
const guardCss = text('pc-stability-guard.css');
const safety = text('watch-later-safety-main.js');
const safeCore = text('watch-later-safe-core.js');
const safeMain = text('watch-later-safe-main.js');
const safeCoordinator = text('watch-later-safe.js');
const bridge = text('page-bridge.js');
const core = text('watch-later-core.js');
const options = text('options.js');
const optionsHtml = text('options.html');
const maintenance = text('maintenance.js');
const popup = text('popup.js');
const popupHtml = text('popup.html');

assert.equal(manifest.version, '0.10.7');
const mainWorld = manifest.content_scripts.find(cs => cs.world === 'MAIN');
const isolated = manifest.content_scripts.find(cs => cs.world === 'ISOLATED');
assert.ok(mainWorld && isolated, 'both MAIN and ISOLATED content-script worlds are required');

// MAIN-world destructive safety boundary stays first and the safe/recovery bridges remain ordered.
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js');
assert.ok(mainWorld.js.indexOf('watch-later-core.js') < mainWorld.js.indexOf('watch-later-safe-core.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('watch-later-recovery-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-recovery-main.js') < mainWorld.js.indexOf('page-bridge.js'));

// v0.10.7 stability invariant: the proven 0.9.x content renderer is the only watched-card/header
// presentation owner. The two v0.10.x scripts that fought over the same DOM are deliberately not
// injected at all. Their files may remain in the source tree only so stored profile data can be
// reimplemented later without migration loss.
assert.equal(isolated.js[0], 'watch-later-core.js');
assert.ok(isolated.js.includes('content.js'));
assert.ok(isolated.js.includes('pc-stability-guard.js'));
assert.ok(isolated.js.includes('watch-later-safe.js'));
assert.ok(isolated.js.includes('watch-later-recovery-content.js'));
assert.ok(isolated.js.includes('maintenance.js'));
assert.ok(!isolated.js.includes('surface-profiles.js'), 'page-profile renderer must stay disabled in stability mode');
assert.ok(!isolated.js.includes('pc-ui-hotfix.js'), 'DOM-churn hotfix must stay disabled in stability mode');
assert.ok(isolated.css.includes('content.css'));
assert.ok(isolated.css.includes('pc-stability-guard.css'));

// content.js remains the single quick-mode renderer. A mode click updates the same in-memory state
// that scanAndMark reads, preventing the old “button says display/hide but cards stay dim” split.
assert.match(content, /watchedDisplayMode = mode/);
assert.match(content, /chrome\.storage\.local\.set\(\{ watchedDisplayMode: mode \}\)/);
assert.match(content, /c\.classList\.toggle\('eyh-watched', dimmed\)/);
assert.match(content, /c\.classList\.toggle\('eyh-hidden', matches && watchedDisplayMode === 'hide'\)/);
assert.match(content, /function scheduleScan\(\) \{ if \(document\.visibilityState === 'hidden' \|\| scanTimer\) return;/);
assert.equal((content.match(/new MutationObserver/g) || []).length, 1,
  'stable renderer must have one coalesced page observer, not competing presentation observers');

// The replacement guard is navigation-only and must never observe/mutate the full DOM. Shorts UI
// suppression is a root class + CSS rule, so there is no mutation feedback loop.
assert.doesNotMatch(guard, /MutationObserver/);
assert.match(guard, /classList\.toggle\('eyh-shorts-surface', shorts\)/);
assert.match(guard, /watchLaterAutoCleanupEnabled: false/);
assert.match(guardCss, /html\.eyh-shorts-surface #eyh-header-controls/);
assert.match(guardCss, /#eyh-watch-later-auto/);
assert.match(guardCss, /#eyh-watch-later-cleanup/);
assert.match(guardCss, /\.eyh-header-brand/);

// Options must control the renderer that is actually active. The old v0.10.x save path forced
// watchedDisplayMode='none' and relied on surface-profiles.js; stability mode maps the preserved
// profile UI back to the single legacy mode with hide precedence.
assert.match(options, /const legacyMode = defaultProfile\.hideEnabled \? 'hide' : defaultProfile\.dimEnabled \? 'dim' : 'none'/);
assert.match(options, /watchedDisplayMode: legacyMode/);
assert.doesNotMatch(options, /watchedDisplayMode: 'none'/);
assert.match(options, /watchLaterAutoCleanupEnabled: false/);
assert.match(options, /pageProfilesPreservedButInactive/);
assert.match(optionsHtml, /v0\.10\.7 안정화 모드/);
assert.match(optionsHtml, /자동 정리 — 안전 잠금 중/);

// Legacy destructive names stay permanently blocked; the transactional coordinator never reopens
// them. Automatic cleanup remains off independent of UI state.
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\(\)/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_REQUEST'/);
assert.doesNotMatch(safeCoordinator, /requestPage\('EYH_WL_REMOVE_ONE_REQUEST'/);
assert.match(safeCoordinator, /watchLaterAutoCleanupEnabled: false/);
assert.match(maintenance, /watchLaterAutoCleanupEnabled: false/);

// Destructive safe cleanup retains strict full-list equality; only the ADD-only recovery flow may
// continue with a visible count-gap warning.
assert.match(safeCoordinator, /YouTube 표시 개수 \$\{declaredCount\}개와 안전 파서 \$\{expectedEntries\}개가 달라 삭제하지 않습니다/);
assert.match(safeCoordinator, /listed\.terminalReason !== 'no-continuation'/);
assert.match(safeMain, /ACTION_REMOVE_VIDEO/);
assert.match(safeMain, /const fresh = await resolveEntry\(id\)/);
assert.match(safeCore, /continuation이 반복/);
assert.match(core, /ACTION_REMOVE_VIDEO/);
assert.match(bridge, /setVideoId/);

// Existing diagnostics and recovery entry points remain available without reintroducing resident
// background work.
assert.match(content, /GET_PAGE_DIAGNOSTICS/);
assert.match(maintenance, /document\.visibilityState !== 'visible'/);
assert.match(maintenance, /HISTORY_INTERVAL_MS = 60 \* 60 \* 1000/);
assert.match(maintenance, /WATCH_LATER_INTERVAL_MS = 30 \* 60 \* 1000/);
assert.match(popupHtml, /id="recoverWatchLater"/);
assert.match(popup, /recovery\.html/);

console.log('PASS pc single-owner stability integration self-test');
