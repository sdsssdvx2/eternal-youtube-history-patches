package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.patches.components.BufferPhraseFilter;
import app.morphe.extension.shared.patches.components.ContextInterface;

/**
 * Fast local feed-card decision. The Worker is never queried per card.
 * This hook is called from Morphe's existing Litho filter path, off the main thread.
 */
@SuppressWarnings("unused")
public final class EternalWatchedFilter {
    private static final String[] ROOT_CARD_PATHS = {
            "home_video_with_context.e",
            "search_video_with_context.e",
            "video_with_context.e",
            "related_video_with_context.e",
            "video_lockup_with_attachment.e",
            "compact_video.e",
            "inline_shorts",
            "shorts_video_cell",
            "shorts_pivot_item.e"
    };
    private static final String[] NESTED_CARD_PATHS = {
            "shorts_lockup_cell.e",
            "video_card.e"
    };
    private static final String[] CHILD_EXCEPTIONS = {
            "metadata.e",
            "thumbnail.e",
            "avatar.e",
            "overflow_button.e"
    };

    public static boolean shouldHide(ContextInterface contextInterface, @Nullable byte[] buffer,
                                     @Nullable String accessibilityId,
                                     @Nullable String accessibilityText) {
        // This method is invoked exactly once for every component through Morphe's filter entry.
        // Clear any prior hand-off first so a filtered/aborted component can never contaminate the
        // next one processed by the same Litho worker thread.
        EternalWatchedDim.beginCardDecision();
        try {
            if (!EternalHistorySettings.ENABLED.get()
                    || !EternalHistorySettings.isFeedVisualEnabled()) return false;
            if (contextInterface == null || buffer == null || buffer.length == 0) return false;

            StringBuilder pathBuilder = contextInterface.patch_getPathBuilder();
            if (pathBuilder == null || !looksLikeWholeVideoCard(pathBuilder.toString())) return false;

            // Lazy-start the local permanent-history cache only when feed visuals actually need it.
            EternalHistoryClient.ensureFeedCacheStarted();

            String videoId = BufferPhraseFilter.extractVideoIdFromBuffer(buffer);
            if (!EternalHistoryClient.isWatchedCached(
                    videoId, EternalHistorySettings.HIDE_MIN_PROGRESS.get())) {
                return false;
            }

            if (EternalHistorySettings.isDimMode()) {
                // The protobuf videoId/local cache decision is authoritative. A tiny ThreadLocal
                // hand-off lets the bytecode patch apply alpha to this exact returned component.
                EternalWatchedDim.markCard(videoId, accessibilityId, accessibilityText);
                return false;
            }
            return EternalHistorySettings.isHideMode();
        } catch (Throwable t) {
            // Feed rendering must always fail open. A future YouTube/Morphe layout change should
            // never make the feed disappear or crash just because Eternal could not classify it.
            Logger.printException(() -> "Eternal watched-card filter failure", t);
            return false;
        }
    }

    private static boolean looksLikeWholeVideoCard(String path) {
        for (String child : CHILD_EXCEPTIONS) {
            if (path.contains(child)) return false;
        }
        for (String root : ROOT_CARD_PATHS) {
            if (path.startsWith(root)) return true;
        }
        for (String nested : NESTED_CARD_PATHS) {
            if (path.contains(nested)) return true;
        }
        return false;
    }

    private EternalWatchedFilter() { }
}
