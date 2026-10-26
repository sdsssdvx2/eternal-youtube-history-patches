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
            "playlist_video",
            "playlist_lockup",
            "video_list_entry",
            "inline_shorts",
            "shorts_video_cell",
            "shorts_pivot_item.e"
    };
    private static final String[] NESTED_CARD_PATHS = {
            "shorts_lockup_cell.e",
            "video_card.e",
            "video_lockup"
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
            "shorts-thumbnail",
            "playlist_video_thumbnail",
            "lockup_thumbnail"
    };

    public static boolean shouldHide(ContextInterface contextInterface, @Nullable byte[] buffer,
                                     @Nullable String accessibilityId,
                                     @Nullable String accessibilityText) {
        EternalWatchedDim.beginCardDecision();
        try {
            if (!EternalHistorySettings.ENABLED.get()) return false;
            if (contextInterface == null || buffer == null || buffer.length == 0) return false;

            StringBuilder pathBuilder = contextInterface.patch_getPathBuilder();
            if (pathBuilder == null) return false;
            String path = pathBuilder.toString();

            String videoId = BufferPhraseFilter.extractVideoIdFromBuffer(buffer);
            if (videoId == null) return false;

            EternalSurfaceSettings.Surface surface = EternalSurfaceTracker.forComponent(contextInterface, path);
            EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.get(surface);
            if (!profile.visualEnabled()) return false;

            EternalHistoryClient.ensureFeedCacheStarted();

            // Hiding has precedence when both rules match. It is evaluated only on a whole-card
            // component so a watched thumbnail can never accidentally remove only a child view.
            if (profile.hideEnabled
                    && looksLikeWholeVideoCard(path)
                    && EternalHistoryClient.isWatchedCached(videoId, profile.effectiveHideThreshold())) {
                return true;
            }

            if (!profile.dimEnabled) return false;
            if (EternalHistorySettings.DIM_CARD_INFO.get()) {
                if (!looksLikeWholeVideoCard(path)) return false;
            } else if (!looksLikeThumbnailComponent(path)) {
                return false;
            }

            if (!EternalHistoryClient.isWatchedCached(videoId, profile.effectiveDimThreshold())) {
                return false;
            }

            EternalWatchedDim.markCard(videoId, accessibilityId, accessibilityText);
            return false;
        } catch (Throwable t) {
            Logger.printException(() -> "Eternal watched-card filter failure", t);
            return false;
        }
    }

    private static boolean looksLikeVideoContext(String path) {
        if (path == null || path.isEmpty()) return false;
        for (String root : ROOT_CARD_PATHS) {
            if (path.startsWith(root) || path.contains(root)) return true;
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
        if (path == null) return false;
        for (String thumbnail : THUMBNAIL_COMPONENTS) {
            if (path.contains(thumbnail)) return true;
        }
        return false;
    }

    private EternalWatchedFilter() { }
}
