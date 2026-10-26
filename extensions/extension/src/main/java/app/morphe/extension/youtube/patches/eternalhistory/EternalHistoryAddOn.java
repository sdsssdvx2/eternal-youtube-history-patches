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
        NavigationBar.addOnNavigationButtonChangedListener(EternalSurfaceTracker::onNavigationChanged);
        EternalHistoryClient.initialize();
        EternalUpdateChecker.schedule();
        EternalWatchLaterJobService.refreshSchedule();
        EternalHistoryToolbar.ensureControlSoon();
    }

    private EternalHistoryAddOn() { }
}
