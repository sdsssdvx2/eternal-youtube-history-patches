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
import java.util.List;
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
 * New manual-only Watch Later cleanup path. The legacy cleaner remains safety-locked.
 *
 * Safety invariants:
 * - two complete independent playlist reads must agree exactly;
 * - the complete membership + every candidate is durably journaled and read back before delete #1;
 * - each videoId is resolved again immediately before delete and fresh setVideoId must match;
 * - each result is durably journaled before the next delete;
 * - undo is idempotent ACTION_ADD_VIDEO and is journaled item-by-item.
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
        Utils.showToastShort("Watch Later 전체 목록을 이중 검증합니다…");
        IO.execute(() -> {
            try {
                ensureSignedIn();
                ListResult first = listWatchLater(MAX_PAGES);
                if (first.hasMore) throw new IllegalStateException("Watch Later 전체 목록을 끝까지 읽지 못해 삭제하지 않습니다.");
                if (first.entries.isEmpty()) throw new IllegalStateException("Watch Later 항목이 0개로 파싱되어 삭제하지 않습니다.");
                if (first.entries.size() > EternalWatchLaterTransactionStore.MAX_SNAPSHOT_ENTRIES) {
                    throw new IllegalStateException("Watch Later 항목이 안전 한도를 초과해 삭제하지 않습니다.");
                }

                sleepQuietly(300L);
                ListResult second = listWatchLater(MAX_PAGES);
                if (second.hasMore) throw new IllegalStateException("두 번째 Watch Later 검사가 완료되지 않아 삭제하지 않습니다.");
                if (!sameMembership(first.entries, second.entries)) {
                    throw new IllegalStateException("두 번 읽은 Watch Later 멤버십이 달라 목록이 안정되지 않았습니다. 삭제하지 않습니다.");
                }

                Map<String, Float> progress = EternalHistoryDb.get().loadProgressSnapshot();
                int threshold = cleanupThreshold();
                JSONArray snapshot = snapshotJson(second.entries);
                JSONArray candidates = candidatesJson(second.entries, progress, threshold);
                JSONObject tx = EternalWatchLaterTransactionStore.newTransaction(
                        "androidwl:" + UUID.randomUUID(), threshold, second.pages, snapshot, candidates);
                lastStatus = "안전 검사: 페이지 " + second.pages + ", " + second.entries.size()
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
                        + preview + "\n\n전체 목록과 대상 journal을 먼저 원자적으로 저장하고, 각 삭제 직전에 현재 식별자를 다시 확인합니다. 마지막 정리는 되돌릴 수 있습니다.")
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> running.set(false))
                .setOnCancelListener(dialog -> running.set(false))
                .setPositiveButton("안전 정리", (dialog, which) -> IO.execute(() -> executeCleanup(activity, tx)))
                .show();
    }

    private static void executeCleanup(Activity activity, JSONObject tx) {
        try {
            EternalWatchLaterTransactionStore.archiveCurrentIfReplaceable();
            JSONObject durable = EternalWatchLaterTransactionStore.saveVerified(tx);
            durable.put("state", "removing");
            durable = EternalWatchLaterTransactionStore.saveVerified(durable);
            JSONArray candidates = durable.optJSONArray("candidates");
            if (candidates == null) throw new IllegalStateException("안전 journal에 정리 대상이 없습니다.");

            for (int i = 0; i < candidates.length(); i++) {
                JSONObject candidate = candidates.optJSONObject(i);
                if (candidate == null) continue;
                String videoId = candidate.optString("videoId", "");
                String expectedSetVideoId = candidate.optString("setVideoId", "");
                final int index = i + 1;
                final int total = candidates.length();
                activity.runOnUiThread(() -> Utils.showToastShort(index + "/" + total + " 삭제 직전 식별자 재검증…"));
                try {
                    Entry fresh = resolveEntryStrict(videoId);
                    if (fresh == null) {
                        candidate.put("status", "missing");
                    } else if (!expectedSetVideoId.equals(fresh.setVideoId)) {
                        candidate.put("status", "identity_mismatch");
                    } else if (removeFreshEntry(fresh)) {
                        candidate.put("status", "removed");
                    } else {
                        candidate.put("status", "failed");
                        candidate.put("error", "서버가 제거를 확인하지 않음");
                    }
                } catch (Throwable t) {
                    candidate.put("status", "failed");
                    candidate.put("error", safeMessage(t));
                    Logger.printDebug(() -> "Eternal safe Watch Later remove failed for " + videoId + ": " + safeMessage(t));
                }
                candidate.put("resultAt", System.currentTimeMillis());
                EternalWatchLaterTransactionStore.recalcCounts(durable);
                // Critical invariant: no next delete until this result has been atomically persisted and read back.
                durable = EternalWatchLaterTransactionStore.saveVerified(durable);
                candidates = durable.optJSONArray("candidates");
                sleepQuietly(300L);
            }

            EternalWatchLaterTransactionStore.recalcCounts(durable);
            int failures = durable.optInt("failureCount", 0);
            durable.put("state", failures == 0 ? "completed" : "partial");
            durable.put("completedAt", System.currentTimeMillis());
            durable = EternalWatchLaterTransactionStore.saveVerified(durable);
            int removed = durable.optInt("removedCount", 0);
            lastStatus = failures == 0
                    ? "안전 정리 완료: " + removed + "개 제거 · 되돌리기 가능"
                    : "안전 정리: " + removed + "개 제거 · " + failures + "개 보류/실패 · 되돌리기 가능";
            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
        } catch (Throwable t) {
            lastStatus = "안전 정리 중단: " + safeMessage(t);
            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
        } finally {
            running.set(false);
        }
    }

    static void undoLastCleanup(Activity activity) {
        if (activity == null) return;
        if (!running.compareAndSet(false, true)) {
            Utils.showToastShort("Watch Later 안전 작업이 이미 진행 중입니다.");
            return;
        }
        IO.execute(() -> {
            try {
                JSONObject tx = EternalWatchLaterTransactionStore.loadCurrent();
                JSONArray candidates = tx == null ? null : tx.optJSONArray("candidates");
                if (tx == null || candidates == null || candidates.length() == 0 || "undone".equals(tx.optString("state", ""))) {
                    running.set(false);
                    activity.runOnUiThread(() -> Utils.showToastShort("되돌릴 안전 정리 기록이 없습니다."));
                    return;
                }
                final JSONObject loaded = tx;
                final int count = candidates.length();
                activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                        .setTitle("마지막 안전 정리 되돌리기")
                        .setMessage("마지막 안전 정리 대상 " + count + "개의 Watch Later 멤버십을 확인하고 빠진 영상만 다시 추가할까요?\n\nYouTube의 추가 API 특성상 원래의 정확한 목록 위치까지는 복원되지 않을 수 있습니다.")
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

    private static boolean sameMembership(LinkedHashMap<String, Entry> a, LinkedHashMap<String, Entry> b) {
        if (a.size() != b.size()) return false;
        Map<String, String> byVideoA = new HashMap<>();
        Map<String, String> byVideoB = new HashMap<>();
        for (Entry e : a.values()) byVideoA.put(e.videoId, e.setVideoId);
        for (Entry e : b.values()) byVideoB.put(e.videoId, e.setVideoId);
        return byVideoA.equals(byVideoB);
    }

    private static Entry resolveEntryStrict(String videoId) throws Exception {
        if (!EternalWatchLaterPayload.validVideoId(videoId)) throw new IllegalArgumentException("올바르지 않은 videoId입니다.");
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

    private static ListResult listWatchLater(int maxPages) throws Exception {
        LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
        Map<String, String> byVideo = new HashMap<>();
        Set<String> seenTokens = new HashSet<>();
        String continuation = null;
        int pages = 0;
        boolean hasMore = false;
        do {
            byte[] initial = PlaylistRoutes.browsePlaylistBody(WATCH_LATER);
            JSONObject body = new JSONObject(new String(initial, StandardCharsets.UTF_8));
            if (continuation != null) {
                body.remove("browseId");
                body.put("continuation", continuation);
            }
            JSONObject json = request(PlaylistRoutes.BROWSE_PLAYLIST, body.toString().getBytes(StandardCharsets.UTF_8));
            pages++;
            ArrayList<String> continuations = new ArrayList<>();
            StrictPairMap parsed = new StrictPairMap();
            EternalWatchLaterPayload.collect(json, parsed, continuations, 0);
            if (parsed.conflict) throw new IllegalStateException("Watch Later 응답 안에서 setVideoId 매핑 충돌을 발견했습니다.");
            int before = entries.size();
            for (Map.Entry<String, String> pair : parsed.entrySet()) {
                String setId = pair.getKey();
                String videoId = pair.getValue();
                if (!EternalWatchLaterPayload.validSetVideoId(setId) || !EternalWatchLaterPayload.validVideoId(videoId)) {
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
            String next = null;
            for (String token : continuations) {
                if (EternalWatchLaterPayload.validToken(token) && seenTokens.add(token)) { next = token; break; }
            }
            if (next == null) {
                continuation = null;
                hasMore = false;
                break;
            }
            if (pages > 1 && entries.size() == before) {
                throw new IllegalStateException("Watch Later continuation이 새 항목 없이 반복되어 전체 목록을 확인할 수 없습니다.");
            }
            continuation = next;
            hasMore = true;
            sleepQuietly(100L);
        } while (pages < Math.max(1, maxPages));
        return new ListResult(entries, pages, hasMore && continuation != null);
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
        Entry(String videoId, String setVideoId) {
            this.videoId = videoId;
            this.setVideoId = setVideoId;
        }
    }

    private static final class ListResult {
        final LinkedHashMap<String, Entry> entries;
        final int pages;
        final boolean hasMore;
        ListResult(LinkedHashMap<String, Entry> entries, int pages, boolean hasMore) {
            this.entries = entries;
            this.pages = pages;
            this.hasMore = hasMore;
        }
    }

    private EternalWatchLaterSafeCleaner() { }
}
