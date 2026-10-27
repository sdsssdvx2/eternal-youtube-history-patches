package app.morphe.extension.youtube.patches.eternalhistory;

import androidx.annotation.Nullable;

import app.morphe.extension.shared.patches.components.ContextInterface;
import app.morphe.extension.youtube.shared.NavigationBar;

/**
 * Compatibility shim for v1.10.x patch points.
 *
 * Real-device crashes began after Eternal started participating in YouTube navigation/surface
 * lifecycle. v1.10.5 intentionally returns to the v1.9.x runtime model: no host navigation reads,
 * no navigation callbacks, no surface publication, and no UI remount requests. The class remains
 * so already-compiled patch hooks stay binary-compatible, while saved surface profiles are kept in
 * preferences for a future implementation that does not touch YouTube's transition lifecycle.
 */
@SuppressWarnings("unused")
public final class EternalSurfaceTracker {
    /** Bytecode hook retained for compatibility only; deliberately side-effect free. */
    public static void onBrowseId(@Nullable String browseId) {
        // no-op
    }

    /** AddOn listener is no longer registered; keep the method for binary/source compatibility. */
    static void onNavigationChanged(@Nullable NavigationBar.NavigationButton button) {
        // no-op
    }

    /** The stability filter no longer uses surface classification. */
    static EternalSurfaceSettings.Surface forComponent(ContextInterface contextInterface, String path) {
        return EternalSurfaceSettings.Surface.OTHER;
    }

    /**
     * Suppress the v1.10.x floating overlay without editing YouTube's toolbar hook in this recovery
     * release. EternalHistoryToolbar treats SHORTS as a no-control surface and therefore removes or
     * skips its overlay. Global display settings remain available in Morphe Settings > Video > Eternal.
     */
    static EternalSurfaceSettings.Surface currentForUi() {
        return EternalSurfaceSettings.Surface.SHORTS;
    }

    private EternalSurfaceTracker() { }
}
