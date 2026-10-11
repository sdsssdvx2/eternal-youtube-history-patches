from pathlib import Path

p = Path("tools/implement_watched_dim.py")
s = p.read_text()
s = s.replace('private static boolean isWholeCardPath', 'private static boolean looksLikeWholeVideoCard')
s = s.replace('if (!isWholeCardPath(path)) return false;', 'if (!looksLikeWholeVideoCard(path)) return false;')
s = s.replace(
    '<SwitchPreference android:key="morphe_eternal_history_hide_watched" android:title="@string/morphe_eternal_history_hide_watched_title" android:summary="@string/morphe_eternal_history_hide_watched_summary" android:defaultValue="false" />',
    '<SwitchPreference android:key="morphe_eternal_history_hide_watched" android:title="@string/morphe_eternal_history_hide_watched_title" android:summary="@string/morphe_eternal_history_hide_watched_summary" />',
)
s = s.replace(
    '<EditTextPreference android:key="morphe_eternal_history_hide_min_progress" android:title="@string/morphe_eternal_history_hide_min_progress_title" android:summary="@string/morphe_eternal_history_hide_min_progress_summary" android:defaultValue="0" android:inputType="numberDecimal" />',
    '<app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_hide_min_progress" android:title="@string/morphe_eternal_history_hide_min_progress_title" android:summary="@string/morphe_eternal_history_hide_min_progress_summary" android:inputType="number" />',
)
s = s.replace(
    '<EditTextPreference android:key="morphe_eternal_history_hide_min_progress" android:title="@string/morphe_eternal_history_visual_min_progress_title" android:summary="@string/morphe_eternal_history_visual_min_progress_summary" android:defaultValue="0" android:inputType="numberDecimal" />',
    '<app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_hide_min_progress" android:title="@string/morphe_eternal_history_visual_min_progress_title" android:summary="@string/morphe_eternal_history_visual_min_progress_summary" android:inputType="number" />',
)
s = s.replace("marker = '    <string name=\"morphe_eternal_history_hide_watched_title\">'", "marker = '  <string name=\"morphe_eternal_history_hide_watched_title\">'")
s = s.replace(
    'v0.2는 기록/진행률/D1 캐시/시청 카드 숨기기를 제공합니다. 흐리게 표시는 후속 렌더 훅에서 추가합니다.',
    'v0.2는 안정적인 Litho 경로로 ‘숨기기’를 지원합니다. 흐리게 표시는 View 렌더 훅 검증 후 추가할 예정입니다.',
)
# The source helper/UI/cache changes are staged here. The version-specific bytecode hook is applied
# separately in the final feature commit so semantic-release never publishes a half-connected build.
s = s.replace('edit(path, patch)\n', 'print("patcher hook intentionally staged separately")\n')
code = compile(s, str(p), "exec")
exec(code, {"__name__": "__main__", "__file__": str(p)})
