package app.morphe.extension.youtube.patches.eternalhistory;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Process;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.innertube.utils.AuthUtils;
import app.morphe.extension.shared.requests.Requester;
import app.morphe.extension.youtube.patches.utils.requests.PlaylistRoutes;

/** Device-side full Watch Later sweep. Google/YouTube credentials never leave the device. */
final class EternalWatchLaterAutoSweep {
    private static final String WATCH_LATER = "WL";
    private static final int MAX_PAGES = 200;
    private static final String PREFS = "eternal_history_watch_later_auto";
    private static final String PREF_LAST_ATTEMPT = "last_attempt_ms";
    private static final String PREF_LAST_SUCCESS = "last_success_ms";
    private static final long SUCCESS_INTERVAL_MS = 6L * 60L * 60L * 1000L;
    private static final long FAILURE_RETRY_MS = 30L * 60L * 1000L;
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
        if (!EternalHistorySettings.ENABLED.get()
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
                    lastStatus = "최근 전체 정리 성공으로 대기 중";
                    return;
                }
                if (!force && lastAttempt > 0 && now - lastAttempt < FAILURE_RETRY_MS) {
                    lastStatus = "최근 전체 정리 시도 후 재시도 대기 중";
                    return;
                }
                prefs.edit().putLong(PREF_LAST_ATTEMPT, now).apply();

                EternalCleanupLedgerSync.Result sync = EternalCleanupLedgerSync.refresh();
                if (!sync.success) {
                    lastStatus = "중앙 기록 동기화 실패: " + sync.error;
                    return;
                }
                if (!isSignedIn()) {
                    lastStatus = "YouTube 로그인 정보가 없어 보류";
                    return;
                }

                SweepResult result = sweep();
                lastStatus = "전체 자동 정리: 확인 " + result.scanned
                        + ", 대상 " + result.qualified
                        + ", 제거 " + result.removed
                        + ", 실패 " + result.failures;
                if (result.failures == 0 && !result.hasMore) {
                    prefs.edit().putLong(PREF_LAST_SUCCESS, System.currentTimeMillis()).apply();
                }
            } catch (Throwable t) {
                lastStatus = "전체 자동 정리 오류: " + safeMessage(t);
                Logger.printDebug(() -> "Eternal Watch Later full auto sweep deferred: " + safeMessage(t));
            } finally {
                running.set(false);
                complete(completion);
            }
        });
    }

    static String diagnosticSummary() {
        return "백그라운드 전체 정리=" + (running.get() ? "진행 중" : lastStatus);
    }

    private static SweepResult sweep() throws Exception {
        ListResult listed = listWatchLater(MAX_PAGES);
        Map<String, Float> progress = EternalHistoryDb.get().loadProgressSnapshot();
        int threshold = EternalHistorySettings.watchLaterCleanupProgressPercent();
        List<Entry> candidates = new ArrayList<>();
        for (Entry e : listed.entries.values()) {
            Float pct = progress.get(e.videoId);
            if (pct != null && pct >= 0f && pct >= threshold) candidates.add(e);
        }

        int removed = 0;
        int failures = 0;
        for (Entry e : candidates) {
            try {
                if (removeEntry(e)) removed++; else failures++;
            } catch (Throwable t) {
                failures++;
                Logger.printDebug(() -> "Eternal background Watch Later remove failed for "
                        + e.videoId + ": " + safeMessage(t));
            }
            sleepQuietly(350L);
        }
        return new SweepResult(listed.entries.size(), candidates.size(), removed, failures, listed.hasMore);
    }

    private static boolean isSignedIn() {
        try { return !AuthUtils.isNotLoggedIn(); }
        catch (Throwable t) { return false; }
    }

    private static Map<String, String> authHeaders() {
        Map<String, String> headers = AuthUtils.getRequestHeader();
        if (headers == null || headers.isEmpty()) {
            throw new IllegalStateException("YouTube 인증 헤더가 없습니다.");
        }
        return headers;
    }

    private static Entry resolveEntry(String videoId) throws Exception {
        byte[] body = PlaylistRoutes.getSetVideoIdBody(videoId, WATCH_LATER);
        JSONObject json = request(PlaylistRoutes.GET_SET_VIDEO_ID, body);
        LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
        collect(json, entries, new ArrayList<>(), 0);
        for (Entry e : entries.values()) if (videoId.equals(e.videoId)) return e;
        return null;
    }

    private static boolean removeEntry(Entry entry) throws Exception {
        if (entry == null || !validVideoId(entry.videoId) || !validSetVideoId(entry.setVideoId)) return false;
        byte[] body = PlaylistRoutes.editPlaylistBody(entry.videoId, WATCH_LATER, entry.setVideoId);
        JSONObject json = request(PlaylistRoutes.EDIT_PLAYLIST, body);
        if (!"STATUS_SUCCEEDED".equals(json.optString("status", ""))) return false;

        for (int attempt = 0; attempt < 4; attempt++) {
            sleepQuietly(400L + attempt * 350L);
            if (resolveEntry(entry.videoId) == null) return true;
        }
        return false;
    }

    private static ListResult listWatchLater(int maxPages) throws Exception {
        LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
        Set<String> seen = new HashSet<>();
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
            int before = entries.size();
            collect(json, entries, continuations, 0);
            String next = null;
            for (String token : continuations) {
                if (validToken(token) && seen.add(token)) { next = token; break; }
            }
            if (next == null || (pages > 1 && entries.size() == before)) {
                continuation = null;
                break;
            }
            continuation = next;
            hasMore = true;
            sleepQuietly(100L);
        } while (pages < Math.max(1, maxPages));
        if (continuation == null) hasMore = false;
        return new ListResult(entries, hasMore && pages >= maxPages);
    }

    private static JSONObject request(app.morphe.extension.shared.requests.Route.CompiledRoute route,
                                      byte[] body) throws Exception {
        java.net.HttpURLConnection connection = PlaylistRoutes.getConnection(route, authHeaders());
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

    private static void collect(Object node, Map<String, Entry> entries,
                                List<String> continuations, int depth) {
        if (node == null || depth > 64) return;
        if (node instanceof JSONObject obj) {
            parseRenderer(obj.optJSONObject("playlistVideoRenderer"), entries);
            parseRenderer(obj.optJSONObject("playlistPanelVideoRenderer"), entries);
            addToken(obj.optJSONObject("continuationCommand"), "token", continuations);
            addToken(obj.optJSONObject("nextContinuationData"), "continuation", continuations);
            addToken(obj.optJSONObject("reloadContinuationData"), "continuation", continuations);
            Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                Object child = obj.opt(keys.next());
                if (child instanceof JSONObject || child instanceof JSONArray) {
                    collect(child, entries, continuations, depth + 1);
                }
            }
        } else if (node instanceof JSONArray arr) {
            for (int i = 0; i < arr.length(); i++) collect(arr.opt(i), entries, continuations, depth + 1);
        }
    }

    private static void parseRenderer(JSONObject renderer, Map<String, Entry> entries) {
        if (renderer == null) return;
        String videoId = renderer.optString("videoId", "");
        String setVideoId = renderer.optString("setVideoId", renderer.optString("playlistSetVideoId", ""));
        if (validVideoId(videoId) && validSetVideoId(setVideoId)) {
            entries.put(setVideoId, new Entry(videoId, setVideoId));
        }
    }

    private static void addToken(JSONObject obj, String key, List<String> out) {
        if (obj == null) return;
        String token = obj.optString(key, "");
        if (validToken(token)) out.add(token);
    }

    private static boolean validVideoId(String value) {
        return value != null && value.matches("^[A-Za-z0-9_-]{11}$");
    }

    private static boolean validSetVideoId(String value) {
        if (value == null || value.length() < 4 || value.length() > 512) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x21 || c > 0x7e) return false;
        }
        return true;
    }

    private static boolean validToken(String value) {
        return value != null && !value.trim().isEmpty() && value.length() < 8192;
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
        final boolean hasMore;
        ListResult(LinkedHashMap<String, Entry> entries, boolean hasMore) {
            this.entries = entries;
            this.hasMore = hasMore;
        }
    }

    private static final class SweepResult {
        final int scanned;
        final int qualified;
        final int removed;
        final int failures;
        final boolean hasMore;
        SweepResult(int scanned, int qualified, int removed, int failures, boolean hasMore) {
            this.scanned = scanned;
            this.qualified = qualified;
            this.removed = removed;
            this.failures = failures;
            this.hasMore = hasMore;
        }
    }

    private EternalWatchLaterAutoSweep() { }
}
