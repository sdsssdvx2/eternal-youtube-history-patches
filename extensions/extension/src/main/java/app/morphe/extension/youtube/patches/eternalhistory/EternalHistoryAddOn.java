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
        Logger.printDebug(() -> "Registering Eternal YouTube History add-on (stability runtime)");
        EternalHistorySettings.ENABLED.get();
        EternalSurfaceSettings.ensureDefaultProfileMigrated();

        if (EternalWatchLaterSafety.isLocked()) {
            // Keep destructive automation disabled while preserving the stored transaction/recovery
            // state. No uninstall/reset or preference clearing is required for this stability build.
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

        // Deliberately do not register a NavigationBar listener here. v1.9.x did not participate in
        // YouTube tab lifecycle at all, and real-device crashes started after the surface/navigation
        // runtime was introduced. The saved page-profile data is retained for a future safer UI.
        EternalHistoryClient.initialize();
        EternalUpdateChecker.schedule();
        EternalWatchLaterStateMigration.migrate();
        EternalWatchLaterJobService.refreshSchedule();
    }

    private EternalHistoryAddOn() { }
}
