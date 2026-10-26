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

    static void refreshSchedule() {
        Context context = Utils.getContext();
        if (context == null) return;
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        if (!EternalHistorySettings.ENABLED.get()
                || !EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get()) {
            scheduler.cancel(JOB_ID);
            return;
        }
        try {
            JobInfo info = new JobInfo.Builder(
                    JOB_ID,
                    new ComponentName(context, EternalWatchLaterJobService.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(PERIOD_MS)
                    .build();
            scheduler.schedule(info);
            EternalWatchLaterAutoSweep.runAsync(false, null);
        } catch (Throwable t) {
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
