package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.youtube.shared.NavigationBar;
import app.morphe.extension.youtube.shared.patches.components.ContextInterface;

/**
 * Stability-mode surface shim.
 *
 * Real-device crashes were reported when switching Shorts/Subscriptions/My/Search/Home after the
 * v1.10 page-scoped presentation work landed. The history ledger, Watch Later transaction engine,
 * updater bridge and watched-card filter do not require host navigation state, so this class keeps
 * the existing injected ABI/callback signatures but deliberately performs no navigation work.
 *
 * Page-specific values remain stored for a future implementation that can prove runtime safety.
 */
@SuppressWarnings("unused")
public final class EternalSurfaceTracker {
    /** Existing bytecode injection target; intentionally no-op in stability mode. */
    public static void onBrowseId(@Nullable String browseId) {
        // No host/navigation state mutation or UI work.
    }

    /** Existing Morphe navigation-listener target; intentionally no-op in stability mode. */
    static void onNavigationChanged(@Nullable NavigationBar.NavigationButton button) {
        // No host/navigation state mutation or UI work.
    }

    /**
     * Compatibility helper retained for old call sites. No host state is queried. A Shorts-looking
     * component is conservatively classified as Shorts; everything else uses the common profile.
     */
    static EternalSurfaceSettings.Surface forComponent(ContextInterface contextInterface, String path) {
        String lower = path == null ? "" : path.toLowerCase();
        if (lower.contains("shorts") || lower.contains("reel")) {
            return EternalSurfaceSettings.Surface.SHORTS;
        }
        return EternalSurfaceSettings.Surface.OTHER;
    }

    /** The floating page-scoped UI is disabled in stability mode. */
    static EternalSurfaceSettings.Surface currentForUi() {
        return EternalSurfaceSettings.Surface.OTHER;
    }

    private EternalSurfaceTracker() { }
}
