package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;

/** Opt-in low-frequency device-side Watch Later maintenance. */
@SuppressWarnings("unused")
public final class EternalWatchLaterJobService extends JobService {
    static final int JOB_ID = 0x45594857;
    private static final long PERIOD_MS = 6L * 60L * 60L * 1000L;
    private static final AtomicBoolean running = new AtomicBoolean();
    private static volatile Boolean scheduledEnabled;

    /**
     * Called at add-on startup, after the user toggles auto cleanup, and on video starts so a
     * setting changed through Morphe preferences is noticed. Repeated calls with the same state are
     * no-ops; they must not continually replace the periodic job and push its next window away.
     */
    static synchronized void refreshSchedule() {
        Context context = Utils.getContext();
        if (context == null) return;
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;

        boolean enabled = EternalHistorySettings.ENABLED.get()
                && EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get();
        if (scheduledEnabled != null && scheduledEnabled == enabled) return;

        if (!enabled) {
            scheduler.cancel(JOB_ID);
            scheduledEnabled = Boolean.FALSE;
            return;
        }
        try {
            JobInfo info = new JobInfo.Builder(
                    JOB_ID,
                    new ComponentName(context, EternalWatchLaterJobService.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(PERIOD_MS)
                    .build();
            int result = scheduler.schedule(info);
            if (result == JobScheduler.RESULT_SUCCESS) {
                scheduledEnabled = Boolean.TRUE;
                EternalWatchLaterAutoSweep.runAsync(false, null);
            } else {
                scheduledEnabled = null;
                Logger.printDebug(() -> "Eternal Watch Later JobScheduler rejected the periodic job");
            }
        } catch (Throwable t) {
            scheduledEnabled = null;
            Logger.printDebug(() -> "Eternal Watch Later job scheduling deferred: " + t.getMessage());
        }
    }

    static void runNow() {
        EternalWatchLaterAutoSweep.runAsync(true, null);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        if (!EternalHistorySettings.ENABLED.get()
                || !EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get()) return false;
        if (!running.compareAndSet(false, true)) return false;
        EternalWatchLaterAutoSweep.runAsync(false, () -> {
            running.set(false);
            jobFinished(params, false);
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        running.set(false);
        return true;
    }
}
