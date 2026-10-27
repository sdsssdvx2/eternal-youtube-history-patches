package app.morphe.extension.youtube.patches.eternalhistory;

import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.youtube.addon.AddOnApi;
import app.morphe.extension.youtube.shared.NavigationBar;

/** Runtime entry point injected into Morphe's AddOnManager. */
@SuppressWarnings("unused")
public final class EternalHistoryAddOn {
    private static final AtomicBoolean registered = new AtomicBoolean();

    public static void register() {
        if (!registered.compareAndSet(false, true)) return;
        Logger.printDebug(() -> "Registering Eternal YouTube History add-on");
        EternalHistorySettings.ENABLED.get();
        EternalSurfaceSettings.ensureDefaultProfileMigrated();
        AddOnApi.addNewVideoStartedListener(() -> {
            EternalHistoryClient.onNewVideoStarted();
            EternalWatchLaterCleaner.onNewVideoStarted();
            EternalWatchLaterJobService.refreshSchedule();
            EternalHistoryToolbar.onSurfaceChanged();
        });
        AddOnApi.addVideoIdListener(videoId -> {
            EternalHistoryClient.onVideoIdChanged(videoId);
            EternalWatchLaterCleaner.onVideoIdChanged(videoId);
        });
        AddOnApi.addVideoTimeListener(videoTimeMs -> {
            EternalHistoryClient.onVideoTimeChanged(videoTimeMs);
            EternalWatchLaterCleaner.onVideoTimeChanged(videoTimeMs);
        });
        // Morphe already gives the newly selected navigation button to this listener. Eternal only
        // records that value. It must not query NavigationBar/PlayerType back from inside YouTube's
        // tab-transition callback, because those host objects are temporarily being rebuilt there.
        NavigationBar.addOnNavigationButtonChangedListener(EternalSurfaceTracker::onNavigationChanged);
        EternalHistoryClient.initialize();
        EternalUpdateChecker.schedule();
        EternalWatchLaterStateMigration.migrate();
        EternalWatchLaterJobService.refreshSchedule();
        EternalHistoryToolbar.ensureControlSoon();
    }

    private EternalHistoryAddOn() { }
}
