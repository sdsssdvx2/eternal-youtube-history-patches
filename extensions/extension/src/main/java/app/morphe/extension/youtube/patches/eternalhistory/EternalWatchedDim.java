package app.morphe.extension.youtube.patches.eternalhistory;

import android.view.View;

import java.lang.reflect.Method;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Bridges a watched feed-card decision to Litho's node alpha before mount. */
@SuppressWarnings("unused")
public final class EternalWatchedDim {
    private static final float DIM_ALPHA = 0.38f;
    // Only titles for recently encountered watched cards are needed. Keeping this small prevents
    // feed scrolling from turning into an ever-growing prefix search.
    private static final int MAX_PENDING_TITLES = 64;
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
        if (description == null || description.length() == 0) return;
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

    /** Avoid regex allocation in the mount path; collapse whitespace with one small linear pass. */
    private static String normalize(String value) {
        if (value == null) return "";
        int length = value.length();
        StringBuilder out = new StringBuilder(length);
        boolean pendingSpace = false;
        for (int i = 0; i < length; i++) {
            char c = value.charAt(i);
            if (Character.isWhitespace(c)) {
                if (out.length() > 0) pendingSpace = true;
                continue;
            }
            if (pendingSpace) {
                out.append(' ');
                pendingSpace = false;
            }
            out.append(Character.toLowerCase(c));
        }
        return out.toString().toLowerCase(Locale.ROOT);
    }
}
