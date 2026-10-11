package app.morphe.extension.youtube.patches.eternalhistory;

import android.os.SystemClock;
import android.view.View;

import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Fast watched-card matcher used by the patched Litho alpha path. */
@SuppressWarnings("unused")
public final class EternalWatchedDim {
    private static final int MAX_PENDING = 128;
    private static final long PENDING_TTL_MS = 20_000L;
    private static final ConcurrentHashMap<String, Long> PENDING = new ConcurrentHashMap<>();
    private static final ConcurrentLinkedQueue<String> ORDER = new ConcurrentLinkedQueue<>();

    private EternalWatchedDim() { }

    /**
     * The Litho filter sees the exact accessibility strings for the watched card before its View
     * is mounted. Keeping only these short-lived strings is both more precise and much smaller than
     * retaining every historical video title in memory.
     */
    static void markAccessibility(String accessibilityId, String accessibilityText) {
        if (!EternalHistorySettings.isDimMode()) return;
        final long now = SystemClock.elapsedRealtime();
        mark(accessibilityId, now);
        mark(accessibilityText, now);
        if (accessibilityId != null && !accessibilityId.isBlank()
                && accessibilityText != null && !accessibilityText.isBlank()) {
            mark(accessibilityId + '|' + accessibilityText, now);
        }
        prune(now);
    }

    private static void mark(String value, long now) {
        String key = normalize(value);
        if (key.isEmpty()) return;
        Long previous = PENDING.put(key, now);
        if (previous == null) ORDER.add(key);
    }

    /**
     * Called on the normal Litho mount path. It only decides whether the current card should be
     * dimmed; the bytecode patch invokes YouTube's own node-alpha setter so normal unmount/reuse
     * logic restores the physical View without reflection or per-card database/network work.
     */
    public static boolean shouldDim(View view) {
        if (!EternalHistorySettings.ENABLED.get() || !EternalHistorySettings.isDimMode()) return false;
        if (view == null || PENDING.isEmpty()) return false;

        CharSequence description = view.getContentDescription();
        if (description == null || description.length() == 0) return false;
        String text = normalize(description.toString());
        if (text.isEmpty()) return false;

        long now = SystemClock.elapsedRealtime();
        prune(now);
        String matched = findMatch(text, now);
        if (matched == null) return false;

        // Consume the marker after the matching host is mounted. This sharply limits the chance
        // that another card with identical text later receives the watched opacity by accident.
        PENDING.remove(matched);
        return true;
    }

    private static String findMatch(String description, long now) {
        Long exact = PENDING.get(description);
        if (exact != null && now - exact <= PENDING_TTL_MS) return description;

        for (Map.Entry<String, Long> entry : PENDING.entrySet()) {
            String marker = entry.getKey();
            Long markedAt = entry.getValue();
            if (markedAt == null || now - markedAt > PENDING_TTL_MS) continue;
            if (!description.startsWith(marker) || description.length() == marker.length()) continue;
            char c = description.charAt(marker.length());
            if (isSeparator(c)) return marker;
        }
        return null;
    }

    private static boolean isSeparator(char c) {
        return Character.isWhitespace(c) || c == '·' || c == '•' || c == '-' || c == '|'
                || c == ',' || c == '–' || c == '—' || c == ':' || c == '：';
    }

    private static void prune(long now) {
        for (Map.Entry<String, Long> entry : PENDING.entrySet()) {
            Long markedAt = entry.getValue();
            if (markedAt == null || now - markedAt > PENDING_TTL_MS) {
                PENDING.remove(entry.getKey(), markedAt);
            }
        }
        while (PENDING.size() > MAX_PENDING) {
            String oldest = ORDER.poll();
            if (oldest == null) break;
            PENDING.remove(oldest);
        }
        while (!ORDER.isEmpty() && !PENDING.containsKey(ORDER.peek())) ORDER.poll();
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
