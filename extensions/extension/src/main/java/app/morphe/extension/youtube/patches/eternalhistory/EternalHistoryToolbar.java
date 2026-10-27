package app.morphe.extension.youtube.patches.eternalhistory;

import android.widget.ImageView;

/**
 * Stability-mode compatibility shim for the former page-scoped floating Eternal control.
 *
 * The v1.10 overlay/surface stack ran during YouTube navigation/view-hierarchy rebuilds and remained
 * the only substantial runtime difference after earlier re-entrant NavigationBar reads were removed.
 * Real-device reports still showed process crashes on Shorts/Subscriptions/My/Search/Home changes,
 * so the stabilization release intentionally removes all overlay mounting, host View traversal,
 * dialog construction and RecyclerView rebinding from navigation time.
 *
 * Existing injected call sites and stored page-profile preferences are preserved so a future
 * implementation can restore page controls without another migration. The common Eternal settings
 * under Morphe Settings > Video > Eternal remain the active presentation controls.
 */
@SuppressWarnings("unused")
public final class EternalHistoryToolbar {
    /** Existing toolbar injection target; intentionally no-op. */
    public static void onToolbarImageView(ImageView imageView) {
        // Stability mode: never attach Eternal UI to the YouTube activity/view hierarchy.
    }

    /** Existing surface callback target; intentionally no-op. */
    static void onSurfaceChanged() {
        // Stability mode: navigation must not cause Eternal host-view work.
    }

    /** Existing add-on startup target; intentionally no-op. */
    static void ensureControlSoon() {
        // Stability mode: page-scoped floating control disabled.
    }

    private EternalHistoryToolbar() { }
}
