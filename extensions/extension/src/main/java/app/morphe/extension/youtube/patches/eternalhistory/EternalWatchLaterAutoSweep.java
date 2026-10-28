package app.morphe.extension.youtube.patches.eternalhistory;

import android.content.Context;
import android.content.SharedPreferences;
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
 * Low-frequency automatic Watch Later cleanup through the same fail-closed transaction model as
 * the manual cleaner. No legacy direct-delete code is used here.
 */
final class EternalWatchLaterAutoSweep {
    private static final String WATCH_LATER = "WL";
    private static final int MAX_PAGES = 250;
    private static final String PREFS = "eternal_history_watch_later_auto";
    private static final String PREF_LAST_ATTEMPT = "last_attempt_ms";
    private static final String PREF_LAST_SUCCESS = "last_success_ms";
    private static final long SUCCESS_INTERVAL_MS = 6L * 60L * 60L * 1000L;
    private static final long FAILURE_RETRY_MS = 30L * 60L * 1000L;
    private static final long UNDO_RETENTION_MS = 24L * 60L * 60L * 1000L;
    private static final AtomicBoolean running = new AtomicBoolean();
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> {
            try { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); }
            catch (Throwable ignored) { }
            r.run();
        }, "EternalWatchLaterSweep");
        t.setDaemon(true);
        return t;
    });
    private static volatile String lastStatus = "아직 실행하지 않음";

    static void runAsync(boolean force, Runnable completion) {
        if (!EternalWatchLaterSafety.safeCleanupAvailable()
                || !EternalHistorySettings.ENABLED.get()
                || !EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get()) {
            complete(completion);
            return;
        }
        if (!running.compareAndSet(false, true)) {
            complete(completion);
            return;
        }
        IO.execute(() -> {
            try {
                Context context = Utils.getContext();
                if (context == null) {
                    lastStatus = "보류: Android context 없음";
                    return;
                }
                SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                long now = System.currentTimeMillis();
                long lastSuccess = prefs.getLong(PREF_LAST_SUCCESS, 0L);
                long lastAttempt = prefs.getLong(PREF_LAST_ATTEMPT, 0L);
                if (!force && lastSuccess > 0 && now - lastSuccess < SUCCESS_INTERVAL_MS) {
                    lastStatus = "최근 안전 정리 성공으로 대기 중";
                    return;
                }
                if (!force && lastAttempt > 0 && now - lastAttempt < FAILURE_RETRY_MS) {
                    lastStatus = "최근 안전 정리 시도 후 재시도 대기 중";
                    return;
                }
                prefs.edit().putLong(PREF_LAST_ATTEMPT, now).apply();

                EternalCleanupLedgerSync.Result sync = EternalCleanupLedgerSync.refresh();
                if (!sync.success) {
                    lastStatus = "중앙 기록 동기화 실패: " + sync.error;
                    return;
                }
                ensureSignedIn();

                SweepResult result = sweepTransactional();
                lastStatus = "자동 안전 정리: 페이지 " + result.pages
                        + ", 확인 " + result.scanned
                        + ", 대상 " + result.qualified
                        + ", 제거 " + result.removed
                        + ", 실패/보류 " + result.failures
                        + (result.completed ? " · 완료" : " · 중단");

                if (result.completed && result.scanned > 0) {
                    prefs.edit().putLong(PREF_LAST_SUCCESS, System.currentTimeMillis()).apply();
                }
            } catch (Throwable t) {
                lastStatus = "자동 안전 정리 중단: " + safeMessage(t);
                Logger.printDebug(() -> "Eternal transactional Watch Later sweep deferred: " + safeMessage(t));
            } finally {
                running.set(false);
                complete(completion);
            }
        });
    }

    static String diagnosticSummary() {
        return "백그라운드 안전 정리=" + (running.get() ? "진행 중" : lastStatus);
    }

    private static SweepResult sweepTransactional() throws Exception {
        ListResult preview = listWatchLaterStrict(MAX_PAGES);
        if (preview.entries.isEmpty()) {
            throw new IllegalStateException("Watch Later 항목이 0개로 파싱되어 빈 목록인지 확인할 수 없으므로 삭제하지 않습니다.");
        }

        Map<String, Float> progress = EternalHistoryDb.get().loadProgressSnapshot();
        int threshold = Math.max(1, Math.min(100, EternalHistorySettings.watchLaterCleanupProgressPercent()));
        JSONArray candidates = candidatesJson(preview.entries, progress, threshold);
        if (candidates.length() == 0) {
            return new SweepResult(preview.entries.size(), 0, 0, 0, preview.pages, true);
        }

        ensurePreviousJournalReplaceable();
        JSONObject tx = EternalWatchLaterTransactionStore.newTransaction(
                "androidwl:auto:" + UUID.randomUUID(), threshold, preview.pages,
                snapshotJson(preview.entries), candidates);
        tx.put("automatic", true);
        tx.put("undoRetentionUntil", System.currentTimeMillis() + UNDO_RETENTION_MS);

        JSONObject durable = null;
        try {
            // Crash boundary 1: complete first snapshot/journal must be durable before any delete.
            durable = EternalWatchLaterTransactionStore.saveVerified(tx);
            JSONArray originalSnapshot = durable.optJSONArray("snapshot");
            if (originalSnapshot == null || originalSnapshot.length() == 0) {
                throw new IllegalStateException("저장된 Watch Later 스냅샷이 비어 있습니다.");
            }

            // Full independent second enumeration after the durable journal.
            ListResult confirmed = listWatchLaterStrict(MAX_PAGES);
            if (confirmed.entries.isEmpty()) {
                throw new IllegalStateException("두 번째 전체 검사에서 0개가 파싱되어 삭제하지 않습니다.");
            }
            if (!sameMembership(originalSnapshot, confirmed.entries)) {
                throw new IllegalStateException("자동 정리 준비 중 Watch Later 멤버십이 바뀌어 삭제하지 않습니다.");
            }
            durable.put("confirmedPages", confirmed.pages);
            durable.put("verifiedAt", System.currentTimeMillis());
            durable.put("state", "verified");
            durable = EternalWatchLaterTransactionStore.saveVerified(durable);
            durable.put("state", "removing");
            durable.put("removalStartedAt", System.currentTimeMillis());
            durable = EternalWatchLaterTransactionStore.saveVerified(durable);

            boolean stop = false;
            JSONArray durableCandidates = durable.optJSONArray("candidates");
            if (durableCandidates == null) throw new IllegalStateException("안전 journal에 정리 대상이 없습니다.");

            for (int i = 0; i < durableCandidates.length() && !stop; i++) {
                durableCandidates = durable.optJSONArray("candidates");
                JSONObject candidate = durableCandidates == null ? null : durableCandidates.optJSONObject(i);
                if (candidate == null || !"prepared".equals(candidate.optString("status", "prepared"))) continue;

                String videoId = candidate.optString("videoId", "");
                String expectedSetVideoId = candidate.optString("setVideoId", "");
                boolean requestMayHaveBeenSent = false;
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

                    // Crash boundary 2: fsync/read-back 'attempting' before edit_playlist can run.
                    candidate.put("status", "attempting");
                    candidate.put("attemptAt", System.currentTimeMillis());
                    candidate.remove("error");
                    EternalWatchLaterTransactionStore.recalcCounts(durable);
                    durable = EternalWatchLaterTransactionStore.saveVerified(durable);

                    durableCandidates = durable.optJSONArray("candidates");
                    candidate = durableCandidates == null ? null : durableCandidates.optJSONObject(i);
                    if (candidate == null || !"attempting".equals(candidate.optString("status", ""))) {
                        throw new IllegalStateException("삭제 직전 attempting journal 재확인에 실패했습니다.");
                    }

                    // Re-resolve after the journal write so identity validation is adjacent to delete.
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

                    requestMayHaveBeenSent = true;
                    candidate.put("requestStartedAt", System.currentTimeMillis());
                    if (removeFreshEntry(finalFresh)) {
                        candidate.put("status", "removed");
                        candidate.remove("error");
                    } else {
                        candidate.put("status", "failed");
                        candidate.put("error", "서버가 제거 완료를 확인하지 못함");
                        stop = true;
                    }
                } catch (Throwable t) {
                    candidate.put("status", requestMayHaveBeenSent ? "failed" : "aborted_before_request");
                    candidate.put("error", safeMessage(t));
                    stop = true;
                    Logger.printDebug(() -> "Eternal automatic safe remove stopped for "
                            + videoId + ": " + safeMessage(t));
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
            return new SweepResult(
                    preview.entries.size(), candidates.length(), durable.optInt("removedCount", 0),
                    durable.optInt("failureCount", 0) + durable.optInt("uncertainCount", 0),
                    preview.pages, allRemoved);
        } catch (Throwable t) {
            try {
                JSONObject current = durable != null ? durable : EternalWatchLaterTransactionStore.loadCurrent();
                if (current != null && tx.optString("id", "").equals(current.optString("id", ""))) {
                    String state = current.optString("state", "");
                    if (!"completed".equals(state) && !"undone".equals(state)) {
                        current.put("state", "partial");
                        current.put("fatalError", safeMessage(t));
                        current.put("completedAt", System.currentTimeMillis());
                        EternalWatchLaterTransactionStore.recalcCounts(current);
                        EternalWatchLaterTransactionStore.saveVerified(current);
                    }
                }
            } catch (Throwable ignored) { }
            if (t instanceof Exception e) throw e;
            throw new IllegalStateException(t);
        }
    }

    /**
     * Never overwrite an unfinished/partial journal. A successful automatic cleanup keeps its undo
     * evidence for at least 24 hours before the next automatic transaction may archive it.
     */
    private static void ensurePreviousJournalReplaceable() throws Exception {
        JSONObject current = EternalWatchLaterTransactionStore.loadCurrent();
        if (current == null) return;
        String state = current.optString("state", "");
        if ("partial".equals(state) || "undo_partial".equals(state)
                || "prepared".equals(state) || "verified".equals(state)
                || "removing".equals(state) || "undoing".equals(state)) {
            throw new IllegalStateException("이전 안전 정리 기록을 먼저 확인해야 해 자동 정리를 보류합니다.");
        }
        if (EternalWatchLaterTransactionStore.hasUndoableCurrent()) {
            long retainUntil = current.optLong("undoRetentionUntil", 0L);
            long completedAt = current.optLong("completedAt", current.optLong("updatedAt", 0L));
            if (retainUntil <= 0L && completedAt > 0L) retainUntil = completedAt + UNDO_RETENTION_MS;
            if (retainUntil <= 0L || System.currentTimeMillis() < retainUntil) {
                throw new IllegalStateException("마지막 안전 정리의 되돌리기 기간이 남아 있어 자동 정리를 보류합니다.");
            }
        }
        EternalWatchLaterTransactionStore.archiveCurrentIfReplaceable();
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
            if (pct == null || pct < 0f || pct < threshold) continue;
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

    private static JSONObject request(app.morphe.extension.shared.requests.Route.CompiledRoute route,
                                      byte[] body) throws Exception {
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
        try { Thread.sleep(ms); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static String safeMessage(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return m == null || m.trim().isEmpty()
                ? (t == null ? "unknown" : t.getClass().getSimpleName())
                : m;
    }

    private static void complete(Runnable completion) {
        if (completion == null) return;
        try { completion.run(); }
        catch (Throwable ignored) { }
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
        ListResult(LinkedHashMap<String, Entry> entries, int pages) {
            this.entries = entries;
            this.pages = pages;
        }
    }

    private static final class SweepResult {
        final int scanned;
        final int qualified;
        final int removed;
        final int failures;
        final int pages;
        final boolean completed;
        SweepResult(int scanned, int qualified, int removed, int failures,
                    int pages, boolean completed) {
            this.scanned = scanned;
            this.qualified = qualified;
            this.removed = removed;
            this.failures = failures;
            this.pages = pages;
            this.completed = completed;
        }
    }

    private EternalWatchLaterAutoSweep() { }
}
