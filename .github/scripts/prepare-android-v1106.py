from pathlib import Path
import re

p = Path('.github/scripts/apply-android-v1106.py')
s = p.read_text(encoding='utf-8')
pattern = re.compile(
    r"s = once\(s,\n'''        TextView note = text\(activity,.*?'toolbar concise note'\)\nold = '''        CheckBox dim",
    re.S,
)
replacement = r'''s = once(s,
''' + "'''                        ? \"현재 공통 기본값을 사용 중입니다. 값을 바꾸면 이 페이지의 개별 설정으로 즉시 저장됩니다.\\n흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다.\"'''" + r''',
''' + "'''                        ? \"공통 기본값 사용 중 · 바꾸면 이 페이지에만 저장됩니다.\"'''" + r''', 'toolbar inherited note')
s = once(s,
''' + "'''                        : \"이 페이지의 개별 설정입니다. 변경 내용은 화면에 즉시 반영됩니다.\\n흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다.\",'''" + r''',
''' + "'''                        : \"이 페이지 전용 설정 · 숨김이 흐림보다 우선합니다.\",'''" + r''', 'toolbar explicit note')
old = '''        CheckBox dim'''
new_s, count = pattern.subn(replacement, s, count=1)
if count != 1:
    raise SystemExit(f'toolbar note helper block expected once, found {count}')
p.write_text(new_s, encoding='utf-8')
print('PASS Android helper preparation')
