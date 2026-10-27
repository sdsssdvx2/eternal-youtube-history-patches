package app.morphe.extension.youtube.patches.eternalhistory;

import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.youtube.addon.AddOnApi;

/** Runtime entry point injected into Morphe's AddOnManager. */
@SuppressWarnings("unused")
public final class EternalHistoryAddOn {
    private static final AtomicBoolean registered = new AtomicBoolean();

    public static void register() {
        if (!registered.compareAndSet(false, true)) return;
        Logger.printDebug(() -> "Registering Eternal YouTube History add-on");
        EternalHistorySettings.ENABLED.get();

        // Preserve the v1.10.x common/default profile migration, but page-specific navigation
        // tracking is intentionally dormant in v1.10.5. The last proven-stable v1.9.1 runtime did
        // not subscribe to YouTube's bottom-navigation lifecycle at all.
        EternalSurfaceSettings.ensureDefaultProfileMigrated();

        if (EternalWatchLaterSafety.isLocked()) {
            // Preserve stored settings for future migration while disabling every runtime path that
            // could delete from Watch Later. refreshSchedule() also cancels an older scheduled job.
            EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(false);
        }

        AddOnApi.addNewVideoStartedListener(() -> {
            EternalHistoryClient.onNewVideoStarted();
            if (!EternalWatchLaterSafety.isLocked()) {
                EternalWatchLaterCleaner.onNewVideoStarted();
            }
            EternalWatchLaterJobService.refreshSchedule();
        });
        AddOnApi.addVideoIdListener(videoId -> {
            EternalHistoryClient.onVideoIdChanged(videoId);
            if (!EternalWatchLaterSafety.isLocked()) {
                EternalWatchLaterCleaner.onVideoIdChanged(videoId);
            }
        });
        AddOnApi.addVideoTimeListener(videoTimeMs -> {
            EternalHistoryClient.onVideoTimeChanged(videoTimeMs);
            if (!EternalWatchLaterSafety.isLocked()) {
                EternalWatchLaterCleaner.onVideoTimeChanged(videoTimeMs);
            }
        });

        // IMPORTANT: no NavigationBar listener here. v1.10.0 introduced a listener that runs in the
        // exact bottom-tab transition where real devices began crashing (Shorts, Subscriptions, You).
        // v1.10.1-v1.10.4 made that callback more defensive, but the real-device crash persisted.
        // Restore the v1.9.1 ownership boundary: Eternal observes video lifecycle only; its toolbar
        // mounts opportunistically from the proven native-toolbar ImageView hook.
        EternalHistoryClient.initialize();
        EternalUpdateChecker.schedule();
        EternalWatchLaterStateMigration.migrate();
        EternalWatchLaterJobService.refreshSchedule();
    }

    private EternalHistoryAddOn() { }
}
