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
     * but do not register it. Surface preferences remain on disk.
     */
    private static final boolean HOST_NAVIGATION_HOOKS_ENABLED = false;

    public static void register() {
        if (!registered.compareAndSet(false, true)) return;
        Logger.printDebug(() -> "Registering Eternal YouTube History add-on");
        EternalHistorySettings.ENABLED.get();
        EternalSurfaceSettings.ensureDefaultProfileMigrated();

        AddOnApi.addNewVideoStartedListener(() -> {
            EternalHistoryClient.onNewVideoStarted();
            // The historical per-video direct-delete implementation stays permanently locked.
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

        // Keep the real-device crash quarantine: never re-enter YouTube navigation state from the
        // bottom-tab callback. The toolbar render signal is restored separately at the bytecode
        // layer and does not enable this listener or the browse-id hook.
        if (HOST_NAVIGATION_HOOKS_ENABLED) {
            NavigationBar.addOnNavigationButtonChangedListener(EternalSurfaceTracker::onNavigationChanged);
        }

        EternalHistoryClient.initialize();
        EternalUpdateChecker.schedule();
        EternalWatchLaterStateMigration.migrate();
        // Safe automatic cleanup owns its own transaction boundary; do not overwrite the user's
        // preference merely because the unrelated legacy direct-delete path remains locked.
        EternalWatchLaterJobService.refreshSchedule();
    }

    private EternalHistoryAddOn() { }
}
