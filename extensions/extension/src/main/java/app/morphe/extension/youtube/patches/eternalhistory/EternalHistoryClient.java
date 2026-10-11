package app.morphe.extension.youtube.patches.eternalhistory;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Process;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.youtube.patches.VideoInformation;

/**
 * Android thin client for the Eternal D1 ledger.
 * Network/SQLite work stays on one low-priority background thread. Feed membership checks use an
 * in-memory map. Cloud uploads are deliberately batched so playback never causes one request per
 * progress bucket.
 */
final class EternalHistoryClient {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> {
            try {
                Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND);
            } catch (Throwable ignored) { }
            r.run();
        }, "EternalHistoryIO");
        t.setDaemon(true);
        return t;
    });
    private static final AtomicBoolean initialized = new AtomicBoolean();
    private static final AtomicBoolean cacheLoadScheduled = new AtomicBoolean();
    private static final ConcurrentHashMap<String, Float> WATCHED_CACHE = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, String> TITLE_CACHE = new ConcurrentHashMap<>();

    private static final String SOURCE = "android-morphe-direct";
    private static final String META_REV = "cloud_rev";
    private static final String META_PULL_AT = "last_pull_at";
    private static final long MIN_UPLOAD_INTERVAL_MS = 60_000L;

    private static volatile long lastUploadAttemptElapsed;
    private static String currentVideoId = "";
    private static long sessionStartedAt;
    private static long lastVideoTimeMs = -1;
    private static long playedMs;
    private static boolean newSessionPending = true;
    private static boolean qualified;
    private static boolean eventQueued;
    private static int lastProgressBucket = -1;

    static void initialize() {
        if (!initialized.compareAndSet(false, true)) return;

        // The large permanent-history cache exists only to support watched-card visuals. Do not
        // download/touch tens of thousands of historical rows when that feature is disabled.
        if (EternalHistorySettings.isFeedVisualEnabled()) {
            scheduleCacheLoadAndMaintenance(true);
        } else {
            IO.execute(() -> {
                try {
                    flushOutboxIfDue(true);
                } catch (Throwable t) {
                    Logger.printDebug(() -> "Eternal History startup upload deferred: " + t.getMessage());
                }
            });
        }
    }

    /** Called by the feed filter when watched-card visuals are actually enabled. */
    static void ensureFeedCacheStarted() {
        if (!EternalHistorySettings.isFeedVisualEnabled()) return;
        initialized.compareAndSet(false, true);
        if (WATCHED_CACHE.isEmpty()) {
            scheduleCacheLoadAndMaintenance(true);
        }
    }

    private static void scheduleCacheLoadAndMaintenance(boolean forcePull) {
        if (!cacheLoadScheduled.compareAndSet(false, true)) return;
        IO.execute(() -> {
            try {
                loadLocalCache();
                flushOutboxIfDue(true);
                syncCacheIfDue(forcePull);
            } catch (Throwable t) {
                Logger.printException(() -> "Eternal History initialization failure", t);
            } finally {
                cacheLoadScheduled.set(false);
            }
        });
    }

    private static void loadLocalCache() {
        EternalHistoryDb db = EternalHistoryDb.get();
        WATCHED_CACHE.putAll(db.loadProgressSnapshot());
        TITLE_CACHE.putAll(db.loadTitleSnapshot());
    }

    static void onNewVideoStarted() {
        newSessionPending = true;
    }

    static void onVideoIdChanged(String videoId) {
        if (videoId == null || videoId.length() != 11) return;
        // Morphe may emit the same ID more than once for one playback. Do not create duplicate sessions.
        if (videoId.equals(currentVideoId) && !newSessionPending && sessionStartedAt > 0) return;

        currentVideoId = videoId;
        sessionStartedAt = System.currentTimeMillis();
        lastVideoTimeMs = -1;
        playedMs = 0;
        newSessionPending = false;
        qualified = false;
        eventQueued = false;
        lastProgressBucket = -1;

        IO.execute(() -> {
            try {
                flushOutboxIfDue(false);
                syncCacheIfDue(false);
            } catch (Throwable t) {
                Logger.printDebug(() -> "Eternal History video-change maintenance deferred: " + t.getMessage());
            }
        });
    }

    static void onVideoTimeChanged(long videoTimeMs) {
        if (!EternalHistorySettings.ENABLED.get()) return;
        final String videoId = currentVideoId;
        if (videoId.length() != 11 || videoTimeMs < 0) return;

        // Count actual forward playback, not a seek jump. AddOnApi normally fires ~once/sec.
        if (lastVideoTimeMs >= 0) {
            long delta = videoTimeMs - lastVideoTimeMs;
            if (delta > 0 && delta <= 5_000L) playedMs += delta;
        }
        lastVideoTimeMs = videoTimeMs;

        final int minimumSeconds = clamp(EternalHistorySettings.MIN_SECONDS.get(), 1, 600);
        if (!qualified && playedMs >= minimumSeconds * 1000L) {
            qualified = true;
            final long now = System.currentTimeMillis();
            final JSONObject video = makeVideoRecord(videoId, now, progress(videoTimeMs));
            final JSONObject event = makeEvent(videoId, now);
            eventQueued = true;
            IO.execute(() -> persistAndQueue(video, event));
            return;
        }
        if (!qualified) return;

        Double pct = progress(videoTimeMs);
        if (pct == null) return;
        int step = clamp(EternalHistorySettings.PROGRESS_STEP.get(), 1, 25);
        int bucket = (int)Math.floor(pct / step);
        if (bucket <= lastProgressBucket && pct < 99.5) return;
        lastProgressBucket = bucket;
        final long now = System.currentTimeMillis();
        final JSONObject video = makeVideoRecord(videoId, now, pct);
        IO.execute(() -> persistAndQueue(video, null));
    }

    static boolean isWatchedCached(String videoId, double minimumProgress) {
        if (videoId == null || videoId.length() != 11) return false;
        Float pct = WATCHED_CACHE.get(videoId);
        if (pct == null) return false;
        if (minimumProgress <= 0) return true;
        return pct >= 0 && pct >= minimumProgress;
    }

    static String cachedTitle(String videoId) {
        if (videoId == null || videoId.length() != 11) return null;
        return TITLE_CACHE.get(videoId);
    }

    private static void cacheVideo(JSONObject r) {
        if (r == null) return;
        String id = r.optString("videoId", "");
        if (id.length() != 11) return;
        String title = r.optString("title", "").trim();
        if (!title.isEmpty()) TITLE_CACHE.put(id, title);
        float incoming = r.isNull("maxProgressPct") ? -1f : (float)r.optDouble("maxProgressPct", -1);
        WATCHED_CACHE.merge(id, incoming, (oldValue, newValue) -> {
            if (oldValue == null) return newValue;
            if (oldValue < 0) return newValue < 0 ? oldValue : newValue;
            if (newValue < 0) return oldValue;
            return Math.max(oldValue, newValue);
        });
    }

    private static void persistAndQueue(JSONObject video, JSONObject event) {
        try {
            EternalHistoryDb db = EternalHistoryDb.get();
            db.upsertVideo(video);
            cacheVideo(video);
            db.enqueue("video:" + video.optString("videoId"), "video", video);
            if (event != null && eventQueued) {
                db.enqueue("event:" + event.optString("eventId"), "event", event);
            }
            // The outbox is durable. Batch uploads instead of waking radio/TLS for every 5% step.
            flushOutboxIfDue(false);
        } catch (Throwable t) {
            Logger.printException(() -> "Eternal History persist failure", t);
        }
    }

    private static JSONObject makeVideoRecord(String videoId, long now, Double pct) {
        JSONObject r = new JSONObject();
        try {
            String title = safe(VideoInformation.getVideoTitle());
            String channel = safe(VideoInformation.getChannelName());
            String channelId = safe(VideoInformation.getChannelId());
            r.put("videoId", videoId);
            if (!title.isEmpty()) r.put("title", title);
            if (!channel.isEmpty()) r.put("channelName", channel);
            if (!channelId.isEmpty()) r.put("channelId", channelId);
            r.put("firstSeenAt", sessionStartedAt > 0 ? sessionStartedAt : now);
            r.put("lastSeenAt", now);
            r.put("lastPreciseWatchedAt", sessionStartedAt > 0 ? sessionStartedAt : now);
            r.put("firstSource", SOURCE);
            r.put("lastSource", SOURCE);
            if (pct != null) r.put("maxProgressPct", pct); else r.put("maxProgressPct", JSONObject.NULL);
            r.put("updatedAt", now);
        } catch (Exception e) { throw new RuntimeException(e); }
        return r;
    }

    private static JSONObject makeEvent(String videoId, long now) {
        JSONObject e = new JSONObject();
        try {
            long watchedAt = sessionStartedAt > 0 ? sessionStartedAt : now;
            String eventId = "android:" + deviceId() + ":" + videoId + ":" + watchedAt;
            e.put("eventId", eventId);
            e.put("videoId", videoId);
            e.put("watchedAt", watchedAt);
            e.put("discoveredAt", now);
            e.put("source", SOURCE);
            String title = safe(VideoInformation.getVideoTitle());
            String channel = safe(VideoInformation.getChannelName());
            String channelId = safe(VideoInformation.getChannelId());
            if (!title.isEmpty()) e.put("title", title);
            if (!channel.isEmpty()) e.put("channelName", channel);
            if (!channelId.isEmpty()) e.put("channelId", channelId);
            e.put("updatedAt", now);
        } catch (Exception ex) { throw new RuntimeException(ex); }
        return e;
    }

    private static Double progress(long videoTimeMs) {
        long length = VideoInformation.getVideoLength();
        if (length <= 0) return null;
        return Math.max(0.0, Math.min(100.0, (videoTimeMs * 100.0) / length));
    }

    private static void flushOutboxIfDue(boolean force) {
        if (!configured()) return;
        long now = SystemClock.elapsedRealtime();
        long previous = lastUploadAttemptElapsed;
        if (!force && previous > 0 && now - previous < MIN_UPLOAD_INTERVAL_MS) return;
        lastUploadAttemptElapsed = now;
        flushOutbox();
    }

    private static void flushOutbox() {
        if (!configured()) return;
        EternalHistoryDb db = EternalHistoryDb.get();
        List<EternalHistoryDb.OutboxItem> items = db.outbox(100);
        if (items.isEmpty()) return;
        Map<String, List<EternalHistoryDb.OutboxItem>> byKind = new HashMap<>();
        for (EternalHistoryDb.OutboxItem item : items) {
            byKind.computeIfAbsent(item.kind, k -> new ArrayList<>()).add(item);
        }
        for (Map.Entry<String, List<EternalHistoryDb.OutboxItem>> entry : byKind.entrySet()) {
            try {
                JSONArray arr = new JSONArray();
                List<String> keys = new ArrayList<>();
                for (EternalHistoryDb.OutboxItem item : entry.getValue()) {
                    arr.put(new JSONObject(item.payload));
                    keys.add(item.key);
                }
                JSONObject body = new JSONObject();
                final boolean videos = "video".equals(entry.getKey());
                body.put(videos ? "records" : "events", arr);
                requestJson("POST", videos ? "/v1/videos/batch" : "/v1/events/batch", body);
                db.deleteOutbox(keys);
            } catch (Throwable t) {
                Logger.printDebug(() -> "Eternal History upload deferred: " + t.getMessage());
                return;
            }
        }
    }

    private static void syncCacheIfDue(boolean force) {
        if (!configured()
                || !EternalHistorySettings.SYNC_CACHE.get()
                || !EternalHistorySettings.isFeedVisualEnabled()) return;
        EternalHistoryDb db = EternalHistoryDb.get();
        long now = System.currentTimeMillis();
        long last = db.getMetaLong(META_PULL_AT, 0);
        if (!force && now - last < 15L * 60L * 1000L) return;
        try {
            if (db.videoCount() == 0) baselineSync(db);
            else deltaSync(db, 20);
            db.setMetaLong(META_PULL_AT, System.currentTimeMillis());
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal History cache sync deferred: " + t.getMessage());
        }
    }

    private static void baselineSync(EternalHistoryDb db) throws Exception {
        JSONObject stats = requestJson("GET", "/v1/stats", null);
        long baselineRev = stats.optLong("latestChangeRev", 0);
        String after = "";
        for (;;) {
            JSONObject page = requestJson("GET", "/v1/videos?limit=500&after=" + enc(after), null);
            JSONArray records = page.optJSONArray("records");
            if (records == null || records.length() == 0) break;
            db.upsertVideos(records);
            for (int i = 0; i < records.length(); i++) cacheVideo(records.getJSONObject(i));
            after = records.getJSONObject(records.length() - 1).optString("videoId", after);
            if (records.length() < 500) break;
            Thread.yield();
        }
        db.setMetaLong(META_REV, baselineRev);
        deltaSync(db, 50);
    }

    private static void deltaSync(EternalHistoryDb db, int maxPages) throws Exception {
        long cursor = db.getMetaLong(META_REV, 0);
        for (int page = 0; page < maxPages; page++) {
            JSONObject result = requestJson("GET", "/v1/changes?limit=500&after=" + cursor, null);
            JSONArray records = result.optJSONArray("records");
            if (records != null) {
                db.upsertVideos(records);
                for (int i = 0; i < records.length(); i++) cacheVideo(records.getJSONObject(i));
            }
            long next = result.optLong("nextCursor", cursor);
            if (next > cursor) {
                cursor = next;
                db.setMetaLong(META_REV, cursor);
            }
            if (!result.optBoolean("hasMore", false) || next <= 0) break;
            Thread.yield();
        }
    }

    private static JSONObject requestJson(String method, String path, JSONObject body) throws Exception {
        String base = normalizedWorkerUrl();
        URL url = new URL(base + path);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(12000);
        c.setRequestMethod(method);
        c.setRequestProperty("Authorization", "Bearer " + EternalHistorySettings.API_TOKEN.get().trim());
        c.setRequestProperty("Accept", "application/json");
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
        }
        int code = c.getResponseCode();
        InputStream in = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
        String text = readAll(in);
        c.disconnect();
        if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code + ": " + text);
        return text.isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        StringBuilder b = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null;) b.append(line);
        }
        return b.toString();
    }

    private static boolean configured() {
        return EternalHistorySettings.ENABLED.get()
                && !EternalHistorySettings.WORKER_URL.get().trim().isEmpty()
                && !EternalHistorySettings.API_TOKEN.get().trim().isEmpty();
    }

    private static String normalizedWorkerUrl() {
        String s = EternalHistorySettings.WORKER_URL.get().trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static String deviceId() {
        Context context = Utils.getContext();
        if (context == null) return "unknown";
        SharedPreferences p = context.getSharedPreferences("eternal_history", Context.MODE_PRIVATE);
        String id = p.getString("device_id", "");
        if (id == null || id.isEmpty()) {
            id = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            p.edit().putString("device_id", id).apply();
        }
        return id;
    }

    private static String enc(String value) throws Exception {
        return URLEncoder.encode(value == null ? "" : value, "UTF-8");
    }

    private static String safe(String s) { return s == null ? "" : s; }
    private static int clamp(int n, int min, int max) { return Math.max(min, Math.min(max, n)); }

    private EternalHistoryClient() { }
}
