package app.morphe.extension.youtube.patches.eternalhistory;

import static java.lang.Boolean.FALSE;
import static java.lang.Boolean.TRUE;
import static app.morphe.extension.shared.settings.Setting.parent;

import app.morphe.extension.shared.settings.BooleanSetting;
import app.morphe.extension.shared.settings.IntegerSetting;
import app.morphe.extension.shared.settings.StringSetting;

/** Settings owned by the Eternal YouTube History add-on. */
public final class EternalHistorySettings {
    public static final BooleanSetting ENABLED =
            new BooleanSetting("morphe_eternal_history_enabled", TRUE);
    public static final StringSetting WORKER_URL =
            new StringSetting("morphe_eternal_history_worker_url", "", false, parent(ENABLED));
    public static final StringSetting API_TOKEN =
            new StringSetting("morphe_eternal_history_api_token", "", false, parent(ENABLED));
    public static final IntegerSetting MIN_SECONDS =
            new IntegerSetting("morphe_eternal_history_min_seconds", 5, false, parent(ENABLED));
    public static final IntegerSetting PROGRESS_STEP =
            new IntegerSetting("morphe_eternal_history_progress_step", 5, false, parent(ENABLED));
    public static final BooleanSetting SYNC_CACHE =
            new BooleanSetting("morphe_eternal_history_sync_cache", TRUE, false, parent(ENABLED));
    public static final BooleanSetting AUTO_UPDATE_CHECK =
            new BooleanSetting("morphe_eternal_history_auto_update_check", TRUE, false, parent(ENABLED));

    /** Legacy values retained for migration and the stability renderer fallback. */
    public static final StringSetting FEED_MODE =
            new StringSetting("morphe_eternal_history_feed_mode", "", false, parent(ENABLED));
    public static final BooleanSetting HIDE_WATCHED =
            new BooleanSetting("morphe_eternal_history_hide_watched", FALSE, false, parent(ENABLED));
    public static final IntegerSetting HIDE_MIN_PROGRESS =
            new IntegerSetting("morphe_eternal_history_hide_min_progress", 0, false, parent(ENABLED));

    /** Rich common/default profile. Saved page-specific profiles are preserved but inactive in v1.10.5. */
    public static final BooleanSetting DEFAULT_DIM_ENABLED =
            new BooleanSetting("morphe_eternal_history_default_dim_enabled", FALSE, false, parent(ENABLED));
    public static final BooleanSetting DEFAULT_HIDE_ENABLED =
            new BooleanSetting("morphe_eternal_history_default_hide_enabled", FALSE, false, parent(ENABLED));
    public static final BooleanSetting DEFAULT_LINKED_THRESHOLDS =
            new BooleanSetting("morphe_eternal_history_default_linked_thresholds", TRUE, false, parent(ENABLED));
    public static final IntegerSetting DEFAULT_SHARED_THRESHOLD =
            new IntegerSetting("morphe_eternal_history_default_shared_threshold", 0, false, parent(ENABLED));
    public static final IntegerSetting DEFAULT_DIM_THRESHOLD =
            new IntegerSetting("morphe_eternal_history_default_dim_threshold", 0, false, parent(ENABLED));
    public static final IntegerSetting DEFAULT_HIDE_THRESHOLD =
            new IntegerSetting("morphe_eternal_history_default_hide_threshold", 0, false, parent(ENABLED));

    public static final IntegerSetting THUMBNAIL_OPACITY =
            new IntegerSetting("morphe_eternal_history_thumbnail_opacity", 65, false, parent(ENABLED));
    public static final BooleanSetting THUMBNAIL_GRAYSCALE =
            new BooleanSetting("morphe_eternal_history_thumbnail_grayscale", FALSE, false, parent(ENABLED));
    public static final BooleanSetting DIM_CARD_INFO =
            new BooleanSetting("morphe_eternal_history_dim_card_info", FALSE, false, parent(ENABLED));

    /** Destructive Watch Later automation remains opt-in and is runtime-locked by safety code. */
    public static final BooleanSetting WATCH_LATER_AUTO_CLEANUP =
            new BooleanSetting("morphe_eternal_history_watch_later_auto_cleanup", FALSE, false, parent(ENABLED));
    public static final IntegerSetting WATCH_LATER_CLEANUP_MIN_PROGRESS =
            new IntegerSetting("morphe_eternal_history_watch_later_cleanup_min_progress", 60, false, parent(ENABLED));

    /**
     * v1.10.5 uses one proven global presentation mode again. Keep the richer common profile as the
     * source of truth so no user settings are lost; hide takes precedence when both rules are on.
     */
    public static String feedMode() {
        if (DEFAULT_HIDE_ENABLED.get()) return "hide";
        if (DEFAULT_DIM_ENABLED.get()) return "dim";
        String mode = FEED_MODE.get();
        if (mode == null || mode.isEmpty()) return HIDE_WATCHED.get() ? "hide" : "none";
        if ("dim".equals(mode) || "hide".equals(mode)) return mode;
        return "none";
    }

    /** Threshold corresponding to the single stability presentation mode. */
    public static int feedMinProgressPercent() {
        if (DEFAULT_HIDE_ENABLED.get()) {
            return DEFAULT_LINKED_THRESHOLDS.get()
                    ? defaultSharedThresholdPercent()
                    : defaultHideThresholdPercent();
        }
        if (DEFAULT_DIM_ENABLED.get()) {
            return DEFAULT_LINKED_THRESHOLDS.get()
                    ? defaultSharedThresholdPercent()
                    : defaultDimThresholdPercent();
        }
        return clamp(HIDE_MIN_PROGRESS.get(), 0, 100);
    }

    public static int thumbnailOpacityPercent() {
        return clamp(THUMBNAIL_OPACITY.get(), 10, 100);
    }

    public static int watchLaterCleanupProgressPercent() {
        return clamp(WATCH_LATER_CLEANUP_MIN_PROGRESS.get(), 1, 100);
    }

    public static int defaultSharedThresholdPercent() {
        return clamp(DEFAULT_SHARED_THRESHOLD.get(), 0, 100);
    }

    public static int defaultDimThresholdPercent() {
        return clamp(DEFAULT_DIM_THRESHOLD.get(), 0, 100);
    }

    public static int defaultHideThresholdPercent() {
        return clamp(DEFAULT_HIDE_THRESHOLD.get(), 0, 100);
    }

    public static boolean isFeedVisualEnabled() { return isDimMode() || isHideMode(); }
    public static boolean isDimMode() { return "dim".equals(feedMode()); }
    public static boolean isHideMode() { return "hide".equals(feedMode()); }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private EternalHistorySettings() { }
}
