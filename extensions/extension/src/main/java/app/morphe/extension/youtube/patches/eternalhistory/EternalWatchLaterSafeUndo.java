package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Process;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.innertube.utils.AuthUtils;
import app.morphe.extension.shared.requests.Requester;
import app.morphe.extension.youtube.patches.utils.requests.PlaylistRoutes;

/** Idempotent rollback for entries that definitely or possibly received a delete request. */
final class EternalWatchLaterSafeUndo {
    private static final String WATCH_LATER = "WL";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> {
            try { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); }
            catch (Throwable ignored) { }
            r.run();
        }, "EternalWatchLaterUndo");
        t.setDaemon(true);
        return t;
    });
    private static final AtomicBoolean running = new AtomicBoolean();
    private static volatile String lastStatus = "아직 실행하지 않음";

    static boolean hasUndoableTransaction() {
        return EternalWatchLaterTransactionStore.hasUndoableCurrent();
    }

    static void undoLastCleanup(Activity activity) {
        if (activity == null) return;
        if (!running.compareAndSet(false, true)) {
            Utils.showToastShort("Watch Later 되돌리기가 이미 진행 중입니다.");
            return;
        }
        IO.execute(() -> {
            try {
                JSONObject tx = EternalWatchLaterTransactionStore.loadCurrent();
                JSONArray candidates = tx == null ? null : tx.optJSONArray("candidates");
                if (tx == null || candidates == null || "undone".equals(tx.optString("state", ""))) {
                    finishNoWork(activity, "되돌릴 안전 정리 기록이 없습니다.");
                    return;
                }
                int restoreCount = 0;
                int untouched = 0;
                for (int i = 0; i < candidates.length(); i++) {
                    if (EternalWatchLaterTransactionStore.shouldRestore(candidates.optJSONObject(i))) restoreCount++;
                    else untouched++;
                }
                if (restoreCount == 0) {
                    finishNoWork(activity, "삭제 요청이 실제로 전송됐거나 결과가 불확실한 항목이 없습니다.");
                    return;
                }
                final JSONObject loaded = tx;
                final int count = restoreCount;
                final int skipped = untouched;
                activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                        .setTitle("마지막 안전 정리 되돌리기")
                        .setMessage("삭제됐거나 삭제 요청 결과가 불확실한 " + count
                                + "개의 Watch Later 멤버십만 확인·복구할까요?"
                                + (skipped > 0 ? "\n\n삭제 요청을 보내지 않은 " + skipped + "개는 건드리지 않습니다." : "")
                                + "\n\nYouTube 추가 API 특성상 원래의 정확한 목록 위치까지는 복원되지 않을 수 있습니다.")
                        .setNegativeButton(android.R.string.cancel, (dialog, which) -> running.set(false))
                        .setOnCancelListener(dialog -> running.set(false))
                        .setPositiveButton("되돌리기", (dialog, which) -> IO.execute(() -> executeUndo(activity, loaded)))
                        .show());
            } catch (Throwable t) {
                running.set(false);
                lastStatus = "되돌리기 준비 실패: " + safeMessage(t);
                activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
            }
        });
    }

    private static void finishNoWork(Activity activity, String message) {
        running.set(false);
        activity.runOnUiThread(() -> Utils.showToastShort(message));
    }

    private static void executeUndo(Activity activity, JSONObject tx) {
        try {
            ensureSignedIn();
            tx.put("state", "undoing");
            tx.put("undoStartedAt", System.currentTimeMillis());
            JSONObject durable = EternalWatchLaterTransactionStore.saveVerified(tx);
            JSONArray candidates = durable.optJSONArray("candidates");
            if (candidates == null) throw new IllegalStateException("복구 대상 journal이 없습니다.");

            for (int i = 0; i < candidates.length(); i++) {
                JSONObject candidate = candidates.optJSONObject(i);
                if (candidate == null) continue;
                if (!EternalWatchLaterTransactionStore.shouldRestore(candidate)) {
                    candidate.put("undoStatus", "not_removed");
                    candidate.put("undoAt", System.currentTimeMillis());
                    durable = EternalWatchLaterTransactionStore.saveVerified(durable);
                    candidates = durable.optJSONArray("candidates");
                    continue;
                }
                String undoStatus = candidate.optString("undoStatus", "pending");
                if ("restored".equals(undoStatus) || "already_present".equals(undoStatus)) continue;

                String videoId = candidate.optString("videoId", "");
                try {
                    Entry existing = resolveEntryStrict(videoId);
                    if (existing != null) {
                        candidate.put("undoStatus", "already_present");
                    } else if (addEntry(videoId)) {
                        candidate.put("undoStatus", "restored");
                    } else {
                        candidate.put("undoStatus", "failed");
                        candidate.put("undoError", "서버가 복구를 확인하지 않음");
                    }
                } catch (Throwable t) {
                    candidate.put("undoStatus", "failed");
                    candidate.put("undoError", safeMessage(t));
                }
                candidate.put("undoAt", System.currentTimeMillis());
                EternalWatchLaterTransactionStore.recalcCounts(durable);
                durable = EternalWatchLaterTransactionStore.saveVerified(durable);
                candidates = durable.optJSONArray("candidates");
                sleepQuietly(250L);
            }

            EternalWatchLaterTransactionStore.recalcCounts(durable);
            int failures = durable.optInt("undoFailureCount", 0);
            durable.put("state", failures == 0 ? "undone" : "undo_partial");
            durable.put("undoCompletedAt", System.currentTimeMillis());
            durable = EternalWatchLaterTransactionStore.saveVerified(durable);
            int restored = durable.optInt("undoRestoredCount", 0);
            lastStatus = failures == 0
                    ? "되돌리기 완료: " + restored + "개 멤버십 확인/복구"
                    : "되돌리기: " + restored + "개 확인/복구 · " + failures + "개 실패";
            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
        } catch (Throwable t) {
            lastStatus = "되돌리기 중단: " + safeMessage(t);
            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
        } finally {
            running.set(false);
        }
    }

    static String diagnosticSummary() {
        return "안전 되돌리기=" + (running.get() ? "진행 중" : lastStatus);
    }

    private static Entry resolveEntryStrict(String videoId) throws Exception {
        if (!EternalWatchLaterPayload.validVideoId(videoId)) {
            throw new IllegalArgumentException("올바르지 않은 videoId입니다.");
        }
        byte[] body = PlaylistRoutes.getSetVideoIdBody(videoId, WATCH_LATER);
        JSONObject json = request(PlaylistRoutes.GET_SET_VIDEO_ID, body);
        StrictPairMap parsed = new StrictPairMap();
        EternalWatchLaterPayload.collect(json, parsed, new ArrayList<>(), 0);
        if (parsed.conflict) throw new IllegalStateException("현재 Watch Later 식별자가 모호해 복구를 중단합니다.");
        Entry found = null;
        for (Map.Entry<String, String> pair : parsed.entrySet()) {
            if (!videoId.equals(pair.getValue())) continue;
            if (found != null && !found.setVideoId.equals(pair.getKey())) {
                throw new IllegalStateException("현재 videoId에 setVideoId가 둘 이상이라 복구를 중단합니다.");
            }
            found = new Entry(videoId, pair.getKey());
        }
        return found;
    }

    private static boolean addEntry(String videoId) throws Exception {
        if (!EternalWatchLaterPayload.validVideoId(videoId)) return false;
        byte[] body = PlaylistRoutes.editPlaylistBody(videoId, WATCH_LATER, null);
        JSONObject json = request(PlaylistRoutes.EDIT_PLAYLIST, body);
        if (!"STATUS_SUCCEEDED".equals(json.optString("status", ""))) return false;
        for (int i = 0; i < 4; i++) {
            sleepQuietly(250L + i * 150L);
            if (resolveEntryStrict(videoId) != null) return true;
        }
        return false;
    }

    private static JSONObject request(app.morphe.extension.shared.requests.Route.CompiledRoute route, byte[] body) throws Exception {
        HttpURLConnection connection = PlaylistRoutes.getConnection(route, authHeaders());
        try {
            connection.setFixedLengthStreamingMode(body.length);
            connection.getOutputStream().write(body);
            int code = connection.getResponseCode();
            if (code != Requester.HTTP_STATUS_CODE_SUCCESS) {
                InputStream err = connection.getErrorStream();
                if (err != null) try { err.close(); } catch (Exception ignored) { }
                throw new IllegalStateException("YouTube API HTTP " + code);
            }
            return Requester.parseJSONObject(connection);
        } finally {
            connection.disconnect();
        }
    }

    private static void ensureSignedIn() {
        try {
            if (AuthUtils.isNotLoggedIn()) throw new IllegalStateException("YouTube 로그인 정보를 가져올 수 없습니다.");
        } catch (IllegalStateException e) {
            throw e;
        } catch (Throwable t) {
            throw new IllegalStateException("YouTube 로그인 상태를 확인할 수 없습니다.", t);
        }
    }

    private static Map<String, String> authHeaders() {
        Map<String, String> headers = AuthUtils.getRequestHeader();
        if (headers == null || headers.isEmpty()) throw new IllegalStateException("YouTube 인증 헤더가 없습니다.");
        return headers;
    }

    private static void sleepQuietly(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static String safeMessage(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return m == null || m.trim().isEmpty() ? (t == null ? "unknown" : t.getClass().getSimpleName()) : m;
    }

    private static final class StrictPairMap extends LinkedHashMap<String, String> {
        boolean conflict;
        @Override public String put(String key, String value) {
            String old = get(key);
            if (old != null && !old.equals(value)) conflict = true;
            return super.put(key, value);
        }
    }

    private static final class Entry {
        final String videoId;
        final String setVideoId;
        Entry(String videoId, String setVideoId) { this.videoId = videoId; this.setVideoId = setVideoId; }
    }

    private EternalWatchLaterSafeUndo() { }
}
