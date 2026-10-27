package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Process;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.innertube.utils.AuthUtils;
import app.morphe.extension.shared.requests.Requester;
import app.morphe.extension.youtube.patches.utils.requests.PlaylistRoutes;

/**
 * Manual-only fail-closed Watch Later cleanup. The legacy cleaner and all automatic deletion remain
 * locked by EternalWatchLaterSafety.
 *
 * Invariants:
 * 1. A strict full playlist snapshot is prepared before the confirmation dialog.
 * 2. After the user confirms, that complete snapshot/journal is durably saved and read back.
 * 3. The full playlist is independently enumerated again after confirmation and must match exactly.
 * 4. Every candidate is re-resolved by videoId immediately before mutation.
 * 5. "attempting" is durably stored before a delete request can be sent.
 * 6. After that fsync/read-back, identity is resolved once more; mismatch means zero delete request.
 * 7. The result is durably stored before another candidate may be touched.
 * 8. The first ambiguity/failure stops the remaining deletes.
 */
final class EternalWatchLaterSafeCleaner {
    private static final String WATCH_LATER = "WL";
    private static final int MAX_PAGES = 250;
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> {
            try { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); }
            catch (Throwable ignored) { }
            r.run();
        }, "EternalWatchLaterSafe");
        t.setDaemon(true);
        return t;
    });
    private static final AtomicBoolean running = new AtomicBoolean();
    private static volatile String lastStatus = "아직 실행하지 않음";

    static void previewAndConfirmCleanup(Activity activity) {
        if (activity == null) return;
        if (!running.compareAndSet(false, true)) {
            Utils.showToastShort("Watch Later 안전 정리가 이미 진행 중입니다.");
            return;
        }
        Utils.showToastShort("Watch Later 전체 목록을 안전 검사합니다…");
        IO.execute(() -> {
            try {
                ensureSignedIn();
                ListResult preview = listWatchLaterStrict(MAX_PAGES);
                if (preview.entries.isEmpty()) {
                    throw new IllegalStateException("Watch Later 항목이 0개로 파싱되어 빈 목록인지 확인할 수 없으므로 삭제하지 않습니다.");
                }
                Map<String, Float> progress = EternalHistoryDb.get().loadProgressSnapshot();
                int threshold = cleanupThreshold();
                JSONArray snapshot = snapshotJson(preview.entries);
                JSONArray candidates = candidatesJson(preview.entries, progress, threshold);
                JSONObject tx = EternalWatchLaterTransactionStore.newTransaction(
                        "androidwl:" + UUID.randomUUID(), threshold, preview.pages, snapshot, candidates);
                lastStatus = "안전 미리보기: 페이지 " + preview.pages + ", " + preview.entries.size()
                        + "개 중 " + candidates.length() + "개 대상";
                activity.runOnUiThread(() -> showConfirmation(activity, tx));
            } catch (Throwable t) {
                running.set(false);
                lastStatus = "안전 검사 중단: " + safeMessage(t);
                activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
            }
        });
    }

    private static void showConfirmation(Activity activity, JSONObject tx) {
        JSONArray candidates = tx.optJSONArray("candidates");
        int count = candidates == null ? 0 : candidates.length();
        int threshold = tx.optInt("threshold", cleanupThreshold());
        if (count == 0) {
            running.set(false);
            Utils.showToastShort(threshold + "% 이상 본 Watch Later 영상이 없습니다.");
            return;
        }
        StringBuilder preview = new StringBuilder();
        for (int i = 0; i < Math.min(6, count); i++) {
            JSONObject c = candidates.optJSONObject(i);
            if (c == null) continue;
            if (preview.length() > 0) preview.append('\n');
            preview.append(c.optString("videoId", "?"))
                    .append(" (").append(Math.round(c.optDouble("progressPct", 0))).append("%)");
        }
        if (count > 6) preview.append("\n외 ").append(count - 6).append("개");
        new AlertDialog.Builder(activity)
                .setTitle("Watch Later 안전 정리")
                .setMessage("Eternal 진행률 " + threshold + "% 이상인 영상 " + count + "개를 정리할까요?\n\n"
                        + preview
                        + "\n\n확인 후 전체 Watch Later를 다시 읽어 첫 스냅샷과 정확히 같을 때만 시작합니다. "
                        + "각 삭제는 journal 선저장과 식별자 재검증을 통과해야 하며, 중간 실패 시 즉시 멈춥니다.")
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> running.set(false))
                .setOnCancelListener(dialog -> running.set(false))
                .setPositiveButton("안전 정리", (dialog, which) -> IO.execute(() -> executeCleanup(activity, tx)))
                .show();
    }

    private static void executeCleanup(Activity activity, JSONObject tx) {
        JSONObject durable = null;
        try {
            ensureSignedIn();
            EternalWatchLaterTransactionStore.archiveCurrentIfReplaceable();

            // Full pre-delete evidence must survive a process death before any destructive request.
            durable = EternalWatchLaterTransactionStore.saveVerified(tx);
            JSONArray originalSnapshot = durable.optJSONArray("snapshot");
            if (originalSnapshot == null || originalSnapshot.length() == 0) {
                throw new IllegalStateException("저장된 Watch Later 스냅샷이 비어 있습니다.");
            }

            activity.runOnUiThread(() -> Utils.showToastShort("확인 후 Watch Later 전체 목록을 다시 검증합니다…"));
            ListResult confirmed = listWatchLaterStrict(MAX_PAGES);
            if (confirmed.entries.isEmpty()) {
                throw new IllegalStateException("두 번째 전체 검사에서 0개가 파싱되어 삭제하지 않습니다.");
            }
            if (!sameMembership(originalSnapshot, confirmed.entries)) {
                throw new IllegalStateException("확인창 이후 Watch Later 멤버십이 바뀌어 삭제하지 않습니다.");
            }
            durable.put("confirmedPages", confirmed.pages);
            durable.put("verifiedAt", System.currentTimeMillis());
            durable.put("state", "verified");
            durable = EternalWatchLaterTransactionStore.saveVerified(durable);
            durable.put("state", "removing");
            durable.put("removalStartedAt", System.currentTimeMillis());
            durable = EternalWatchLaterTransactionStore.saveVerified(durable);

            JSONArray candidates = durable.optJSONArray("candidates");
            if (candidates == null) throw new IllegalStateException("안전 journal에 정리 대상이 없습니다.");
            boolean stop = false;

            for (int i = 0; i < candidates.length() && !stop; i++) {
                candidates = durable.optJSONArray("candidates");
                JSONObject candidate = candidates == null ? null : candidates.optJSONObject(i);
                if (candidate == null) continue;
                if (!"prepared".equals(candidate.optString("status", "prepared"))) continue;

                String videoId = candidate.optString("videoId", "");
                String expectedSetVideoId = candidate.optString("setVideoId", "");
                final int index = i + 1;
                final int total = candidates.length();
                activity.runOnUiThread(() -> Utils.showToastShort(index + "/" + total + " 삭제 직전 식별자 확인…"));

                try {
                    Entry firstFresh = resolveEntryStrict(videoId);
                    if (firstFresh == null) {
                        markNoRequest(candidate, "missing", "현재 Watch Later에서 항목을 찾지 못함");
                        durable = persistResult(durable);
                        stop = true;
                        break;
                    }
                    if (!expectedSetVideoId.equals(firstFresh.setVideoId)) {
                        markNoRequest(candidate, "identity_mismatch", "현재 setVideoId가 스냅샷과 다름");
                        durable = persistResult(durable);
                        stop = true;
                        break;
                    }

                    // Critical crash boundary: no edit_playlist request is allowed before this state
                    // has been fsynced and read back successfully.
                    candidate.put("status", "attempting");
                    candidate.put("attemptAt", System.currentTimeMillis());
                    candidate.remove("error");
                    EternalWatchLaterTransactionStore.recalcCounts(durable);
                    durable = EternalWatchLaterTransactionStore.saveVerified(durable);

                    candidates = durable.optJSONArray("candidates");
                    candidate = candidates == null ? null : candidates.optJSONObject(i);
                    if (candidate == null || !"attempting".equals(candidate.optString("status", ""))) {
                        throw new IllegalStateException("삭제 직전 attempting journal 재확인에 실패했습니다.");
                    }

                    // Re-resolve after the durable write. This is the identity check immediately
                    // adjacent to the destructive request.
                    Entry finalFresh = resolveEntryStrict(videoId);
                    if (finalFresh == null) {
                        markNoRequest(candidate, "missing", "journal 저장 후 항목이 사라져 요청하지 않음");
                        durable = persistResult(durable);
                        stop = true;
                        break;
                    }
                    if (!expectedSetVideoId.equals(finalFresh.setVideoId)) {
                        markNoRequest(candidate, "identity_mismatch", "journal 저장 후 setVideoId가 바뀌어 요청하지 않음");
                        durable = persistResult(durable);
                        stop = true;
                        break;
                    }

                    if (removeFreshEntry(finalFresh)) {
                        candidate.put("status", "removed");
                        candidate.remove("error");
                    } else {
                        candidate.put("status", "failed");
                        candidate.put("error", "서버가 제거 완료를 확인하지 못함");
                        stop = true;
                    }
                } catch (Throwable t) {
                    // If attempting was already persisted, failure is rollback-eligible because the
                    // request outcome may be uncertain. If it was never persisted, no request could
                    // have been sent by this implementation.
                    String currentStatus = candidate.optString("status", "prepared");
                    if ("attempting".equals(currentStatus)) {
                        candidate.put("status", "failed");
                    } else {
                        candidate.put("status", "aborted_before_request");
                    }
                    candidate.put("error", safeMessage(t));
                    stop = true;
                    Logger.printDebug(() -> "Eternal safe Watch Later remove stopped for " + videoId + ": " + safeMessage(t));
                }

                candidate.put("resultAt", System.currentTimeMillis());
                durable = persistResult(durable);
                if (!"removed".equals(candidate.optString("status", ""))) stop = true;
                sleepQuietly(300L);
            }

            EternalWatchLaterTransactionStore.recalcCounts(durable);
            boolean allRemoved = allCandidatesRemoved(durable.optJSONArray("candidates"));
            durable.put("state", allRemoved ? "completed" : "partial");
            durable.put("completedAt", System.currentTimeMillis());
            durable = EternalWatchLaterTransactionStore.saveVerified(durable);
            int removed = durable.optInt("removedCount", 0);
            int failures = durable.optInt("failureCount", 0);
            int uncertain = durable.optInt("uncertainCount", 0);
            lastStatus = allRemoved
                    ? "안전 정리 완료: " + removed + "개 제거 · 되돌리기 가능"
                    : "안전 정리 중단: " + removed + "개 제거 · 실패/보류 " + failures
                        + " · 불확실 " + uncertain + " · 필요한 항목만 되돌리기 가능";
            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
        } catch (Throwable t) {
            lastStatus = "안전 정리 중단: " + safeMessage(t);
            try {
                JSONObject current = durable != null ? durable : EternalWatchLaterTransactionStore.loadCurrent();
                if (current != null && tx.optString("id", "").equals(current.optString("id", ""))) {
                    current.put("state", "partial");
                    current.put("fatalError", safeMessage(t));
                    current.put("completedAt", System.currentTimeMillis());
                    EternalWatchLaterTransactionStore.recalcCounts(current);
                    EternalWatchLaterTransactionStore.saveVerified(current);
                }
            } catch (Throwable ignored) { }
            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
        } finally {
            running.set(false);
        }
    }

    private static JSONObject persistResult(JSONObject durable) throws Exception {
        EternalWatchLaterTransactionStore.recalcCounts(durable);
        return EternalWatchLaterTransactionStore.saveVerified(durable);
    }

    private static void markNoRequest(JSONObject candidate, String status, String reason) throws Exception {
        candidate.put("status", status);
        candidate.put("error", reason);
        candidate.put("resultAt", System.currentTimeMillis());
    }

    private static boolean allCandidatesRemoved(JSONArray candidates) {
        if (candidates == null) return false;
        for (int i = 0; i < candidates.length(); i++) {
            JSONObject c = candidates.optJSONObject(i);
            if (c == null || !"removed".equals(c.optString("status", ""))) return false;
        }
        return true;
    }

    static boolean hasUndoableTransaction() {
        return EternalWatchLaterTransactionStore.hasUndoableCurrent();
    }

    static String diagnosticSummary() {
        return "수동 안전 정리=" + (running.get() ? "진행 중" : lastStatus)
                + "\n" + EternalWatchLaterTransactionStore.diagnosticSummary();
    }

    private static JSONArray snapshotJson(LinkedHashMap<String, Entry> entries) throws Exception {
        JSONArray out = new JSONArray();
        for (Entry e : entries.values()) {
            JSONObject item = new JSONObject();
            item.put("videoId", e.videoId);
            item.put("setVideoId", e.setVideoId);
            out.put(item);
        }
        return out;
    }

    private static JSONArray candidatesJson(LinkedHashMap<String, Entry> entries,
                                             Map<String, Float> progress, int threshold) throws Exception {
        JSONArray out = new JSONArray();
        for (Entry e : entries.values()) {
            Float pct = progress.get(e.videoId);
            if (pct == null || pct < 0 || pct < threshold) continue;
            JSONObject item = new JSONObject();
            item.put("videoId", e.videoId);
            item.put("setVideoId", e.setVideoId);
            item.put("progressPct", pct.doubleValue());
            item.put("status", "prepared");
            item.put("undoStatus", "pending");
            out.put(item);
        }
        return out;
    }

    private static boolean sameMembership(JSONArray snapshot, LinkedHashMap<String, Entry> current) {
        if (snapshot == null || snapshot.length() != current.size()) return false;
        Map<String, String> expected = new HashMap<>();
        for (int i = 0; i < snapshot.length(); i++) {
            JSONObject item = snapshot.optJSONObject(i);
            if (item == null) return false;
            String videoId = item.optString("videoId", "");
            String setVideoId = item.optString("setVideoId", "");
            if (!EternalWatchLaterPayload.validVideoId(videoId)
                    || !EternalWatchLaterPayload.validSetVideoId(setVideoId)) return false;
            String old = expected.put(videoId, setVideoId);
            if (old != null && !old.equals(setVideoId)) return false;
        }
        Map<String, String> actual = new HashMap<>();
        for (Entry e : current.values()) {
            String old = actual.put(e.videoId, e.setVideoId);
            if (old != null && !old.equals(e.setVideoId)) return false;
        }
        return expected.equals(actual);
    }

    private static Entry resolveEntryStrict(String videoId) throws Exception {
        if (!EternalWatchLaterPayload.validVideoId(videoId)) {
            throw new IllegalArgumentException("올바르지 않은 videoId입니다.");
        }
        byte[] body = PlaylistRoutes.getSetVideoIdBody(videoId, WATCH_LATER);
        JSONObject json = request(PlaylistRoutes.GET_SET_VIDEO_ID, body);
        StrictPairMap parsed = new StrictPairMap();
        EternalWatchLaterPayload.collect(json, parsed, new ArrayList<>(), 0);
        if (parsed.conflict) throw new IllegalStateException("현재 Watch Later 식별자가 모호해 쓰기 작업을 중단합니다.");
        Entry found = null;
        for (Map.Entry<String, String> pair : parsed.entrySet()) {
            if (!videoId.equals(pair.getValue())) continue;
            if (found != null && !found.setVideoId.equals(pair.getKey())) {
                throw new IllegalStateException("현재 videoId에 setVideoId가 둘 이상이라 쓰기 작업을 중단합니다.");
            }
            found = new Entry(videoId, pair.getKey());
        }
        return found;
    }

    private static boolean removeFreshEntry(Entry fresh) throws Exception {
        if (fresh == null || !EternalWatchLaterPayload.validVideoId(fresh.videoId)
                || !EternalWatchLaterPayload.validSetVideoId(fresh.setVideoId)) return false;
        byte[] body = PlaylistRoutes.editPlaylistBody(fresh.videoId, WATCH_LATER, fresh.setVideoId);
        JSONObject json = request(PlaylistRoutes.EDIT_PLAYLIST, body);
        if (!"STATUS_SUCCEEDED".equals(json.optString("status", ""))) return false;
        for (int i = 0; i < 4; i++) {
            sleepQuietly(250L + i * 150L);
            if (resolveEntryStrict(fresh.videoId) == null) return true;
        }
        return false;
    }

    /** Strict full enumeration. Any pagination ambiguity is an exception, never a terminal list. */
    private static ListResult listWatchLaterStrict(int maxPages) throws Exception {
        LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
        Map<String, String> byVideo = new HashMap<>();
        Set<String> consumedTokens = new HashSet<>();
        String continuation = null;
        int pages = 0;

        for (;;) {
            byte[] initial = PlaylistRoutes.browsePlaylistBody(WATCH_LATER);
            JSONObject body = new JSONObject(new String(initial, StandardCharsets.UTF_8));
            if (continuation != null) {
                body.remove("browseId");
                body.put("continuation", continuation);
            }
            JSONObject json = request(PlaylistRoutes.BROWSE_PLAYLIST, body.toString().getBytes(StandardCharsets.UTF_8));
            pages++;
            StrictPairMap parsed = new StrictPairMap();
            ArrayList<String> rawContinuations = new ArrayList<>();
            EternalWatchLaterPayload.collect(json, parsed, rawContinuations, 0);
            if (parsed.conflict) throw new IllegalStateException("Watch Later 응답 안에서 setVideoId 매핑 충돌을 발견했습니다.");

            int before = entries.size();
            for (Map.Entry<String, String> pair : parsed.entrySet()) {
                String setId = pair.getKey();
                String videoId = pair.getValue();
                if (!EternalWatchLaterPayload.validSetVideoId(setId)
                        || !EternalWatchLaterPayload.validVideoId(videoId)) {
                    throw new IllegalStateException("Watch Later 식별자가 올바르지 않습니다.");
                }
                String previousSet = byVideo.putIfAbsent(videoId, setId);
                if (previousSet != null && !previousSet.equals(setId)) {
                    throw new IllegalStateException("동일 videoId에 setVideoId가 둘 이상이라 정리를 중단합니다.");
                }
                Entry previous = entries.get(setId);
                if (previous != null && !previous.videoId.equals(videoId)) {
                    throw new IllegalStateException("동일 setVideoId가 서로 다른 videoId에 연결되어 정리를 중단합니다.");
                }
                entries.put(setId, new Entry(videoId, setId));
                if (entries.size() > EternalWatchLaterTransactionStore.MAX_SNAPSHOT_ENTRIES) {
                    throw new IllegalStateException("Watch Later 항목이 안전 한도를 초과합니다.");
                }
            }

            LinkedHashSet<String> pageTokens = new LinkedHashSet<>();
            for (String token : rawContinuations) {
                if (EternalWatchLaterPayload.validToken(token)) pageTokens.add(token);
            }
            if (pageTokens.isEmpty()) return new ListResult(entries, pages);
            if (pageTokens.size() != 1) {
                throw new IllegalStateException("Watch Later 응답에 서로 다른 continuation이 여러 개라 전체 목록을 확정할 수 없습니다.");
            }
            String next = pageTokens.iterator().next();
            if (!consumedTokens.add(next)) {
                throw new IllegalStateException("Watch Later continuation token이 반복되어 전체 목록을 확정할 수 없습니다.");
            }
            if (entries.size() == before) {
                throw new IllegalStateException("Watch Later continuation이 있는데 새 항목이 없어 전체 목록을 확정할 수 없습니다.");
            }
            if (pages >= Math.max(1, maxPages)) {
                throw new IllegalStateException("Watch Later 전체 목록이 안전 페이지 한도를 초과했습니다.");
            }
            continuation = next;
            sleepQuietly(100L);
        }
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

    private static int cleanupThreshold() {
        return Math.max(1, Math.min(100, EternalHistorySettings.WATCH_LATER_CLEANUP_MIN_PROGRESS.get()));
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

    private static final class ListResult {
        final LinkedHashMap<String, Entry> entries;
        final int pages;
        ListResult(LinkedHashMap<String, Entry> entries, int pages) {
            this.entries = entries;
            this.pages = pages;
        }
    }

    private EternalWatchLaterSafeCleaner() { }
}
