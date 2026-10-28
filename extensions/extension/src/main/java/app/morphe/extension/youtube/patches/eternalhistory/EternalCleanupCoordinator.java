package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Process;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Utils;

/** Coordinates fresh central-ledger sync before the isolated manual safe-cleanup path. */
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
        if (!EternalWatchLaterSafety.safeCleanupAvailable()) {
            Utils.showToastLong("Watch Later 안전 정리를 사용할 수 없습니다.");
            return;
        }

        // The legacy direct-delete path remains locked independently. Manual cleanup always enters
        // the snapshot+journal+fresh-identity safe cleaner below and never changes the user's safe
        // automatic-cleanup preference.
        if (EternalWatchLaterSafeUndo.hasUndoableTransaction()) {
            new AlertDialog.Builder(activity)
                    .setTitle("Watch Later 안전 정리")
                    .setMessage("마지막 안전 정리에서 삭제됐거나 결과가 불확실한 항목의 복구 기록이 남아 있습니다. "
                            + "먼저 되돌릴 수 있고, 완료된 정리를 그대로 둘 경우 새 안전 정리를 시작할 수도 있습니다.")
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
            } catch (Throwable t) {
                lastSyncStatus = "실패: " + safeMessage(t);
                activity.runOnUiThread(() -> Utils.showToastLong(
                        "안전 정리 준비 중 오류가 발생해 삭제하지 않았습니다.\n" + safeMessage(t)));
            } finally {
                running.set(false);
            }
        });
    }

    static String diagnosticSummary() {
        return "중앙 정리 동기화=" + (running.get() ? "진행 중" : lastSyncStatus)
                + "\n기존 직접 삭제 경로=" + (EternalWatchLaterSafety.isLocked() ? "잠김" : "열림")
                + "\n안전 transaction 정리=" + (EternalWatchLaterSafety.safeCleanupAvailable() ? "사용 가능" : "잠김")
                + "\n" + EternalWatchLaterSafeCleaner.diagnosticSummary()
                + "\n" + EternalWatchLaterSafeUndo.diagnosticSummary();
    }

    private static String safeMessage(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return m == null || m.trim().isEmpty() ? (t == null ? "unknown" : t.getClass().getSimpleName()) : m;
    }

    private EternalCleanupCoordinator() { }
}
