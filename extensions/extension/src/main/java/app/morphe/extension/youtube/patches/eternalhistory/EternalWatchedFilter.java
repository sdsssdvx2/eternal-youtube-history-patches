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
            "video_list_entry"
    };
    private static final String[] NESTED_CARD_PATHS = {
            "video_card.e",
            "video_lockup"
    };
    private static final String[] CHILD_EXCEPTIONS = {
            "metadata",
            "thumbnail",
            "avatar",
            "overflow",
            "menu_button",
            "badge",
            "button.e"
    };
    private static final String[] THUMBNAIL_COMPONENTS = {
            "thumbnail.e",
            "video_lockup_thumbnail.e",
            "playlist_video_thumbnail",
            "lockup_thumbnail",
            "content_image",
            "lockup_image"
    };

    public static boolean shouldHide(ContextInterface contextInterface, @Nullable byte[] buffer,
                                     @Nullable String accessibilityId,
                                     @Nullable String accessibilityText) {
        EternalWatchedDim.beginCardDecision();
        try {
            if (!EternalHistorySettings.ENABLED.get()) return false;
            if (contextInterface == null || buffer == null || buffer.length == 0) return false;

            EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.defaultProfile(false);
            if (!profile.visualEnabled()) return false;

            StringBuilder pathBuilder = contextInterface.patch_getPathBuilder();
            if (pathBuilder == null) return false;
            String path = pathBuilder.toString();

            String videoId = BufferPhraseFilter.extractVideoIdFromBuffer(buffer);
            if (videoId == null) return false;

            // v1.10.5 intentionally has no surface/navigation lookup here. Full-screen Shorts is
            // excluded structurally by omitting every Shorts component path from the allow-list.
            // This keeps the filter independent from YouTube tab-transition state.
            EternalHistoryClient.ensureFeedCacheStarted();

            // Hide takes precedence when both rules are enabled, matching v1.10.x profile semantics.
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
        String lower = path.toLowerCase();
        for (String root : ROOT_CARD_PATHS) {
            if (lower.startsWith(root) || lower.contains(root)) return true;
        }
        for (String nested : NESTED_CARD_PATHS) {
            if (lower.contains(nested)) return true;
        }
        return false;
    }

    private static boolean looksLikeWholeVideoCard(String path) {
        if (path == null || path.isEmpty()) return false;
        String lower = path.toLowerCase();
        if (!looksLikeVideoContext(lower)) return false;
        for (String child : CHILD_EXCEPTIONS) {
            if (lower.contains(child)) return false;
        }
        return true;
    }

    private static boolean looksLikeThumbnailComponent(String path) {
        if (path == null || path.isEmpty()) return false;
        String lower = path.toLowerCase();
        if (!looksLikeVideoContext(lower)) return false;
        for (String thumbnail : THUMBNAIL_COMPONENTS) {
            if (lower.contains(thumbnail)) return true;
        }
        return false;
    }

    private EternalWatchedFilter() { }
}
