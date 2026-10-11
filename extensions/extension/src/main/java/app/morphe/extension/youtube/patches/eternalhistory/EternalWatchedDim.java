package app.morphe.extension.youtube.patches.eternalhistory;

import android.view.View;

import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Fast watched-card matcher used by the patched Litho alpha path. */
@SuppressWarnings("unused")
public final class EternalWatchedDim {
    private static final int MAX_PENDING_TITLES = 64;
    private static final ConcurrentHashMap<String, Boolean> PENDING = new ConcurrentHashMap<>();
    private static final ConcurrentLinkedQueue<String> ORDER = new ConcurrentLinkedQueue<>();

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

    /**
     * Called on the normal Litho mount path. It only decides whether the current card should be
     * dimmed; the bytecode patch invokes YouTube's own node-alpha setter so normal unmount/reuse
     * logic restores alpha correctly without reflection or per-card database/network work.
     */
    public static boolean shouldDim(View view) {
        if (!EternalHistorySettings.ENABLED.get() || !EternalHistorySettings.isDimMode()) return false;
        if (view == null || PENDING.isEmpty()) return false;
        CharSequence description = view.getContentDescription();
        if (description == null || description.length() == 0) return false;
        String text = normalize(description.toString());
        return !text.isEmpty() && matchesPendingTitle(text);
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

    /** Avoid regex allocation in the mount path; collapse whitespace with one linear pass. */
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
            out.append(c);
        }
        return out.toString().toLowerCase(Locale.ROOT);
    }
}
