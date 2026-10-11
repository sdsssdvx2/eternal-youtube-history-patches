from pathlib import Path


def edit(path, fn):
    p = Path(path)
    old = p.read_text()
    new = fn(old)
    if new == old:
        raise SystemExit(f"no change for {path}")
    p.write_text(new)


# Settings: tri-state mode; old hide key remains only as a migration fallback.
path = "extensions/extension/src/main/java/app/morphe/extension/youtube/patches/eternalhistory/EternalHistorySettings.java"
def settings(s):
    old = '''    public static final BooleanSetting HIDE_WATCHED =
            new BooleanSetting("morphe_eternal_history_hide_watched", FALSE, false, parent(ENABLED));
    public static final IntegerSetting HIDE_MIN_PROGRESS =
            new IntegerSetting("morphe_eternal_history_hide_min_progress", 0, false, parent(HIDE_WATCHED));
'''
    new = '''    /** Empty default lets existing installs migrate from the legacy hide toggle. */
    public static final StringSetting FEED_MODE =
            new StringSetting("morphe_eternal_history_feed_mode", "", false, parent(ENABLED));
    /** Kept only so existing installs that enabled hide keep their previous behavior. */
    public static final BooleanSetting HIDE_WATCHED =
            new BooleanSetting("morphe_eternal_history_hide_watched", FALSE, false, parent(ENABLED));
    public static final IntegerSetting HIDE_MIN_PROGRESS =
            new IntegerSetting("morphe_eternal_history_hide_min_progress", 0, false, parent(ENABLED));

    public static String feedMode() {
        String mode = FEED_MODE.get();
        if (mode == null || mode.isEmpty()) return HIDE_WATCHED.get() ? "hide" : "none";
        if ("dim".equals(mode) || "hide".equals(mode)) return mode;
        return "none";
    }

    public static boolean isFeedVisualEnabled() { return !"none".equals(feedMode()); }
    public static boolean isDimMode() { return "dim".equals(feedMode()); }
    public static boolean isHideMode() { return "hide".equals(feedMode()); }
'''
    if old not in s:
        raise SystemExit("settings anchor missing")
    return s.replace(old, new)
edit(path, settings)


# DB: title snapshot is loaded once in the background, never queried per feed card.
path = "extensions/extension/src/main/java/app/morphe/extension/youtube/patches/eternalhistory/EternalHistoryDb.java"
def db(s):
    needle = '''    synchronized Map<String, Float> loadProgressSnapshot() {
        Map<String, Float> out = new HashMap<>();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT video_id,max_progress_pct FROM videos", null)) {
            while (c.moveToNext()) out.put(c.getString(0), c.isNull(1) ? -1f : c.getFloat(1));
        }
        return out;
    }
'''
    repl = needle + '''
    /** Titles are used only for the dim renderer bridge; loaded in one background snapshot. */
    synchronized Map<String, String> loadTitleSnapshot() {
        Map<String, String> out = new HashMap<>();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT video_id,title FROM videos WHERE title IS NOT NULL AND title <> ''", null)) {
            while (c.moveToNext()) out.put(c.getString(0), c.getString(1));
        }
        return out;
    }
'''
    if needle not in s:
        raise SystemExit("DB snapshot anchor missing")
    return s.replace(needle, repl)
edit(path, db)


# Client: dim and hide share the same low-priority local ledger cache and title snapshot.
path = "extensions/extension/src/main/java/app/morphe/extension/youtube/patches/eternalhistory/EternalHistoryClient.java"
def client(s):
    s = s.replace(
        "    private static final ConcurrentHashMap<String, Float> WATCHED_CACHE = new ConcurrentHashMap<>();\n",
        "    private static final ConcurrentHashMap<String, Float> WATCHED_CACHE = new ConcurrentHashMap<>();\n"
        "    private static final ConcurrentHashMap<String, String> TITLE_CACHE = new ConcurrentHashMap<>();\n",
    )
    s = s.replace("EternalHistorySettings.HIDE_WATCHED.get()", "EternalHistorySettings.isFeedVisualEnabled()")
    old = '''    private static void loadLocalCache() {
        WATCHED_CACHE.putAll(EternalHistoryDb.get().loadProgressSnapshot());
    }
'''
    new = '''    private static void loadLocalCache() {
        EternalHistoryDb db = EternalHistoryDb.get();
        WATCHED_CACHE.putAll(db.loadProgressSnapshot());
        TITLE_CACHE.putAll(db.loadTitleSnapshot());
    }
'''
    if old not in s:
        raise SystemExit("client loadLocalCache anchor missing")
    s = s.replace(old, new)
    anchor = '''    static boolean isWatchedCached(String videoId, double minimumProgress) {
        if (videoId == null || videoId.length() != 11) return false;
        Float pct = WATCHED_CACHE.get(videoId);
        if (pct == null) return false;
        if (minimumProgress <= 0) return true;
        return pct >= 0 && pct >= minimumProgress;
    }
'''
    addition = anchor + '''
    static String cachedTitle(String videoId) {
        if (videoId == null || videoId.length() != 11) return null;
        return TITLE_CACHE.get(videoId);
    }
'''
    if anchor not in s:
        raise SystemExit("client watched anchor missing")
    s = s.replace(anchor, addition)
    old = '''        float incoming = r.isNull("maxProgressPct") ? -1f : (float)r.optDouble("maxProgressPct", -1);
        WATCHED_CACHE.merge(id, incoming, (oldValue, newValue) -> {
'''
    new = '''        String title = r.optString("title", "").trim();
        if (!title.isEmpty()) TITLE_CACHE.put(id, title);
        float incoming = r.isNull("maxProgressPct") ? -1f : (float)r.optDouble("maxProgressPct", -1);
        WATCHED_CACHE.merge(id, incoming, (oldValue, newValue) -> {
'''
    if old not in s:
        raise SystemExit("client cacheVideo anchor missing")
    return s.replace(old, new)
edit(path, client)


# Filter: hide returns true; dim records a tiny title hint and lets the component render.
path = "extensions/extension/src/main/java/app/morphe/extension/youtube/patches/eternalhistory/EternalWatchedFilter.java"
def filt(s):
    start = s.index("    public static boolean shouldHide(")
    end = s.index("\n    private static boolean isWholeCardPath", start)
    method = '''    public static boolean shouldHide(ContextInterface contextInterface, byte[] buffer) {
        if (!EternalHistorySettings.ENABLED.get() || !EternalHistorySettings.isFeedVisualEnabled()) return false;
        if (contextInterface == null || buffer == null || buffer.length == 0) return false;

        EternalHistoryClient.ensureFeedCacheStarted();
        String path = contextInterface.patch_getPathBuilder().toString();
        if (!isWholeCardPath(path)) return false;

        String videoId = BufferPhraseFilter.extractVideoIdFromBuffer(buffer);
        if (!EternalHistoryClient.isWatchedCached(videoId, EternalHistorySettings.HIDE_MIN_PROGRESS.get())) {
            return false;
        }

        if (EternalHistorySettings.isDimMode()) {
            EternalWatchedDim.markTitle(EternalHistoryClient.cachedTitle(videoId));
            return false;
        }
        return EternalHistorySettings.isHideMode();
    }
'''
    return s[:start] + method + s[end:]
edit(path, filt)


# Renderer bridge. The expensive work is absent for normal cards; reflection is cached after one hit.
helper = Path("extensions/extension/src/main/java/app/morphe/extension/youtube/patches/eternalhistory/EternalWatchedDim.java")
helper.write_text('''package app.morphe.extension.youtube.patches.eternalhistory;

import android.view.View;

import java.lang.reflect.Method;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Bridges a watched feed-card decision to Litho's node alpha before mount. */
@SuppressWarnings("unused")
public final class EternalWatchedDim {
    private static final float DIM_ALPHA = 0.38f;
    private static final int MAX_PENDING_TITLES = 256;
    private static final ConcurrentHashMap<String, Boolean> PENDING = new ConcurrentHashMap<>();
    private static final ConcurrentLinkedQueue<String> ORDER = new ConcurrentLinkedQueue<>();
    private static volatile Class<?> nodeClass;
    private static volatile Method setAlphaMethod;

    private EternalWatchedDim() { }

    static void markTitle(String title) {
        if (!EternalHistorySettings.isDimMode()) return;
        String key = normalize(title);
        if (key.isEmpty() || PENDING.putIfAbsent(key, Boolean.TRUE) != null) return;
        ORDER.add(key);
        while (PENDING.size() > MAX_PENDING_TITLES) {
            String oldest = ORDER.poll();
            if (oldest == null) break;
            PENDING.remove(oldest);
        }
    }

    /** Called from the patched Litho mount path immediately before its existing alpha application. */
    public static void apply(View view, Object nodeInfo) {
        if (!EternalHistorySettings.ENABLED.get() || !EternalHistorySettings.isDimMode()) return;
        if (view == null || nodeInfo == null || PENDING.isEmpty()) return;
        CharSequence description = view.getContentDescription();
        if (description == null) return;
        String text = normalize(description.toString());
        if (text.isEmpty() || !matchesPendingTitle(text)) return;
        try {
            Method method = setAlphaMethod;
            Class<?> cls = nodeInfo.getClass();
            if (method == null || nodeClass != cls) {
                method = cls.getDeclaredMethod("g", float.class);
                method.setAccessible(true);
                nodeClass = cls;
                setAlphaMethod = method;
            }
            method.invoke(nodeInfo, DIM_ALPHA);
        } catch (Throwable ignored) {
            // Obfuscation changes must never break the feed. Supported versions are patch-time validated.
        }
    }

    private static boolean matchesPendingTitle(String description) {
        if (PENDING.containsKey(description)) return true;
        for (String title : PENDING.keySet()) {
            if (!description.startsWith(title) || description.length() == title.length()) continue;
            char c = description.charAt(title.length());
            if (Character.isWhitespace(c) || c == '·' || c == '•' || c == '-' || c == '|' || c == ',' || c == '–' || c == '—') {
                return true;
            }
        }
        return false;
    }

    private static String normalize(String value) {
        if (value == null) return "";
        return value.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }
}
''')


# Settings UI: tri-state selector replaces the binary hide switch.
path = "patches/src/main/kotlin/app/eternal/patches/youtube/history/AddOnSupport.kt"
def addon(s):
    old = '''                  <SwitchPreference android:key="morphe_eternal_history_hide_watched" android:title="@string/morphe_eternal_history_hide_watched_title" android:summary="@string/morphe_eternal_history_hide_watched_summary" android:defaultValue="false" />
                  <EditTextPreference android:key="morphe_eternal_history_hide_min_progress" android:title="@string/morphe_eternal_history_hide_min_progress_title" android:summary="@string/morphe_eternal_history_hide_min_progress_summary" android:defaultValue="0" android:inputType="numberDecimal" />
'''
    new = '''                  <ListPreference android:key="morphe_eternal_history_feed_mode" android:title="@string/morphe_eternal_history_feed_mode_title" android:summary="@string/morphe_eternal_history_feed_mode_summary" android:entries="@array/morphe_eternal_history_feed_mode_entries" android:entryValues="@array/morphe_eternal_history_feed_mode_values" android:defaultValue="none" />
                  <EditTextPreference android:key="morphe_eternal_history_hide_min_progress" android:title="@string/morphe_eternal_history_visual_min_progress_title" android:summary="@string/morphe_eternal_history_visual_min_progress_summary" android:defaultValue="0" android:inputType="numberDecimal" />
'''
    if old not in s:
        raise SystemExit("prefs anchor missing")
    return s.replace(old, new)
edit(path, addon)


# Resources: selector values + updated user-facing description.
path = "patches/src/main/resources/addresources/values/youtube/strings.xml"
def strings(s):
    insert = '''    <string name="morphe_eternal_history_feed_mode_title">시청한 피드 카드 표시</string>
    <string name="morphe_eternal_history_feed_mode_summary">변경 없음 / 흐리게 / 숨기기 중 선택합니다.</string>
    <string-array name="morphe_eternal_history_feed_mode_entries">
        <item>변경 없음</item>
        <item>흐리게</item>
        <item>숨기기</item>
    </string-array>
    <string-array name="morphe_eternal_history_feed_mode_values">
        <item>none</item>
        <item>dim</item>
        <item>hide</item>
    </string-array>
    <string name="morphe_eternal_history_visual_min_progress_title">표시 변경 최소 진행률 (%)</string>
    <string name="morphe_eternal_history_visual_min_progress_summary">0이면 진행률을 모르는 과거 기록도 흐리게/숨김 대상으로 봅니다.</string>
'''
    marker = '    <string name="morphe_eternal_history_hide_watched_title">'
    idx = s.index(marker)
    s = s[:idx] + insert + s[idx:]
    return s.replace(
        "v0.2는 기록/진행률/D1 캐시/시청 카드 숨기기를 제공합니다. 흐리게 표시는 후속 렌더 훅에서 추가합니다.",
        "시청 기록은 D1에 직접 동기화되며, 피드 카드는 변경 없음/흐리게/숨기기 모드와 최소 진행률을 지원합니다.",
    )
edit(path, strings)


# Patcher: inject into YouTube's existing Litho node-alpha path. The host's normal unmount path resets alpha.
path = "patches/src/main/kotlin/app/eternal/patches/youtube/history/EternalHistoryPatch.kt"
def patch(s):
    s = s.replace(
        "import app.morphe.patcher.patch.BytecodePatchContext\n",
        "import app.morphe.patcher.Fingerprint\nimport app.morphe.patcher.methodCall\nimport app.morphe.patcher.patch.BytecodePatchContext\n",
    )
    s = s.replace(
        "import com.android.tools.smali.dexlib2.Opcode\n",
        "import com.android.tools.smali.dexlib2.AccessFlags\nimport com.android.tools.smali.dexlib2.Opcode\n"
        "import com.android.tools.smali.dexlib2.iface.instruction.FiveRegisterInstruction\n"
        "import com.android.tools.smali.dexlib2.iface.instruction.ReferenceInstruction\n"
        "import com.android.tools.smali.dexlib2.iface.instruction.TwoRegisterInstruction\n"
        "import com.android.tools.smali.dexlib2.iface.reference.FieldReference\n"
        "import com.android.tools.smali.dexlib2.iface.reference.MethodReference\n",
    )
    s = s.replace(
        '''private const val EXTENSION_FILTER =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalWatchedFilter;"
''',
        '''private const val EXTENSION_FILTER =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalWatchedFilter;"
private const val EXTENSION_DIM =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalWatchedDim;"
''',
    )
    anchor = "object EternalHistoryPatch : Patch(\n"
    fp = '''private object LithoMountPropertiesFingerprint : Fingerprint(
    accessFlags = listOf(AccessFlags.STATIC),
    returnType = "V",
    parameters = listOf("Ljava/lang/Object;", "L"),
    filters = listOf(
        methodCall(
            opcode = Opcode.INVOKE_VIRTUAL,
            smali = "Landroid/view/View;->setContentDescription(Ljava/lang/CharSequence;)V"
        ),
        methodCall(
            opcode = Opcode.INVOKE_VIRTUAL,
            smali = "Landroid/view/View;->setAlpha(F)V"
        )
    )
)

'''
    if anchor not in s:
        raise SystemExit("patch object anchor missing")
    s = s.replace(anchor, fp + anchor)
    s = s.replace("        installWatchedCardHook(context)\n", "        installWatchedCardHook(context)\n        installWatchedDimHook(context)\n")
    end = '''    private fun MutableMethod.removeInstructionsCompat(index: Int, count: Int) {
        repeat(count) { removeInstruction(index) }
    }
}
'''
    dim = '''    private fun installWatchedDimHook(context: BytecodePatchContext) {
        val method = LithoMountPropertiesFingerprint.method
        val instructions = method.implementation?.instructions
            ?: throw PatchException("Eternal dim: Litho mount method has no implementation")

        var alphaIndex = -1
        var viewRegister = -1
        var nodeRegister = -1
        var nodeClass = ""
        for (i in instructions.indices) {
            val insn = instructions[i]
            val ref = (insn as? ReferenceInstruction)?.reference as? MethodReference ?: continue
            if (ref.definingClass != "Landroid/view/View;" || ref.name != "setAlpha" || ref.parameterTypes.size != 1) continue
            val invoke = insn as? FiveRegisterInstruction ?: continue
            for (j in (i - 1) downTo maxOf(0, i - 5)) {
                val fieldInsn = instructions[j] as? ReferenceInstruction ?: continue
                val field = fieldInsn.reference as? FieldReference ?: continue
                val regs = fieldInsn as? TwoRegisterInstruction ?: continue
                if (field.type != "F") continue
                alphaIndex = i
                viewRegister = invoke.registerC
                nodeRegister = regs.registerB
                nodeClass = field.definingClass
                break
            }
            if (alphaIndex >= 0) break
        }
        if (alphaIndex < 0 || viewRegister < 0 || nodeRegister < 0 || nodeClass.isEmpty()) {
            throw PatchException("Eternal dim: node alpha application not found")
        }

        var gateIndex = -1
        for (i in (alphaIndex - 1) downTo maxOf(0, alphaIndex - 12)) {
            val ref = (instructions[i] as? ReferenceInstruction)?.reference as? MethodReference ?: continue
            if (ref.definingClass == nodeClass && ref.returnType == "Z" && ref.parameterTypes.isEmpty()) {
                gateIndex = i
                break
            }
        }
        if (gateIndex < 0) throw PatchException("Eternal dim: node alpha gate not found")
        if (viewRegister > 15 || nodeRegister > 15) {
            throw PatchException("Eternal dim: mount registers exceed invoke-static encoding")
        }
        method.addInstruction(
            gateIndex,
            "invoke-static { v$viewRegister, v$nodeRegister }, $EXTENSION_DIM->apply(Landroid/view/View;Ljava/lang/Object;)V"
        )
    }

'''
    if end not in s:
        raise SystemExit("patch end anchor missing")
    return s.replace(end, dim + end)
edit(path, patch)
