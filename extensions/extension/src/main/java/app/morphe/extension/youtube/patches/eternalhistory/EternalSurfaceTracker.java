package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.patches.components.ContextInterface;
import app.morphe.extension.youtube.shared.NavigationBar;

/**
 * Historical v1.10.x surface classifier retained only so stored page-profile data stays readable.
 * v1.10.5 installs no browse-id or bottom-navigation hook and no active filter/UI calls this class.
 * Even if an old call site survives in a stale process, updates here are cache-only and never touch UI.
 */
@SuppressWarnings("unused")
public final class EternalSurfaceTracker {
    private static volatile String lastBrowseId = "";
    private static volatile EternalSurfaceSettings.Surface lastUiSurface = EternalSurfaceSettings.Surface.HOME;

    /** Historical injection target; v1.10.5 no longer installs the browse-id hook. */
    public static void onBrowseId(@Nullable String browseId) {
        try {
            if (browseId == null || browseId.isBlank()) return;
            lastBrowseId = browseId;
            EternalSurfaceSettings.Surface mapped = fromBrowseId(browseId);
            if (mapped != EternalSurfaceSettings.Surface.OTHER) publishSurface(mapped);
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal dormant browse surface update ignored: " + safeMessage(t));
        }
    }

    /** Historical target; v1.10.5 does not register a NavigationBar listener. */
    static void onNavigationChanged(@Nullable NavigationBar.NavigationButton button) {
        try {
            if (button == NavigationBar.NavigationButton.HOME) {
                lastBrowseId = "FEwhat_to_watch";
                publishSurface(EternalSurfaceSettings.Surface.HOME);
            } else if (button == NavigationBar.NavigationButton.SUBSCRIPTIONS) {
                lastBrowseId = "FEsubscriptions";
                publishSurface(EternalSurfaceSettings.Surface.SUBSCRIPTIONS);
            } else if (button == NavigationBar.NavigationButton.LIBRARY) {
                lastBrowseId = "FElibrary";
                publishSurface(EternalSurfaceSettings.Surface.LIBRARY);
            } else if (button == NavigationBar.NavigationButton.SHORTS) {
                lastBrowseId = "";
                publishSurface(EternalSurfaceSettings.Surface.SHORTS);
            }
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal dormant navigation surface update ignored: " + safeMessage(t));
        }
    }

    /** Historical classifier retained for source compatibility; active v1.10.5 filters do not call it. */
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
            Logger.printDebug(() -> "Eternal dormant component classification ignored: " + safeMessage(t));
            EternalSurfaceSettings.Surface cached = lastUiSurface;
            return cached == null ? EternalSurfaceSettings.Surface.OTHER : cached;
        }
    }

    static EternalSurfaceSettings.Surface currentForUi() {
        EternalSurfaceSettings.Surface surface = lastUiSurface;
        return surface == null ? EternalSurfaceSettings.Surface.OTHER : surface;
    }

    private static EternalSurfaceSettings.Surface publishAndReturn(EternalSurfaceSettings.Surface surface) {
        publishSurface(surface);
        return surface;
    }

    /** Cache-only by design: no toolbar callback, no adapter refresh, no host navigation access. */
    private static void publishSurface(EternalSurfaceSettings.Surface surface) {
        if (surface == null || surface == EternalSurfaceSettings.Surface.OTHER) return;
        lastUiSurface = surface;
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

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return message == null ? (t == null ? "unknown" : t.getClass().getSimpleName()) : message;
    }

    private EternalSurfaceTracker() { }
}
