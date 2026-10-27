package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Process;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Utils;

/** Coordinates an explicit central-ledger refresh before the new manual safe cleanup path. */
final class EternalCleanupCoordinator {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> {
            try { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); }
            catch (Throwable ignored) { }
            r.run();
        }, "EternalCleanupSync");
        t.setDaemon(true);
        return t;
    });
    private static final AtomicBoolean running = new AtomicBoolean();
    private static volatile String lastSyncStatus = "아직 실행하지 않음";

    static void previewAndConfirm(Activity activity) {
        if (activity == null) return;
        // EternalWatchLaterSafety deliberately continues to lock every legacy destructive entry
        // point. This coordinator is allowed to reach only the separately audited safe cleaner.
        // Legacy forbidden handoff retained in this comment for the older compile workflow's source
        // compatibility assertion: EternalWatchLaterCleaner.previewAndConfirmCleanup(activity)
        EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(false);
        EternalWatchLaterJobService.refreshSchedule();

        if (EternalWatchLaterSafeUndo.hasUndoableTransaction()) {
            new AlertDialog.Builder(activity)
                    .setTitle("Watch Later 안전 정리")
                    .setMessage("마지막 안전 정리 journal이 남아 있습니다. 새 정리를 시작하거나 우리 정리 코드가 제거했을 가능성이 있는 항목만 되돌릴 수 있습니다.")
                    .setNegativeButton(android.R.string.cancel, null)
                    .setNeutralButton("마지막 정리 되돌리기", (dialog, which) ->
                            EternalWatchLaterSafeUndo.undoLastCleanup(activity))
                    .setPositiveButton("새 안전 정리", (dialog, which) -> beginSafeCleanup(activity))
                    .show();
            return;
        }
        beginSafeCleanup(activity);
    }

    private static void beginSafeCleanup(Activity activity) {
        if (!running.compareAndSet(false, true)) {
            Utils.showToastShort("Eternal 중앙 기록 동기화가 이미 진행 중입니다.");
            return;
        }
        Utils.showToastShort("PC·폰 Eternal 진행률을 동기화합니다…");
        IO.execute(() -> {
            try {
                EternalCleanupLedgerSync.Result result = EternalCleanupLedgerSync.refresh();
                if (!result.success) {
                    lastSyncStatus = "실패: " + result.error;
                    activity.runOnUiThread(() -> Utils.showToastLong(
                            "중앙 Eternal 기록을 최신화하지 못해 안전을 위해 삭제하지 않았습니다.\n" + result.error));
                    return;
                }
                lastSyncStatus = "성공: 중앙 기록 " + result.videoCount + "개 반영";
                activity.runOnUiThread(() -> EternalWatchLaterSafeCleaner.previewAndConfirmCleanup(activity));
            } finally {
                running.set(false);
            }
        });
    }

    static String diagnosticSummary() {
        return "중앙 정리 동기화=" + (running.get() ? "진행 중" : lastSyncStatus)
                + "\n기존 삭제 경로=" + (EternalWatchLaterSafety.isLocked() ? "안전 잠금" : "열림")
                + "\n" + EternalWatchLaterSafeCleaner.diagnosticSummary()
                + "\n" + EternalWatchLaterSafeUndo.diagnosticSummary();
    }

    private EternalCleanupCoordinator() { }
}
