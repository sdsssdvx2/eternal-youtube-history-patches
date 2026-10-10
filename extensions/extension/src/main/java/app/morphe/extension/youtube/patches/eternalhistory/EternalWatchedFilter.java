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

    public static boolean shouldHide(ContextInterface contextInterface, @Nullable byte[] buffer) {
        if (!EternalHistorySettings.ENABLED.get() || !EternalHistorySettings.HIDE_WATCHED.get()) return false;
        EternalHistoryClient.ensureFeedCacheStarted();
        if (contextInterface == null || buffer == null || buffer.length == 0) return false;

        try {
            StringBuilder pb = contextInterface.patch_getPathBuilder();
            if (pb == null || pb.length() == 0) return false;
            String path = pb.toString();
            if (!looksLikeWholeVideoCard(path)) return false;

            String videoId = BufferPhraseFilter.extractVideoIdFromBuffer(buffer);
            if (videoId == null || videoId.length() != 11) return false;
            int minProgress = Math.max(0, Math.min(100, EternalHistorySettings.HIDE_MIN_PROGRESS.get()));
            return EternalHistoryClient.isWatchedCached(videoId, minProgress);
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal watched-card filter skipped: " + t.getMessage());
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
