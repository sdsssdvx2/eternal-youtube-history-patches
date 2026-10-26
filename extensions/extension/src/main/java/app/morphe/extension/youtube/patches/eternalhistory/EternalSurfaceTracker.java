package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.patches.components.ContextInterface;
import app.morphe.extension.youtube.shared.NavigationBar;
import app.morphe.extension.youtube.shared.PlayerType;

/** Tracks enough YouTube navigation state to choose a device-local page profile. */
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
            if (mapped != EternalSurfaceSettings.Surface.OTHER) lastUiSurface = mapped;
            EternalHistoryToolbar.onSurfaceChanged();
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal browse surface update ignored: " + safeMessage(t));
        }
    }

    static void onNavigationChanged(@Nullable NavigationBar.NavigationButton button) {
        try {
            if (button == NavigationBar.NavigationButton.HOME) {
                lastBrowseId = "FEwhat_to_watch";
                lastUiSurface = EternalSurfaceSettings.Surface.HOME;
            } else if (button == NavigationBar.NavigationButton.SUBSCRIPTIONS) {
                lastBrowseId = "FEsubscriptions";
                lastUiSurface = EternalSurfaceSettings.Surface.SUBSCRIPTIONS;
            } else if (button == NavigationBar.NavigationButton.LIBRARY) {
                lastBrowseId = "FElibrary";
                lastUiSurface = EternalSurfaceSettings.Surface.LIBRARY;
            } else if (button == NavigationBar.NavigationButton.SHORTS) {
                lastBrowseId = "";
                lastUiSurface = EternalSurfaceSettings.Surface.SHORTS;
            }
            EternalHistoryToolbar.onSurfaceChanged();
        } catch (Throwable t) {
            // Navigation listeners run in YouTube's own tab transition path. Eternal must never be
            // able to turn a transient host state into an app crash.
            Logger.printDebug(() -> "Eternal navigation surface update ignored: " + safeMessage(t));
        }
    }

    static EternalSurfaceSettings.Surface forComponent(ContextInterface contextInterface, String path) {
        try {
            if (safeSearchActive()) return EternalSurfaceSettings.Surface.SEARCH;

            NavigationBar.NavigationButton nav = safeSelectedNavigationButton(contextInterface);
            if (nav == NavigationBar.NavigationButton.SHORTS || containsShorts(path)) {
                return EternalSurfaceSettings.Surface.SHORTS;
            }
            if (safePlayerMaximized() || looksRelated(path)) {
                return EternalSurfaceSettings.Surface.WATCH;
            }

            EternalSurfaceSettings.Surface browse = fromBrowseId(lastBrowseId);
            if (safeBackButtonVisible() && browse != EternalSurfaceSettings.Surface.OTHER) return browse;
            if (nav == NavigationBar.NavigationButton.SUBSCRIPTIONS) return EternalSurfaceSettings.Surface.SUBSCRIPTIONS;
            if (nav == NavigationBar.NavigationButton.LIBRARY) {
                return browse == EternalSurfaceSettings.Surface.OTHER ? EternalSurfaceSettings.Surface.LIBRARY : browse;
            }
            if (isDetailBrowseSurface(browse)) return browse;
            if (nav == NavigationBar.NavigationButton.HOME) return EternalSurfaceSettings.Surface.HOME;

            if (path != null) {
                if (path.contains("search_video")) return EternalSurfaceSettings.Surface.SEARCH;
                if (path.contains("home_video")) return EternalSurfaceSettings.Surface.HOME;
            }
            return browse != EternalSurfaceSettings.Surface.OTHER ? browse : lastUiSurface;
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal component surface classification ignored: " + safeMessage(t));
            return lastUiSurface == null ? EternalSurfaceSettings.Surface.OTHER : lastUiSurface;
        }
    }

    /**
     * Main-thread UI classification. Every host lookup is fail-open because YouTube temporarily
     * tears down search/player/navigation objects while switching Shorts, Subscriptions, Home and
     * the You tab. A display helper must never crash the host app during those transitions.
     */
    static EternalSurfaceSettings.Surface currentForUi() {
        try {
            EternalSurfaceSettings.Surface resolved;
            if (safeSearchActive()) resolved = EternalSurfaceSettings.Surface.SEARCH;
            else {
                NavigationBar.NavigationButton nav = safeSelectedNavigationButton();
                if (nav == NavigationBar.NavigationButton.SHORTS) resolved = EternalSurfaceSettings.Surface.SHORTS;
                else if (safePlayerMaximized()) resolved = EternalSurfaceSettings.Surface.WATCH;
                else {
                    EternalSurfaceSettings.Surface browse = fromBrowseId(lastBrowseId);
                    if (safeBackButtonVisible() && browse != EternalSurfaceSettings.Surface.OTHER) resolved = browse;
                    else if (nav == NavigationBar.NavigationButton.SUBSCRIPTIONS) resolved = EternalSurfaceSettings.Surface.SUBSCRIPTIONS;
                    else if (nav == NavigationBar.NavigationButton.LIBRARY) {
                        resolved = browse == EternalSurfaceSettings.Surface.OTHER ? EternalSurfaceSettings.Surface.LIBRARY : browse;
                    } else if (isDetailBrowseSurface(browse)) resolved = browse;
                    else if (nav == NavigationBar.NavigationButton.HOME) resolved = EternalSurfaceSettings.Surface.HOME;
                    else resolved = browse == EternalSurfaceSettings.Surface.OTHER ? lastUiSurface : browse;
                }
            }
            if (resolved == null) resolved = EternalSurfaceSettings.Surface.OTHER;
            lastUiSurface = resolved;
            return resolved;
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal UI surface classification ignored: " + safeMessage(t));
            return lastUiSurface == null ? EternalSurfaceSettings.Surface.OTHER : lastUiSurface;
        }
    }

    private static boolean safeSearchActive() {
        try { return NavigationBar.isSearchBarActive(); }
        catch (Throwable ignored) { return false; }
    }

    private static boolean safeBackButtonVisible() {
        try { return NavigationBar.isBackButtonVisible(); }
        catch (Throwable ignored) { return false; }
    }

    private static boolean safePlayerMaximized() {
        try {
            PlayerType type = PlayerType.getCurrent();
            return type != null && type.isMaximizedOrFullscreen();
        } catch (Throwable ignored) { return false; }
    }

    @Nullable
    private static NavigationBar.NavigationButton safeSelectedNavigationButton() {
        try { return NavigationBar.NavigationButton.getSelectedNavigationButton(); }
        catch (Throwable ignored) { return null; }
    }

    @Nullable
    private static NavigationBar.NavigationButton safeSelectedNavigationButton(ContextInterface contextInterface) {
        if (contextInterface == null) return null;
        try { return NavigationBar.NavigationButton.getSelectedNavigationButton(contextInterface); }
        catch (Throwable ignored) { return null; }
    }

    private static boolean isDetailBrowseSurface(EternalSurfaceSettings.Surface browse) {
        return browse == EternalSurfaceSettings.Surface.CHANNEL
                || browse == EternalSurfaceSettings.Surface.WATCH_LATER
                || browse == EternalSurfaceSettings.Surface.LIKED
                || browse == EternalSurfaceSettings.Surface.PLAYLIST_DETAIL
                || browse == EternalSurfaceSettings.Surface.HISTORY
                || browse == EternalSurfaceSettings.Surface.PLAYLISTS;
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

    private static boolean containsShorts(String path) {
        return path != null && path.toLowerCase().contains("shorts");
    }

    private static boolean looksRelated(String path) {
        return path != null && (path.contains("related_video") || path.contains("compact_video"));
    }

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return message == null ? (t == null ? "unknown" : t.getClass().getSimpleName()) : message;
    }

    private EternalSurfaceTracker() { }
}
