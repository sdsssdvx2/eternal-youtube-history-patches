from pathlib import Path

p = Path('.github/scripts/apply-android-v1106.py')
lines = p.read_text(encoding='utf-8').splitlines()

# Narrow the toolbar note rewrite to the two actual ternary string lines.
start = None
end = None
for i, line in enumerate(lines):
    if start is None and line == "s = once(s," and i + 1 < len(lines) and "TextView note = text(activity" in lines[i + 1]:
        start = i
    if start is not None and "'toolbar concise note')" in line:
        end = i
        break
if start is None or end is None or end < start:
    raise SystemExit(f'could not locate toolbar concise-note helper block: start={start}, end={end}')
replacement = [
    "s = once(s,",
    "             '? \\\"현재 공통 기본값을 사용 중입니다. 값을 바꾸면 이 페이지의 개별 설정으로 즉시 저장됩니다.\\\\n흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다.\\\"',",
    "             '? \\\"공통 기본값 사용 중 · 바꾸면 이 페이지에만 저장됩니다.\\\"', 'toolbar inherited note')",
    "s = once(s,",
    "             ': \\\"이 페이지의 개별 설정입니다. 변경 내용은 화면에 즉시 반영됩니다.\\\\n흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다.\\\",',",
    "             ': \\\"이 페이지 전용 설정 · 숨김이 흐림보다 우선합니다.\\\",', 'toolbar explicit note')",
]
lines[start:end + 1] = replacement

# Drop the cosmetic coordinator diagnostic-label rewrite; it is unrelated to behavior and the exact
# Korean string changed during prior maintenance. Safety is asserted independently in CI.
start = None
end = None
for i, line in enumerate(lines):
    if start is None and line == "s = once(s," and i + 3 < len(lines) and any("기존/자동 삭제 경로" in x for x in lines[i:i+5]):
        start = i
    if start is not None and "'coordinator diagnostic')" in line:
        end = i
        break
if start is None or end is None:
    raise SystemExit(f'could not locate coordinator diagnostic helper block: start={start}, end={end}')
del lines[start:end + 1]

text = '\n'.join(lines) + '\n'

# The same long-toast line appears three times in the source. Change only the executeCleanup success
# toast here; the following contextual catch/finally rewrite remains unique and injects helpers.
old = """s = once(s,\n'''            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));''',\n'''            postToastLong(activity, lastStatus);''', 'safe cleaner success toast')"""
new = """_long_toast = '            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));'\n_success_anchor = '            lastStatus = allRemoved'\n_anchor_pos = s.find(_success_anchor)\nif _anchor_pos < 0:\n    raise SystemExit('safe cleaner success anchor missing')\n_toast_pos = s.find(_long_toast, _anchor_pos)\nif _toast_pos < 0:\n    raise SystemExit('safe cleaner success toast after anchor missing')\ns = s[:_toast_pos] + '            postToastLong(activity, lastStatus);' + s[_toast_pos + len(_long_toast):]"""
if text.count(old) != 1:
    raise SystemExit(f'could not locate long-toast helper rewrite: found {text.count(old)}')
text = text.replace(old, new, 1)

p.write_text(text, encoding='utf-8')
print('PASS Android helper preparation')
