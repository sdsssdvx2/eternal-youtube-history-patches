package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.patches.components.ContextInterface;

/** Tracks stable YouTube surface signals without participating in host navigation callbacks. */
@SuppressWarnings("unused")
public final class EternalSurfaceTracker {
    private static volatile String lastBrowseId = "";
    private static volatile EternalSurfaceSettings.Surface lastUiSurface = EternalSurfaceSettings.Surface.HOME;

    /** Injection point beside YouTube's own browse-id load. Does not mutate the browse id. */
    public static void onBrowseId(@Nullable String browseId) {
        try {
            if (browseId == null || browseId.isBlank()) return;
            lastBrowseId = browseId;
            EternalSurfaceSettings.Surface mapped = fromBrowseId(browseId);
            if (mapped != EternalSurfaceSettings.Surface.OTHER) publishSurface(mapped);
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal browse surface update ignored: " + safeMessage(t));
        }
    }

    /**
     * Component classification uses only Eternal-owned cached signals plus the Litho path already
     * handed to the filter. It deliberately performs no NavigationBar/PlayerType/search queries and
     * is not registered as a YouTube navigation callback.
     */
    static EternalSurfaceSettings.Surface forComponent(ContextInterface contextInterface, String path) {
        try {
            EternalSurfaceSettings.Surface cached = lastUiSurface;
            if (cached == EternalSurfaceSettings.Surface.SHORTS) {
                return EternalSurfaceSettings.Surface.SHORTS;
            }

            String lower = path == null ? "" : path.toLowerCase();
            if (lower.contains("search_video")) {
                return publishAndReturn(EternalSurfaceSettings.Surface.SEARCH);
            }
            if (looksRelated(lower)) {
                return publishAndReturn(EternalSurfaceSettings.Surface.WATCH);
            }
            if (lower.contains("home_video")) {
                return publishAndReturn(EternalSurfaceSettings.Surface.HOME);
            }

            EternalSurfaceSettings.Surface browse = fromBrowseId(lastBrowseId);
            if (browse != EternalSurfaceSettings.Surface.OTHER) {
                return publishAndReturn(browse);
            }
            return cached == null ? EternalSurfaceSettings.Surface.OTHER : cached;
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal component surface classification ignored: " + safeMessage(t));
            EternalSurfaceSettings.Surface cached = lastUiSurface;
            return cached == null ? EternalSurfaceSettings.Surface.OTHER : cached;
        }
    }

    /** Main-thread UI classification is intentionally just the last stable cached signal. */
    static EternalSurfaceSettings.Surface currentForUi() {
        EternalSurfaceSettings.Surface surface = lastUiSurface;
        return surface == null ? EternalSurfaceSettings.Surface.OTHER : surface;
    }

    private static EternalSurfaceSettings.Surface publishAndReturn(EternalSurfaceSettings.Surface surface) {
        publishSurface(surface);
        return surface;
    }

    private static void publishSurface(EternalSurfaceSettings.Surface surface) {
        if (surface == null || surface == EternalSurfaceSettings.Surface.OTHER) return;
        EternalSurfaceSettings.Surface previous = lastUiSurface;
        lastUiSurface = surface;
        if (previous != surface) EternalHistoryToolbar.onSurfaceChanged();
    }

    private static EternalSurfaceSettings.Surface fromBrowseId(String browseId) {
        if (browseId == null || browseId.isBlank()) return EternalSurfaceSettings.Surface.OTHER;
        return switch (browseId) {
            case "FEwhat_to_watch" -> EternalSurfaceSettings.Surface.HOME;
            case "FEshorts" -> EternalSurfaceSettings.Surface.SHORTS;
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

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return message == null ? (t == null ? "unknown" : t.getClass().getSimpleName()) : message;
    }

    private EternalSurfaceTracker() { }
}
