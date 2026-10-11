package app.morphe.extension.youtube.patches.eternalhistory;

import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.view.View;

import java.util.Collections;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Carries one watched-thumbnail dim decision across Morphe's Litho filter call to the immediately
 * following component return on the same layout worker thread.
 *
 * No View matching, global FIFO, accessibility text, or server request is involved. The bytecode
 * patch consumes this flag and writes alpha into that exact thumbnail component's Litho NodeInfo.
 */
@SuppressWarnings("unused")
public final class EternalWatchedDim {
    private static final ThreadLocal<Boolean> PREPARED_DIM = new ThreadLocal<>();

    // When grayscale is enabled, add a visually negligible alpha marker. This lets the Litho mount
    // hook distinguish Eternal thumbnails from unrelated YouTube components that also use alpha.
    private static final float GRAYSCALE_ALPHA_MARKER = 0.00037f;
    private static final float ALPHA_MATCH_TOLERANCE = 0.00008f;
    private static final Map<View, Boolean> GRAYSCALE_VIEWS =
            Collections.synchronizedMap(new WeakHashMap<>());

    private EternalWatchedDim() { }

    /** Called once at the beginning of Eternal's classification for every Litho component. */
    static void beginCardDecision() {
        PREPARED_DIM.remove();
    }

    /** Called only after the protobuf videoId + local cache positively identify a watched thumbnail. */
    static void markCard(String videoId, String accessibilityId, String accessibilityText) {
        if (EternalHistorySettings.isDimMode()) {
            PREPARED_DIM.set(Boolean.TRUE);
        }
    }

    /**
     * Injection point immediately before YouTube returns the original unfiltered component.
     * Consuming also clears the thread-local, so a decision can never leak into a later component.
     */
    public static boolean consumePreparedDim() {
        Boolean prepared = PREPARED_DIM.get();
        PREPARED_DIM.remove();
        return Boolean.TRUE.equals(prepared);
    }

    /** Alpha written to watched thumbnail components. No blur is ever applied. */
    public static float getThumbnailAlpha() {
        float alpha = EternalHistorySettings.thumbnailOpacityPercent() / 100.0f;
        if (!EternalHistorySettings.THUMBNAIL_GRAYSCALE.get()) return alpha;

        // Exact alpha 1.0 disables Litho's alpha property bit, so keep grayscale-only mode a tiny
        // distance below 1.0. For all other values the same tiny marker avoids false positives.
        if (alpha >= 1.0f) return 1.0f - GRAYSCALE_ALPHA_MARKER;
        return Math.min(1.0f - GRAYSCALE_ALPHA_MARKER, alpha + GRAYSCALE_ALPHA_MARKER);
    }

    /**
     * Called only after Litho itself executes View.setAlpha(). If this is Eternal's marked watched
     * thumbnail and grayscale is enabled, colorize the composed thumbnail layer to zero saturation.
     * The same hook is also reached when Litho restores alpha to 1.0 during reuse/unmount, which
     * clears our layer so recycled views never inherit grayscale.
     */
    public static void syncThumbnailGrayscale(View view) {
        if (view == null) return;

        boolean grayscaleEnabled = EternalHistorySettings.THUMBNAIL_GRAYSCALE.get();
        float target = getThumbnailAlpha();
        boolean isEternalThumbnail = grayscaleEnabled
                && Math.abs(view.getAlpha() - target) <= ALPHA_MATCH_TOLERANCE;

        if (isEternalThumbnail) {
            if (GRAYSCALE_VIEWS.put(view, Boolean.TRUE) == null) {
                ColorMatrix matrix = new ColorMatrix();
                matrix.setSaturation(0.0f);
                Paint paint = new Paint();
                paint.setColorFilter(new ColorMatrixColorFilter(matrix));
                view.setLayerType(View.LAYER_TYPE_HARDWARE, paint);
            }
            return;
        }

        if (GRAYSCALE_VIEWS.remove(view) != null) {
            view.setLayerType(View.LAYER_TYPE_NONE, null);
        }
    }
}
