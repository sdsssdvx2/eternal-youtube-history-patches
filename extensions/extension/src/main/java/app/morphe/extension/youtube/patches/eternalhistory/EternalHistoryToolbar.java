package app.morphe.extension.youtube.patches.eternalhistory;

import android.widget.ImageView;

/**
 * Stability baseline for the Eternal on-page control.
 *
 * The previous overlay was mounted from YouTube toolbar/navigation lifecycle callbacks and could be
 * scheduled while the host was rebuilding a tab. Real-device testing showed repeated crashes on
 * Shorts/Subscriptions/Library transitions. Keep the bytecode hook ABI intact so existing patch
 * integration remains stable, but make every overlay entry point intentionally inert.
 *
 * Global Eternal settings remain available through Morphe Settings > Video > Eternal, and watched
 * card filtering/history continue independently of this class.
 */
@SuppressWarnings("unused")
public final class EternalHistoryToolbar {
    /** Bytecode injection target. Deliberately does not touch the host ImageView or Activity tree. */
    public static void onToolbarImageView(ImageView imageView) {
        // no-op by design
    }

    /** Retained for binary/source compatibility with older extension code. */
    static void onSurfaceChanged() {
        // no-op by design
    }

    /** Retained for binary/source compatibility with older extension code. */
    static void ensureControlSoon() {
        // no-op by design
    }

    private EternalHistoryToolbar() { }
}
