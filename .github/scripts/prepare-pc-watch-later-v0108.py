from pathlib import Path

p = Path('.github/scripts/apply-pc-watch-later-v0108.py')
s = p.read_text(encoding='utf-8')
old = '''s = once(s, "  $('#watchLaterAutoCleanupEnabled').checked = false;", "  $('#watchLaterAutoCleanupEnabled').checked = Boolean(v.watchLaterAutoCleanupEnabled);", 'options load auto')'''
new = '''_auto_old = "  $('#watchLaterAutoCleanupEnabled').checked = false;"
if s.count(_auto_old) != 2:
    raise SystemExit(f'options load auto: expected two pre-rewrite false assignments, found {s.count(_auto_old)}')
s = s.replace(_auto_old, "  $('#watchLaterAutoCleanupEnabled').checked = Boolean(v.watchLaterAutoCleanupEnabled);", 1)'''
if s.count(old) != 1:
    raise SystemExit(f'helper patch target expected once, found {s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('PASS PC helper preparation')
