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
            String lowerPath = path.toLowerCase();

            // v1.10.5 crash quarantine: classify only from the Litho path already passed into this
            // filter. Never consult cached NavigationBar/browse/player state while YouTube rebuilds
            // a bottom-tab destination. Shorts presentation remains a strict no-op.
            EternalSurfaceSettings.Surface surface = surfaceFromComponentPath(lowerPath);
            if (surface == EternalSurfaceSettings.Surface.SHORTS) return false;

            String videoId = BufferPhraseFilter.extractVideoIdFromBuffer(buffer);
            if (videoId == null) return false;

            // Page-specific values stay stored for a future safe implementation. During quarantine,
            // use only the migrated/common default profile so filtering is deterministic and has no
            // dependency on host navigation lifecycle. No user preference data is rewritten here.
            EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.defaultProfile(false);
            if (!profile.visualEnabled()) return false;

            EternalHistoryClient.ensureFeedCacheStarted();

            // Hiding has precedence when both rules match. It is evaluated only on a whole-card
            // component so a watched thumbnail can never accidentally remove only a child view.
            if (profile.hideEnabled
                    && looksLikeWholeVideoCard(path, surface)
                    && EternalHistoryClient.isWatchedCached(videoId, profile.effectiveHideThreshold())) {
                return true;
            }

            if (!profile.dimEnabled) return false;
            if (EternalHistorySettings.DIM_CARD_INFO.get()) {
                if (!looksLikeWholeVideoCard(path, surface)) return false;
            } else if (!looksLikeThumbnailComponent(path, surface)) {
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

    private static EternalSurfaceSettings.Surface surfaceFromComponentPath(String lowerPath) {
        if (lowerPath == null || lowerPath.isEmpty()) return EternalSurfaceSettings.Surface.OTHER;
        if (lowerPath.contains("shorts") || lowerPath.contains("reel")) {
            return EternalSurfaceSettings.Surface.SHORTS;
        }
        if (lowerPath.contains("search_video")) {
            return EternalSurfaceSettings.Surface.SEARCH;
        }
        if (lowerPath.contains("related_video") || lowerPath.contains("compact_video")) {
            return EternalSurfaceSettings.Surface.WATCH;
        }
        if (lowerPath.contains("playlist") || lowerPath.contains("video_list_entry")) {
            return EternalSurfaceSettings.Surface.PLAYLIST_DETAIL;
        }
        if (lowerPath.contains("home_video")) {
            return EternalSurfaceSettings.Surface.HOME;
        }
        return EternalSurfaceSettings.Surface.OTHER;
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

    private static boolean looksLikeWholeVideoCard(String path, EternalSurfaceSettings.Surface surface) {
        if (path == null || path.isEmpty()) return false;
        String lower = path.toLowerCase();
        boolean known = looksLikeVideoContext(lower);
        if (!known && isPlaylistLikeSurface(surface)) {
            // New YouTube playlist pages increasingly use generic lockup view-model names instead
            // of the old playlist_video renderer names. On these already-known video-list surfaces,
            // a component carrying an extracted video id is accepted as a card only when its path
            // looks like a video/lockup root and not one of the child-view paths below.
            known = lower.contains("video") || lower.contains("lockup");
        }
        if (!known) return false;
        for (String child : CHILD_EXCEPTIONS) {
            if (lower.contains(child)) return false;
        }
        return true;
    }

    private static boolean looksLikeThumbnailComponent(String path, EternalSurfaceSettings.Surface surface) {
        if (path == null) return false;
        String lower = path.toLowerCase();
        for (String thumbnail : THUMBNAIL_COMPONENTS) {
            if (lower.contains(thumbnail)) return true;
        }
        return isPlaylistLikeSurface(surface)
                && (lower.contains("thumbnail") || lower.contains("content_image") || lower.contains("lockup_image"));
    }

    private static boolean isPlaylistLikeSurface(EternalSurfaceSettings.Surface surface) {
        return surface == EternalSurfaceSettings.Surface.WATCH_LATER
                || surface == EternalSurfaceSettings.Surface.LIKED
                || surface == EternalSurfaceSettings.Surface.PLAYLIST_DETAIL
                || surface == EternalSurfaceSettings.Surface.HISTORY
                || surface == EternalSurfaceSettings.Surface.PLAYLISTS;
    }

    private EternalWatchedFilter() { }
}
