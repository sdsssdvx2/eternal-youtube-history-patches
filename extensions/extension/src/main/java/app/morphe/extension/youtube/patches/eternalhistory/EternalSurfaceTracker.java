package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.patches.components.ContextInterface;

/** Tracks passive YouTube surface signals without touching host navigation/UI lifecycle. */
@SuppressWarnings("unused")
public final class EternalSurfaceTracker {
    private static volatile String lastBrowseId = "";
    private static volatile EternalSurfaceSettings.Surface lastBrowseSurface = EternalSurfaceSettings.Surface.HOME;

    /** Injection point beside YouTube's own browse-id load. Observation only; never mutates host UI. */
    public static void onBrowseId(@Nullable String browseId) {
        try {
            if (browseId == null || browseId.isBlank()) return;
            lastBrowseId = browseId;
            EternalSurfaceSettings.Surface mapped = fromBrowseId(browseId);
            if (mapped != EternalSurfaceSettings.Surface.OTHER) lastBrowseSurface = mapped;
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal browse surface update ignored: " + safeMessage(t));
        }
    }

    /**
     * Component classification is deliberately pure. This method is called from the high-frequency
     * Litho filtering path while YouTube may be constructing a new tab. It must never publish UI
     * state, schedule overlay work, or call back into NavigationBar/PlayerType/search state.
     */
    static EternalSurfaceSettings.Surface forComponent(ContextInterface contextInterface, String path) {
        try {
            String lower = path == null ? "" : path.toLowerCase();

            // Shorts components do not benefit from Eternal card presentation. Treat all explicit
            // Shorts component paths as no-op surfaces, which also avoids work during Shorts startup.
            if (looksLikeShorts(lower)) return EternalSurfaceSettings.Surface.SHORTS;
            if (lower.contains("search_video")) return EternalSurfaceSettings.Surface.SEARCH;
            if (looksRelated(lower)) return EternalSurfaceSettings.Surface.WATCH;
            if (lower.contains("home_video")) return EternalSurfaceSettings.Surface.HOME;

            EternalSurfaceSettings.Surface browse = fromBrowseId(lastBrowseId);
            if (browse != EternalSurfaceSettings.Surface.OTHER) return browse;
            EternalSurfaceSettings.Surface cached = lastBrowseSurface;
            return cached == null ? EternalSurfaceSettings.Surface.OTHER : cached;
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal component surface classification ignored: " + safeMessage(t));
            EternalSurfaceSettings.Surface cached = lastBrowseSurface;
            return cached == null ? EternalSurfaceSettings.Surface.OTHER : cached;
        }
    }

    /** Retained only for diagnostics/backward binary compatibility; no overlay consumes it. */
    static EternalSurfaceSettings.Surface currentForUi() {
        EternalSurfaceSettings.Surface surface = lastBrowseSurface;
        return surface == null ? EternalSurfaceSettings.Surface.OTHER : surface;
    }

    private static EternalSurfaceSettings.Surface fromBrowseId(String browseId) {
        if (browseId == null || browseId.isBlank()) return EternalSurfaceSettings.Surface.OTHER;
        return switch (browseId) {
            case "FEwhat_to_watch" -> EternalSurfaceSettings.Surface.HOME;
            case "FEsubscriptions", "FEchannels" -> EternalSurfaceSettings.Surface.SUBSCRIPTIONS;
            case "FEhistory" -> EternalSurfaceSettings.Surface.HISTORY;
            case "FEplaylist_aggregation" -> EternalSurfaceSettings.Surface.PLAYLISTS;
            case "VLWL" -> EternalSurfaceSettings.Surface.WATCH_LATER;
            case "VLLL" -> EternalSurfaceSettings.Surface.LIKED;
            case "FElibrary" -> EternalSurfaceSettings.Surface.LIBRARY;
            default -> {
                if (browseId.startsWith("UC")) yield EternalSurfaceSettings.Surface.CHANNEL;
                if (browseId.startsWith("VL") || browseId.startsWith("PL")) yield EternalSurfaceSettings.Surface.PLAYLIST_DETAIL;
                yield EternalSurfaceSettings.Surface.OTHER;
            }
        };
    }

    private static boolean looksRelated(String lowerPath) {
        return lowerPath != null
                && (lowerPath.contains("related_video") || lowerPath.contains("compact_video"));
    }

    private static boolean looksLikeShorts(String lowerPath) {
        return lowerPath != null && (lowerPath.contains("shorts_video")
                || lowerPath.contains("shorts_pivot")
                || lowerPath.contains("shorts_lockup")
                || lowerPath.contains("reel_item"));
    }

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return message == null ? (t == null ? "unknown" : t.getClass().getSimpleName()) : message;
    }

    private EternalSurfaceTracker() { }
}
