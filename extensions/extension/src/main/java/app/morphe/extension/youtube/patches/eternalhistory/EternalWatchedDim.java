package app.morphe.extension.youtube.patches.eternalhistory;

import android.os.SystemClock;
import android.view.View;

import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Fast watched-card matcher used by the patched Litho alpha path. */
@SuppressWarnings("unused")
public final class EternalWatchedDim {
    private static final int MAX_PENDING = 128;
    private static final long PENDING_TTL_MS = 20_000L;
    private static final long DUPLICATE_WINDOW_MS = 1_000L;

    /** One entry per watched card classification, in the same order Litho discovers cards. */
    private static final ConcurrentLinkedQueue<PendingCard> PENDING = new ConcurrentLinkedQueue<>();
    private static final ConcurrentHashMap<String, Long> LAST_MARKED_VIDEO = new ConcurrentHashMap<>();

    private static final class PendingCard {
        final String videoId;
        final String accessibilityId;
        final String accessibilityText;
        final long markedAt;

        PendingCard(String videoId, String accessibilityId, String accessibilityText, long markedAt) {
            this.videoId = videoId;
            this.accessibilityId = accessibilityId;
            this.accessibilityText = accessibilityText;
            this.markedAt = markedAt;
        }

        boolean hasAccessibility() {
            return !accessibilityId.isEmpty() || !accessibilityText.isEmpty();
        }
    }

    private EternalWatchedDim() { }

    /**
     * Called when Eternal positively identifies a watched whole-card from its protobuf video id.
     * Accessibility strings are only hints: on some YouTube layouts they are absent or formatted
     * differently from the final Android View contentDescription, so the video id itself is also
     * retained to keep one pending decision per card.
     */
    static void markCard(String videoId, String accessibilityId, String accessibilityText) {
        if (!EternalHistorySettings.isDimMode() || videoId == null || videoId.length() != 11) return;

        final long now = SystemClock.elapsedRealtime();
        Long previous = LAST_MARKED_VIDEO.put(videoId, now);
        if (previous != null && now - previous < DUPLICATE_WINDOW_MS) return;

        PENDING.add(new PendingCard(
                videoId,
                normalize(accessibilityId),
                normalize(accessibilityText),
                now
        ));
        prune(now);
    }

    /**
     * Called on YouTube's normal Litho mount path. The bytecode hook then uses the node's own
     * alpha setter, so normal Litho unmount/reuse restores alpha to 1.0 and opacity cannot leak to
     * an unrelated recycled card.
     */
    public static boolean shouldDim(View view) {
        if (!EternalHistorySettings.ENABLED.get() || !EternalHistorySettings.isDimMode()) return false;
        if (view == null || PENDING.isEmpty()) return false;

        final long now = SystemClock.elapsedRealtime();
        prune(now);
        if (PENDING.isEmpty()) return false;

        CharSequence description = view.getContentDescription();
        String text = description == null ? "" : normalize(description.toString());

        // Preferred path: correlate the final mounted accessibility text with the filter's hints.
        if (!text.isEmpty()) {
            for (PendingCard card : PENDING) {
                if (now - card.markedAt > PENDING_TTL_MS) continue;
                if (matches(text, card.accessibilityId) || matches(text, card.accessibilityText)) {
                    if (PENDING.remove(card)) {
                        LAST_MARKED_VIDEO.remove(card.videoId, card.markedAt);
                        return true;
                    }
                }
            }
        }

        // Some YouTube cards expose no usable accessibility string at the protobuf-filter stage.
        // Morphe intentionally serializes Litho layout work to one worker thread, so in that case
        // the next mounted view carrying a real contentDescription is the safest deterministic
        // fallback. Do not use this fallback when hints existed but failed to match.
        PendingCard first = PENDING.peek();
        if (first != null && !first.hasAccessibility() && !text.isEmpty()) {
            PendingCard consumed = PENDING.poll();
            if (consumed != null) {
                LAST_MARKED_VIDEO.remove(consumed.videoId, consumed.markedAt);
                return true;
            }
        }

        return false;
    }

    private static boolean matches(String description, String marker) {
        if (marker == null || marker.isEmpty()) return false;
        if (description.equals(marker)) return true;
        // YouTube commonly prefixes/suffixes title accessibility with badges, channel and duration.
        // A reasonably long marker is specific enough while tolerating those layout differences.
        if (marker.length() >= 6 && description.contains(marker)) return true;
        return description.length() >= 6 && marker.contains(description);
    }

    private static void prune(long now) {
        for (Iterator<PendingCard> it = PENDING.iterator(); it.hasNext();) {
            PendingCard card = it.next();
            if (now - card.markedAt > PENDING_TTL_MS) {
                PENDING.remove(card);
                LAST_MARKED_VIDEO.remove(card.videoId, card.markedAt);
            }
        }
        while (PENDING.size() > MAX_PENDING) {
            PendingCard oldest = PENDING.poll();
            if (oldest == null) break;
            LAST_MARKED_VIDEO.remove(oldest.videoId, oldest.markedAt);
        }
    }

    /** Avoid regex allocation in the mount path; normalize whitespace and common separators. */
    private static String normalize(String value) {
        if (value == null) return "";
        int length = value.length();
        StringBuilder out = new StringBuilder(length);
        boolean pendingSpace = false;
        for (int i = 0; i < length; i++) {
            char c = value.charAt(i);
            if (Character.isWhitespace(c) || c == '·' || c == '•' || c == '|' || c == ','
                    || c == '–' || c == '—' || c == ':' || c == '：') {
                if (out.length() > 0) pendingSpace = true;
                continue;
            }
            if (pendingSpace) {
                out.append(' ');
                pendingSpace = false;
            }
            out.append(c);
        }
        return out.toString().trim().toLowerCase(Locale.ROOT);
    }
}
