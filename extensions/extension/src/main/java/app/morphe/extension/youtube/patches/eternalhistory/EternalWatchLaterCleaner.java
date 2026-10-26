package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Process;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.innertube.utils.AuthUtils;
import app.morphe.extension.shared.requests.Requester;
import app.morphe.extension.youtube.patches.VideoInformation;
import app.morphe.extension.youtube.patches.utils.requests.PlaylistRoutes;

/**
 * Conservative Watch Later cleanup. Every destructive request uses YouTube's own setVideoId.
 * Unknown Eternal progress and unresolved playlist membership always fail closed.
 */
final class EternalWatchLaterCleaner {
    private static final String WATCH_LATER = "WL";
    private static final int MAX_MANUAL_PAGES = 200;
    private static final long AUTO_RETRY_MS = 30L * 60L * 1000L;
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> {
            try { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); }
            catch (Throwable ignored) { }
            r.run();
        }, "EternalWatchLater");
        t.setDaemon(true);
        return t;
    });
    private static final ConcurrentHashMap<String, Long> AUTO_ATTEMPTS = new ConcurrentHashMap<>();

    private static volatile String currentVideoId = "";
    private static volatile String lastStatus = "대기 중";

    static void onNewVideoStarted() {
        // The ID callback that follows establishes the exact new item.
    }

    static void onVideoIdChanged(String videoId) {
        currentVideoId = EternalWatchLaterPayload.validVideoId(videoId) ? videoId : "";
    }

    static void onVideoTimeChanged(long videoTimeMs) {
        if (!EternalHistorySettings.ENABLED.get() || !EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get()) return;
        final String videoId = currentVideoId;
        if (!EternalWatchLaterPayload.validVideoId(videoId) || videoTimeMs < 0) return;
        long lengthMs = VideoInformation.getVideoLength();
        if (lengthMs <= 0) return;
        double pct = Math.max(0.0, Math.min(100.0, videoTimeMs * 100.0 / lengthMs));
        final int threshold = cleanupThreshold();
        if (pct < threshold) return;

        long now = System.currentTimeMillis();
        Long previous = AUTO_ATTEMPTS.put(videoId, now);
        if (previous != null && now - previous < AUTO_RETRY_MS) return;
        if (AUTO_ATTEMPTS.size() > 512) {
            AUTO_ATTEMPTS.entrySet().removeIf(e -> now - e.getValue() > AUTO_RETRY_MS);
        }

        IO.execute(() -> {
            try {
                if (!isSignedIn()) {
                    lastStatus = "자동 정리 건너뜀: YouTube 로그인 정보 없음";
                    return;
                }
                Entry entry = resolveEntry(videoId);
                if (entry == null) {
                    lastStatus = "자동 정리: 현재 영상은 나중에 볼 목록에 없음";
                    return;
                }
                if (removeEntry(entry)) {
                    lastStatus = "자동 정리 완료: " + videoId + " (" + threshold + "%+)";
                    Activity activity = Utils.getActivity();
                    if (activity != null) activity.runOnUiThread(() -> Utils.showToastShort("나중에 볼에서 자동 제거했습니다."));
                } else {
                    lastStatus = "자동 정리 실패: 서버가 제거를 확인하지 않음";
                }
            } catch (Throwable t) {
                lastStatus = "자동 정리 오류: " + safeMessage(t);
                Logger.printDebug(() -> "Eternal Watch Later auto cleanup deferred: " + safeMessage(t));
            }
        });
    }

    static void previewAndConfirmCleanup(Activity activity) {
        if (activity == null) return;
        Utils.showToastShort("나중에 볼 목록을 검사합니다…");
        IO.execute(() -> {
            try {
                if (!isSignedIn()) throw new IllegalStateException("YouTube 로그인 정보를 가져올 수 없습니다.");
                final ListResult listed = listWatchLater(MAX_MANUAL_PAGES);
                if (listed.entries.isEmpty()) {
                    throw new IllegalStateException("Watch Later 항목이 0개로 파싱되었습니다. 빈 목록인지 확인할 수 없어 삭제를 중단합니다.");
                }
                final Map<String, Float> progress = EternalHistoryDb.get().loadProgressSnapshot();
                final int threshold = cleanupThreshold();
                final List<Entry> candidates = new ArrayList<>();
                for (Entry e : listed.entries.values()) {
                    Float pct = progress.get(e.videoId);
                    if (pct != null && pct >= 0 && pct >= threshold) candidates.add(e);
                }
                lastStatus = "수동 검사: 페이지 " + listed.pages + ", " + listed.entries.size()
                        + "개 중 " + candidates.size() + "개 대상";
                activity.runOnUiThread(() -> showConfirmation(activity, listed, candidates, threshold));
            } catch (Throwable t) {
                lastStatus = "수동 검사 오류: " + safeMessage(t);
                activity.runOnUiThread(() -> Utils.showToastLong("나중에 볼 검사 실패: " + safeMessage(t)));
            }
        });
    }

    private static void showConfirmation(Activity activity, ListResult listed, List<Entry> candidates, int threshold) {
        if (candidates.isEmpty()) {
            Utils.showToastShort(threshold + "% 이상 본 나중에 볼 영상이 없습니다.");
            return;
        }
        String suffix = listed.hasMore ? "\n\n목록이 매우 길어 최대 검사 페이지에 도달했습니다. 확인된 항목만 처리합니다." : "";
        new AlertDialog.Builder(activity)
                .setTitle("나중에 볼 정리")
                .setMessage(candidates.size() + "개 영상을 제거할까요?\nEternal 진행률 " + threshold + "% 이상인 영상만 대상입니다." + suffix)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton("제거", (dialog, which) -> removeManual(activity, candidates))
                .show();
    }

    private static void removeManual(Activity activity, List<Entry> candidates) {
        Utils.showToastShort("나중에 볼 정리를 시작합니다…");
        IO.execute(() -> {
            int removed = 0;
            int failures = 0;
            Set<String> requestedSetIds = new HashSet<>();
            for (Entry e : candidates) {
                requestedSetIds.add(e.setVideoId);
                try {
                    if (removeEntry(e)) removed++; else failures++;
                } catch (Throwable t) {
                    failures++;
                    Logger.printDebug(() -> "Eternal Watch Later remove failed for " + e.videoId + ": " + safeMessage(t));
                }
                sleepQuietly(500);
            }

            boolean verificationComplete = false;
            int remaining = -1;
            try {
                ListResult after = listWatchLater(MAX_MANUAL_PAGES);
                verificationComplete = !after.hasMore && !after.entries.isEmpty();
                int found = 0;
                for (Entry e : after.entries.values()) if (requestedSetIds.contains(e.setVideoId)) found++;
                remaining = found;
                if (verificationComplete) {
                    removed = Math.max(0, candidates.size() - found);
                    failures = found;
                }
            } catch (Throwable t) {
                Logger.printDebug(() -> "Eternal Watch Later verification deferred: " + safeMessage(t));
            }

            final int finalRemoved = removed;
            final int finalFailures = failures;
            final int finalRemaining = remaining;
            final boolean finalVerificationComplete = verificationComplete;
            lastStatus = "수동 정리: 요청 " + candidates.size() + ", 제거 " + finalRemoved + ", 실패 " + finalFailures
                    + (finalVerificationComplete ? ", 서버 잔존 " + Math.max(0, finalRemaining) : ", 검증 일부");
            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
        });
    }

    static String diagnosticSummary() {
        EternalSurfaceSettings.Surface surface = EternalSurfaceTracker.currentForUi();
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.get(surface);
        return "현재 페이지=" + surface.label
                + "\n페이지 흐림=" + profile.dimEnabled + " (" + profile.effectiveDimThreshold() + "%+)"
                + "\n페이지 숨김=" + profile.hideEnabled + " (" + profile.effectiveHideThreshold() + "%+)"
                + "\n나중에 볼 자동 정리=" + (EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get() ? "켜짐" : "꺼짐")
                + "\n정리 기준=" + cleanupThreshold() + "%"
                + "\n최근 상태=" + lastStatus;
    }

    private static boolean isSignedIn() {
        try { return !AuthUtils.isNotLoggedIn(); }
        catch (Throwable t) { return false; }
    }

    private static Map<String, String> authHeaders() {
        Map<String, String> headers = AuthUtils.getRequestHeader();
        if (headers == null || headers.isEmpty()) throw new IllegalStateException("YouTube 인증 헤더가 없습니다.");
        return headers;
    }

    private static Entry resolveEntry(String videoId) throws Exception {
        byte[] body = PlaylistRoutes.getSetVideoIdBody(videoId, WATCH_LATER);
        JSONObject json = request(PlaylistRoutes.GET_SET_VIDEO_ID, body);
        LinkedHashMap<String, String> parsed = new LinkedHashMap<>();
        EternalWatchLaterPayload.collect(json, parsed, new ArrayList<>(), 0);
        for (Map.Entry<String, String> pair : parsed.entrySet()) {
            if (videoId.equals(pair.getValue())) return new Entry(pair.getValue(), pair.getKey());
        }
        return null;
    }

    private static boolean removeEntry(Entry entry) throws Exception {
        if (entry == null
                || !EternalWatchLaterPayload.validVideoId(entry.videoId)
                || !EternalWatchLaterPayload.validSetVideoId(entry.setVideoId)) return false;
        byte[] body = PlaylistRoutes.editPlaylistBody(entry.videoId, WATCH_LATER, entry.setVideoId);
        JSONObject json = request(PlaylistRoutes.EDIT_PLAYLIST, body);
        if (!"STATUS_SUCCEEDED".equals(json.optString("status", ""))) return false;

        for (int verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
            sleepQuietly(250L);
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
            LinkedHashMap<String, String> parsed = new LinkedHashMap<>();
            int before = entries.size();
            EternalWatchLaterPayload.collect(json, parsed, continuations, 0);
            for (Map.Entry<String, String> pair : parsed.entrySet()) {
                entries.put(pair.getKey(), new Entry(pair.getValue(), pair.getKey()));
            }
            String next = null;
            for (String token : continuations) {
                if (EternalWatchLaterPayload.validToken(token) && seen.add(token)) { next = token; break; }
            }
            if (next == null || (pages > 1 && entries.size() == before)) {
                continuation = null;
                break;
            }
            continuation = next;
            hasMore = true;
            sleepQuietly(100);
        } while (pages < Math.max(1, maxPages));
        if (continuation == null) hasMore = false;
        return new ListResult(entries, pages, hasMore && pages >= maxPages);
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

    private static final class Entry {
        final String videoId;
        final String setVideoId;
        Entry(String videoId, String setVideoId) { this.videoId = videoId; this.setVideoId = setVideoId; }
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

    private EternalWatchLaterCleaner() { }
}
