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

    /** Stable first mobile visual mode: remove watched feed cards using the local D1 cache. */
    public static final BooleanSetting HIDE_WATCHED =
            new BooleanSetting("morphe_eternal_history_hide_watched", FALSE, false, parent(ENABLED));
    public static final IntegerSetting HIDE_MIN_PROGRESS =
            new IntegerSetting("morphe_eternal_history_hide_min_progress", 0, false, parent(HIDE_WATCHED));

    private EternalHistorySettings() { }
}
