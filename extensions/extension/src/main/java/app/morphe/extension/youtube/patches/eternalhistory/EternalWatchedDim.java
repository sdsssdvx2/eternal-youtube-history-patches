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
        final String cachedTitle;
        final String accessibilityId;
        final String accessibilityText;
        final long markedAt;

        PendingCard(String videoId, String cachedTitle, String accessibilityId,
                    String accessibilityText, long markedAt) {
            this.videoId = videoId;
            this.cachedTitle = cachedTitle;
            this.accessibilityId = accessibilityId;
            this.accessibilityText = accessibilityText;
            this.markedAt = markedAt;
        }

        boolean hasCorrelationHint() {
            return !cachedTitle.isEmpty() || !accessibilityId.isEmpty() || !accessibilityText.isEmpty();
        }
    }

    private EternalWatchedDim() { }

    /**
     * Called when Eternal positively identifies a watched whole-card from its protobuf video id.
     * The local D1 title cache is the strongest mount-time correlation key because accessibility
     * id/text formatting differs across YouTube layouts and can be empty even when the final View
     * exposes a useful contentDescription.
     */
    static void markCard(String videoId, String accessibilityId, String accessibilityText) {
        if (!EternalHistorySettings.isDimMode() || videoId == null || videoId.length() != 11) return;

        final long now = SystemClock.elapsedRealtime();
        Long previous = LAST_MARKED_VIDEO.put(videoId, now);
        if (previous != null && now - previous < DUPLICATE_WINDOW_MS) return;

        PENDING.add(new PendingCard(
                videoId,
                normalize(EternalHistoryClient.cachedTitle(videoId)),
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

        if (!text.isEmpty()) {
            for (PendingCard card : PENDING) {
                if (now - card.markedAt > PENDING_TTL_MS) continue;

                // The watched cache already knows the canonical title for this exact videoId.
                // Prefer it over layout-specific accessibility fields. YouTube's final content
                // description commonly contains the title plus channel/badge/duration metadata.
                boolean titleMatch = matchesTitle(text, card.cachedTitle);
                boolean accessibilityMatch = matches(text, card.accessibilityId)
                        || matches(text, card.accessibilityText);
                if (titleMatch || accessibilityMatch) {
                    if (PENDING.remove(card)) {
                        LAST_MARKED_VIDEO.remove(card.videoId, card.markedAt);
                        return true;
                    }
                }
            }
        }

        // Only use ordering when the watched card had no title or accessibility correlation key.
        // This avoids dimming an unrelated View merely because a useful hint existed but YouTube
        // represented it differently at mount time.
        PendingCard first = PENDING.peek();
        if (first != null && !first.hasCorrelationHint() && !text.isEmpty()) {
            PendingCard consumed = PENDING.poll();
            if (consumed != null) {
                LAST_MARKED_VIDEO.remove(consumed.videoId, consumed.markedAt);
                return true;
            }
        }

        return false;
    }

    private static boolean matchesTitle(String description, String title) {
        if (title == null || title.isEmpty()) return false;
        if (description.equals(title)) return true;
        // A cached title is tied to the authoritative protobuf videoId, so it can safely be a
        // slightly shorter substring than generic accessibility hints. For very short titles only
        // accept a prefix match to avoid accidental matches inside unrelated descriptions.
        if (title.length() >= 4) return description.contains(title);
        return description.startsWith(title);
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
