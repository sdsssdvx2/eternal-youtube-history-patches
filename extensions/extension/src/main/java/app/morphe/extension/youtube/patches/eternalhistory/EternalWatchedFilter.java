package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.patches.components.BufferPhraseFilter;
import app.morphe.extension.shared.patches.components.ContextInterface;

/** Fast local watched-video styling decision for feed/list Litho components. */
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
    private static final String[] THUMBNAIL_COMPONENTS = {
            "thumbnail.e",
            "video_lockup_thumbnail.e",
            "shorts-lockup-image",
            "shorts_thumbnail",
            "shorts-thumbnail"
    };

    public static boolean shouldHide(ContextInterface contextInterface, @Nullable byte[] buffer,
                                     @Nullable String accessibilityId,
                                     @Nullable String accessibilityText) {
        EternalWatchedDim.beginCardDecision();
        try {
            if (!EternalHistorySettings.ENABLED.get()
                    || !EternalHistorySettings.isFeedVisualEnabled()) return false;
            if (contextInterface == null || buffer == null || buffer.length == 0) return false;

            StringBuilder pathBuilder = contextInterface.patch_getPathBuilder();
            if (pathBuilder == null) return false;
            String path = pathBuilder.toString();

            String videoId = BufferPhraseFilter.extractVideoIdFromBuffer(buffer);
            if (videoId == null) return false;

            if (EternalHistorySettings.isHideMode()) {
                if (!looksLikeWholeVideoCard(path)) return false;
            } else if (EternalHistorySettings.isDimMode()) {
                if (EternalHistorySettings.DIM_CARD_INFO.get()) {
                    if (!looksLikeWholeVideoCard(path)) return false;
                } else if (!looksLikeThumbnailComponent(path)) {
                    return false;
                }
            } else {
                return false;
            }

            EternalHistoryClient.ensureFeedCacheStarted();
            if (!EternalHistoryClient.isWatchedCached(
                    videoId, EternalHistorySettings.HIDE_MIN_PROGRESS.get())) {
                return false;
            }

            if (EternalHistorySettings.isDimMode()) {
                EternalWatchedDim.markCard(videoId, accessibilityId, accessibilityText);
                return false;
            }
            return true;
        } catch (Throwable t) {
            Logger.printException(() -> "Eternal watched-card filter failure", t);
            return false;
        }
    }

    private static boolean looksLikeVideoContext(String path) {
        for (String root : ROOT_CARD_PATHS) {
            if (path.startsWith(root)) return true;
        }
        for (String nested : NESTED_CARD_PATHS) {
            if (path.contains(nested)) return true;
        }
        return false;
    }

    private static boolean looksLikeWholeVideoCard(String path) {
        if (!looksLikeVideoContext(path)) return false;
        for (String child : CHILD_EXCEPTIONS) {
            if (path.contains(child)) return false;
        }
        return true;
    }

    private static boolean looksLikeThumbnailComponent(String path) {
        for (String thumbnail : THUMBNAIL_COMPONENTS) {
            if (path.contains(thumbnail)) return true;
        }
        return false;
    }

    private EternalWatchedFilter() { }
}
