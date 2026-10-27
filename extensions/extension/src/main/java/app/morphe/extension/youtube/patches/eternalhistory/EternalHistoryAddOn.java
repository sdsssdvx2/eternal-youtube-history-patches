package app.morphe.extension.youtube.patches.eternalhistory;

import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.youtube.addon.AddOnApi;
import app.morphe.extension.youtube.shared.NavigationBar;

/** Runtime entry point injected into Morphe's AddOnManager. */
@SuppressWarnings("unused")
public final class EternalHistoryAddOn {
    private static final AtomicBoolean registered = new AtomicBoolean();

    /**
     * v1.10.0 introduced a host-navigation listener at the same time real devices began crashing
     * during bottom-tab transitions. Keep the code type-checked for a future controlled re-enable,
     * but do not register it in the crash-quarantine build. Surface preferences remain on disk.
     */
    private static final boolean HOST_NAVIGATION_HOOKS_ENABLED = false;

    public static void register() {
        if (!registered.compareAndSet(false, true)) return;
        Logger.printDebug(() -> "Registering Eternal YouTube History add-on");
        EternalHistorySettings.ENABLED.get();
        EternalSurfaceSettings.ensureDefaultProfileMigrated();

        if (EternalWatchLaterSafety.isLocked()) {
            // Preserve the user's preference value for future migration, but disable every runtime
            // entry point that could delete from Watch Later. refreshSchedule() also cancels any
            // periodic JobScheduler job left behind by an older installed build.
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

        // Do not enter YouTube's navigation callback in the quarantine build. This exact listener
        // did not exist in the last known stable v1.9.1 runtime architecture.
        if (HOST_NAVIGATION_HOOKS_ENABLED) {
            NavigationBar.addOnNavigationButtonChangedListener(EternalSurfaceTracker::onNavigationChanged);
        }

        EternalHistoryClient.initialize();
        EternalUpdateChecker.schedule();
        EternalWatchLaterStateMigration.migrate();
        EternalWatchLaterJobService.refreshSchedule();
    }

    private EternalHistoryAddOn() { }
}
