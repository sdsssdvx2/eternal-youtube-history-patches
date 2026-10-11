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
code = compile(s, str(p), "exec")
exec(code, {"__name__": "__main__", "__file__": str(p)})
