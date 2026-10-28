from pathlib import Path

p = Path('.github/workflows/validate-feature.yml')
s = p.read_text(encoding='utf-8')

old = "for (const forbidden of ['surface-profiles.js','pc-ui-hotfix.js','watch-later-safe.js']) {"
new = "for (const forbidden of ['surface-profiles.js','pc-ui-hotfix.js']) {"
if s.count(old) != 1:
    raise SystemExit(f'forbidden resident list expected once, found {s.count(old)}')
s = s.replace(old, new, 1)

old = "          console.log('PASS manifest JSON + one resident card renderer');"
new = "          if (!js.includes('watch-later-safe-core.js') || !js.includes('watch-later-safe.js')) throw new Error('safe Watch Later transaction coordinator is not resident');\n          console.log('PASS manifest JSON + one card renderer + resident safe Watch Later coordinator');"
if s.count(old) != 1:
    raise SystemExit(f'manifest PASS marker expected once, found {s.count(old)}')
s = s.replace(old, new, 1)

old = "          grep -F 'watchLaterAutoCleanupEnabled: false' pc-stability-controller.js"
new = "          ! grep -F 'watchLaterAutoCleanupEnabled: false' pc-stability-controller.js\n          grep -F 'LEGACY_WATCH_LATER_MUTATION_DISABLED = true' content.js\n          grep -F 'scheduleAutomaticCleanup' watch-later-safe.js"
if s.count(old) != 1:
    raise SystemExit(f'legacy forced-off assertion expected once, found {s.count(old)}')
s = s.replace(old, new, 1)

old = "          echo 'PASS PC single-renderer display + Shorts preservation + strict recovery assertions'"
new = "          echo 'PASS PC single-renderer display + safe Watch Later coordinator + Shorts preservation + strict recovery assertions'"
if s.count(old) != 1:
    raise SystemExit(f'PC PASS label expected once, found {s.count(old)}')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
print('PASS aligned PC v0.10.8 feature CI contract')
