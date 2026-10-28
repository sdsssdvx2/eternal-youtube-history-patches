from pathlib import Path

p = Path('.github/scripts/apply-android-v1106.py')
lines = p.read_text(encoding='utf-8').splitlines()

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
p.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('PASS Android helper preparation')
