package app.morphe.extension.youtube.patches.eternalhistory;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;

/** Device-local watched-card rules for each YouTube surface. */
final class EternalSurfaceSettings {
    private static final String PREFS = "eternal_history_surface_profiles_v1";
    private static final String DEFAULT_V2_MIGRATED = "default_profile_v2_migrated";

    // Feed/Litho filters can ask for the common profile many times per rendered frame. The settings
    // themselves change only through explicit user interaction, so keep a very short-lived immutable
    // snapshot instead of re-reading six settings and allocating a Profile for every component.
    // 250 ms keeps UI changes effectively immediate while collapsing the hot path to two volatile
    // reads plus SystemClock.uptimeMillis().
    private static final long DEFAULT_PROFILE_CACHE_TTL_MS = 250L;
    private static volatile Profile cachedDefaultProfile;
    private static volatile long cachedDefaultProfileAtMs;
    private static volatile boolean defaultMigrationVerified;

    enum Surface {
        HOME("home", "홈"),
        SHORTS("shorts", "Shorts"),
        WATCH("watch", "영상 상세 · 관련 영상"),
        SUBSCRIPTIONS("subscriptions", "구독"),
        CHANNEL("channel", "채널"),
        SEARCH("search", "검색 결과"),
        WATCH_LATER("watch_later", "나중에 볼 동영상"),
        LIKED("liked", "좋아요 표시한 동영상"),
        PLAYLISTS("playlists", "재생목록"),
        PLAYLIST_DETAIL("playlist_detail", "재생목록 상세"),
        HISTORY("history", "시청 기록"),
        LIBRARY("library", "내 페이지 · 라이브러리"),
        OTHER("other", "기타"),
        ;

        final String key;
        final String label;

        Surface(String key, String label) {
            this.key = key;
            this.label = label;
        }
    }

    static final class Profile {
        final boolean dimEnabled;
        final boolean hideEnabled;
        final boolean linkedThresholds;
        final int sharedThreshold;
        final int dimThreshold;
        final int hideThreshold;
        final boolean explicit;

        Profile(boolean dimEnabled, boolean hideEnabled, boolean linkedThresholds,
                int sharedThreshold, int dimThreshold, int hideThreshold, boolean explicit) {
            this.dimEnabled = dimEnabled;
            this.hideEnabled = hideEnabled;
            this.linkedThresholds = linkedThresholds;
            this.sharedThreshold = clamp(sharedThreshold);
            this.dimThreshold = clamp(dimThreshold);
            this.hideThreshold = clamp(hideThreshold);
            this.explicit = explicit;
        }

        int effectiveDimThreshold() {
            return linkedThresholds ? sharedThreshold : dimThreshold;
        }

        int effectiveHideThreshold() {
            return linkedThresholds ? sharedThreshold : hideThreshold;
        }

        boolean visualEnabled() {
            return dimEnabled || hideEnabled;
        }
    }

    /** Called during add-on startup before the settings screen can be edited. */
    static void ensureDefaultProfileMigrated() {
        if (defaultMigrationVerified) return;
        synchronized (EternalSurfaceSettings.class) {
            if (defaultMigrationVerified) return;
            SharedPreferences p = prefs();
            if (p == null) return;
            if (p.getBoolean(DEFAULT_V2_MIGRATED, false)) {
                defaultMigrationVerified = true;
                return;
            }
            try {
                String legacyMode = EternalHistorySettings.feedMode();
                int threshold = clamp(EternalHistorySettings.HIDE_MIN_PROGRESS.get());
                EternalHistorySettings.DEFAULT_DIM_ENABLED.save("dim".equals(legacyMode));
                EternalHistorySettings.DEFAULT_HIDE_ENABLED.save("hide".equals(legacyMode));
                EternalHistorySettings.DEFAULT_LINKED_THRESHOLDS.save(true);
                EternalHistorySettings.DEFAULT_SHARED_THRESHOLD.save(threshold);
                EternalHistorySettings.DEFAULT_DIM_THRESHOLD.save(threshold);
                EternalHistorySettings.DEFAULT_HIDE_THRESHOLD.save(threshold);
                if (p.edit().putBoolean(DEFAULT_V2_MIGRATED, true).commit()) {
                    defaultMigrationVerified = true;
                    invalidateDefaultProfileCache();
                }
            } catch (Throwable t) {
                Logger.printException(() -> "Eternal default profile migration failed", t);
            }
        }
    }

    static Profile defaultProfile(boolean explicit) {
        ensureDefaultProfileMigrated();
        if (explicit) return readDefaultProfile(true);

        long now = SystemClock.uptimeMillis();
        Profile cached = cachedDefaultProfile;
        long age = now - cachedDefaultProfileAtMs;
        if (cached != null && age >= 0 && age < DEFAULT_PROFILE_CACHE_TTL_MS) return cached;

        Profile fresh = readDefaultProfile(false);
        cachedDefaultProfile = fresh;
        cachedDefaultProfileAtMs = now;
        return fresh;
    }

    private static Profile readDefaultProfile(boolean explicit) {
        return new Profile(
                EternalHistorySettings.DEFAULT_DIM_ENABLED.get(),
                EternalHistorySettings.DEFAULT_HIDE_ENABLED.get(),
                EternalHistorySettings.DEFAULT_LINKED_THRESHOLDS.get(),
                EternalHistorySettings.defaultSharedThresholdPercent(),
                EternalHistorySettings.defaultDimThresholdPercent(),
                EternalHistorySettings.defaultHideThresholdPercent(),
                explicit
        );
    }

    /** Explicit hook for call sites that need an immediate refresh after changing common settings. */
    static void invalidateDefaultProfileCache() {
        cachedDefaultProfile = null;
        cachedDefaultProfileAtMs = 0L;
    }

    static Profile get(Surface surface) {
        if (surface == null) surface = Surface.OTHER;
        ensureDefaultProfileMigrated();
        SharedPreferences p = prefs();
        if (p == null || !p.getBoolean(prefix(surface) + "set", false)) {
            return defaultProfile(false);
        }
        String k = prefix(surface);
        Profile fallback = defaultProfile(false);
        return new Profile(
                p.getBoolean(k + "dim", fallback.dimEnabled),
                p.getBoolean(k + "hide", fallback.hideEnabled),
                p.getBoolean(k + "linked", fallback.linkedThresholds),
                p.getInt(k + "shared", fallback.sharedThreshold),
                p.getInt(k + "dim_threshold", fallback.dimThreshold),
                p.getInt(k + "hide_threshold", fallback.hideThreshold),
                true
        );
    }

    static void save(Surface surface, boolean dimEnabled, boolean hideEnabled,
                     boolean linkedThresholds, int sharedThreshold,
                     int dimThreshold, int hideThreshold) {
        if (surface == null) surface = Surface.OTHER;
        SharedPreferences p = prefs();
        if (p == null) return;
        String k = prefix(surface);
        p.edit()
                .putBoolean(k + "set", true)
                .putBoolean(k + "dim", dimEnabled)
                .putBoolean(k + "hide", hideEnabled)
                .putBoolean(k + "linked", linkedThresholds)
                .putInt(k + "shared", clamp(sharedThreshold))
                .putInt(k + "dim_threshold", clamp(dimThreshold))
                .putInt(k + "hide_threshold", clamp(hideThreshold))
                .apply();
    }

    static void reset(Surface surface) {
        if (surface == null) surface = Surface.OTHER;
        SharedPreferences p = prefs();
        if (p == null) return;
        String k = prefix(surface);
        p.edit()
                .remove(k + "set")
                .remove(k + "dim")
                .remove(k + "hide")
                .remove(k + "linked")
                .remove(k + "shared")
                .remove(k + "dim_threshold")
                .remove(k + "hide_threshold")
                .apply();
    }

    static boolean hasExplicitProfile(Surface surface) {
        if (surface == null) surface = Surface.OTHER;
        SharedPreferences p = prefs();
        return p != null && p.getBoolean(prefix(surface) + "set", false);
    }

    /** Compatibility helper for code/tests that still refer to the pre-v1.11 global default. */
    static Profile legacyDefault(boolean explicit) {
        ensureDefaultProfileMigrated();
        return defaultProfile(explicit);
    }

    static boolean anyVisualEnabled() {
        if (defaultProfile(false).visualEnabled()) return true;
        SharedPreferences p = prefs();
        if (p == null) return false;
        for (Surface surface : Surface.values()) {
            String k = prefix(surface);
            if (p.getBoolean(k + "set", false)
                    && (p.getBoolean(k + "dim", false) || p.getBoolean(k + "hide", false))) {
                return true;
            }
        }
        return false;
    }

    private static SharedPreferences prefs() {
        Context context = Utils.getContext();
        return context == null ? null : context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String prefix(Surface surface) {
        return "surface_" + surface.key + "_";
    }

    private static int clamp(int value) {
        return Math.max(0, Math.min(100, value));
    }

    private EternalSurfaceSettings() { }
}
