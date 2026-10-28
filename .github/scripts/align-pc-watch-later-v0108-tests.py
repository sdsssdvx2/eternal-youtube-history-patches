from pathlib import Path

p = Path('pc-extension/src/tests/watch-later-selftest.mjs')
s = p.read_text(encoding='utf-8')
old = '''// The emergency MAIN-world boundary remains permanent. In v0.10.7 the lightweight stability
// controller also keeps the legacy automatic preference false, without loading the old hotfix DOM
// observer or destructive on-page coordinator.
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\\(\\)/);
assert.match(safety, /blocked-by-safety-lock/);
assert.match(stability, /watchLaterAutoCleanupEnabled: false/);
assert.match(stability, /#eyh-watch-later-auto/);
assert.match(stability, /#eyh-watch-later-cleanup/);

const mainWorld = manifest.content_scripts.find(entry => entry.world === 'MAIN');
const isolated = manifest.content_scripts.find(entry => entry.world === 'ISOLATED');
assert.ok(mainWorld, 'MAIN-world content script is required');
assert.ok(isolated, 'ISOLATED-world content script is required');
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js', 'safety boundary must load before page-bridge');
assert.ok(mainWorld.js.indexOf('watch-later-safety-main.js') < mainWorld.js.indexOf('watch-later-safe-core.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'));
assert.ok(!isolated.js.includes('watch-later-safe.js'), 'destructive safe-cleanup UI is intentionally dormant in stability release');
assert.equal(manifest.version, '0.10.7');
'''
new = '''// The emergency MAIN-world boundary remains permanent for historical mutation messages.
// v0.10.8 enables only the separately journaled/revalidated safe transaction coordinator.
assert.match(safety, /EYH_WL_REMOVE_REQUEST/);
assert.match(safety, /EYH_WL_REMOVE_ONE_REQUEST/);
assert.match(safety, /stopImmediatePropagation\\(\\)/);
assert.match(safety, /blocked-by-safety-lock/);
assert.doesNotMatch(stability, /watchLaterAutoCleanupEnabled: false/);
assert.match(stability, /#eyh-watch-later-auto/);
assert.match(stability, /#eyh-watch-later-cleanup/);

const mainWorld = manifest.content_scripts.find(entry => entry.world === 'MAIN');
const isolated = manifest.content_scripts.find(entry => entry.world === 'ISOLATED');
assert.ok(mainWorld, 'MAIN-world content script is required');
assert.ok(isolated, 'ISOLATED-world content script is required');
assert.equal(mainWorld.js[0], 'watch-later-safety-main.js', 'safety boundary must load before page-bridge');
assert.ok(mainWorld.js.indexOf('watch-later-safety-main.js') < mainWorld.js.indexOf('watch-later-safe-core.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-core.js') < mainWorld.js.indexOf('watch-later-safe-main.js'));
assert.ok(mainWorld.js.indexOf('watch-later-safe-main.js') < mainWorld.js.indexOf('page-bridge.js'));
assert.ok(isolated.js.includes('watch-later-safe-core.js'), 'safe transaction core must be resident');
assert.ok(isolated.js.includes('watch-later-safe.js'), 'safe transaction coordinator must be resident');
assert.equal(manifest.version, '0.10.8');
'''
if s.count(old) != 1:
    raise SystemExit(f'watch-later contract block expected once, found {s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')

p = Path('pc-extension/src/tests/static-integration-selftest.mjs')
s = p.read_text(encoding='utf-8')
old = "assert.ok(!isolatedWorld.js.includes('watch-later-safe-core.js'), 'unused isolated safe core must not load');"
new = "assert.ok(isolatedWorld.js.includes('watch-later-safe-core.js'), 'safe transaction core must load in ISOLATED world');"
if s.count(old) != 1:
    raise SystemExit(f'static safe-core assertion expected once, found {s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')

print('PASS PC Watch Later test contract migration')
