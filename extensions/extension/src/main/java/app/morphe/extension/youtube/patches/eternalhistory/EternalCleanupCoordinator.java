package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.os.Process;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Utils;

/** Coordinates an explicit central-ledger refresh before manual destructive cleanup. */
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
                activity.runOnUiThread(() -> EternalWatchLaterCleaner.previewAndConfirmCleanup(activity));
            } finally {
                running.set(false);
            }
        });
    }

    static String diagnosticSummary() {
        return "중앙 정리 동기화=" + (running.get() ? "진행 중" : lastSyncStatus);
    }

    private EternalCleanupCoordinator() { }
}
