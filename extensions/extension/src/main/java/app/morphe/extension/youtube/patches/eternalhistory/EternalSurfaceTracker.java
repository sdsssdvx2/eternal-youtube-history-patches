package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.shared.patches.components.ContextInterface;
import app.morphe.extension.youtube.shared.NavigationBar;
import app.morphe.extension.youtube.shared.PlayerType;

/** Tracks enough YouTube navigation state to choose a device-local page profile. */
@SuppressWarnings("unused")
public final class EternalSurfaceTracker {
    private static volatile String lastBrowseId = "";

    /** Injection point beside YouTube's own browse-id load. Does not mutate the browse id. */
    public static void onBrowseId(@Nullable String browseId) {
        if (browseId == null || browseId.isBlank()) return;
        lastBrowseId = browseId;
        EternalHistoryToolbar.onSurfaceChanged();
    }

    static void onNavigationChanged(@Nullable NavigationBar.NavigationButton button) {
        if (button == NavigationBar.NavigationButton.HOME) lastBrowseId = "FEwhat_to_watch";
        else if (button == NavigationBar.NavigationButton.SUBSCRIPTIONS) lastBrowseId = "FEsubscriptions";
        else if (button == NavigationBar.NavigationButton.LIBRARY) lastBrowseId = "FElibrary";
        else if (button == NavigationBar.NavigationButton.SHORTS) lastBrowseId = "";
        EternalHistoryToolbar.onSurfaceChanged();
    }

    static EternalSurfaceSettings.Surface forComponent(ContextInterface contextInterface, String path) {
        if (NavigationBar.isSearchBarActive()) return EternalSurfaceSettings.Surface.SEARCH;

        NavigationBar.NavigationButton nav = null;
        try {
            nav = NavigationBar.NavigationButton.getSelectedNavigationButton(contextInterface);
        } catch (Throwable ignored) { }

        if (nav == NavigationBar.NavigationButton.SHORTS || containsShorts(path)) {
            return EternalSurfaceSettings.Surface.SHORTS;
        }
        if (PlayerType.getCurrent().isMaximizedOrFullscreen() || looksRelated(path)) {
            return EternalSurfaceSettings.Surface.WATCH;
        }

        EternalSurfaceSettings.Surface browse = fromBrowseId(lastBrowseId);
        if (NavigationBar.isBackButtonVisible() && browse != EternalSurfaceSettings.Surface.OTHER) {
            return browse;
        }

        if (nav == NavigationBar.NavigationButton.SUBSCRIPTIONS) return EternalSurfaceSettings.Surface.SUBSCRIPTIONS;
        if (nav == NavigationBar.NavigationButton.LIBRARY) {
            return browse == EternalSurfaceSettings.Surface.OTHER ? EternalSurfaceSettings.Surface.LIBRARY : browse;
        }
        if (browse == EternalSurfaceSettings.Surface.CHANNEL
                || browse == EternalSurfaceSettings.Surface.WATCH_LATER
                || browse == EternalSurfaceSettings.Surface.LIKED
                || browse == EternalSurfaceSettings.Surface.PLAYLIST_DETAIL
                || browse == EternalSurfaceSettings.Surface.HISTORY
                || browse == EternalSurfaceSettings.Surface.PLAYLISTS) {
            return browse;
        }
        if (nav == NavigationBar.NavigationButton.HOME) return EternalSurfaceSettings.Surface.HOME;

        if (path != null) {
            if (path.contains("search_video")) return EternalSurfaceSettings.Surface.SEARCH;
            if (path.contains("home_video")) return EternalSurfaceSettings.Surface.HOME;
        }
        if (browse != EternalSurfaceSettings.Surface.OTHER) return browse;
        return EternalSurfaceSettings.Surface.OTHER;
    }

    static EternalSurfaceSettings.Surface currentForUi() {
        if (NavigationBar.isSearchBarActive()) return EternalSurfaceSettings.Surface.SEARCH;
        NavigationBar.NavigationButton nav = null;
        try { nav = NavigationBar.NavigationButton.getSelectedNavigationButton(); }
        catch (Throwable ignored) { }

        if (nav == NavigationBar.NavigationButton.SHORTS) return EternalSurfaceSettings.Surface.SHORTS;
        if (PlayerType.getCurrent().isMaximizedOrFullscreen()) return EternalSurfaceSettings.Surface.WATCH;

        EternalSurfaceSettings.Surface browse = fromBrowseId(lastBrowseId);
        if (NavigationBar.isBackButtonVisible() && browse != EternalSurfaceSettings.Surface.OTHER) return browse;
        if (nav == NavigationBar.NavigationButton.SUBSCRIPTIONS) return EternalSurfaceSettings.Surface.SUBSCRIPTIONS;
        if (nav == NavigationBar.NavigationButton.LIBRARY) {
            return browse == EternalSurfaceSettings.Surface.OTHER ? EternalSurfaceSettings.Surface.LIBRARY : browse;
        }
        if (browse == EternalSurfaceSettings.Surface.CHANNEL
                || browse == EternalSurfaceSettings.Surface.WATCH_LATER
                || browse == EternalSurfaceSettings.Surface.LIKED
                || browse == EternalSurfaceSettings.Surface.PLAYLIST_DETAIL
                || browse == EternalSurfaceSettings.Surface.HISTORY
                || browse == EternalSurfaceSettings.Surface.PLAYLISTS) return browse;
        if (nav == NavigationBar.NavigationButton.HOME) return EternalSurfaceSettings.Surface.HOME;
        return browse == EternalSurfaceSettings.Surface.OTHER ? EternalSurfaceSettings.Surface.OTHER : browse;
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
                if (browseId.startsWith("VL") || browseId.startsWith("PL")) {
                    yield EternalSurfaceSettings.Surface.PLAYLIST_DETAIL;
                }
                yield EternalSurfaceSettings.Surface.OTHER;
            }
        };
    }

    private static boolean containsShorts(String path) {
        return path != null && path.toLowerCase().contains("shorts");
    }

    private static boolean looksRelated(String path) {
        return path != null && (path.contains("related_video") || path.contains("compact_video"));
    }

    private EternalSurfaceTracker() { }
}
