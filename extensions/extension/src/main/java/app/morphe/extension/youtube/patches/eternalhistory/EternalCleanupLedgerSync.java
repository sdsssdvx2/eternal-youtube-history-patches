package app.morphe.extension.youtube.patches.eternalhistory;

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

/**
 * Explicit, foreground-requested D1 refresh for destructive Watch Later cleanup.
 *
 * The normal Android cache pull intentionally stays disabled when watched-card visuals are off,
 * because downloading the permanent ledger merely to render no feed styling would waste work.
 * Manual Watch Later cleanup is different: the user explicitly requested a destructive operation,
 * so it must compare against the freshest central PC+Android progress even when feed mode is
 * "show". This helper refreshes only the durable SQLite ledger used by cleanup; it does not enable
 * background polling or change the watched-card cache policy.
 */
final class EternalCleanupLedgerSync {
    private static final String META_REV = "cloud_rev";
    private static final String META_PULL_AT = "last_pull_at";
    private static final int CHANGE_PAGE_LIMIT = 500;

    static Result refresh() {
        if (!EternalHistorySettings.ENABLED.get()) {
            return Result.failure("Eternal 직접 동기화가 꺼져 있습니다.");
        }
        String worker = normalizedWorkerUrl();
        String token = EternalHistorySettings.API_TOKEN.get().trim();
        if (worker.isEmpty() || token.isEmpty()) {
            return Result.failure("Eternal Worker URL 또는 연결 토큰이 설정되지 않았습니다.");
        }

        EternalHistoryDb db = EternalHistoryDb.get();
        try {
            if (db.videoCount() == 0) {
                baselineSync(db);
            } else {
                deltaSync(db, CHANGE_PAGE_LIMIT);
            }
            db.setMetaLong(META_PULL_AT, System.currentTimeMillis());
            return Result.success(db.videoCount());
        } catch (Throwable t) {
            return Result.failure(safeMessage(t));
        }
    }

    private static void baselineSync(EternalHistoryDb db) throws Exception {
        JSONObject stats = requestJson("GET", "/v1/stats", null);
        long baselineRev = stats.optLong("latestChangeRev", 0);
        String after = "";
        int pages = 0;
        for (;;) {
            JSONObject page = requestJson("GET", "/v1/videos?limit=500&after=" + enc(after), null);
            JSONArray records = page.optJSONArray("records");
            if (records == null || records.length() == 0) break;
            db.upsertVideos(records);
            pages++;
            String next = records.getJSONObject(records.length() - 1).optString("videoId", "");
            if (next.isEmpty() || next.equals(after)) {
                throw new IllegalStateException("D1 baseline cursor did not advance");
            }
            after = next;
            if (records.length() < 500) break;
            if (pages >= 2000) throw new IllegalStateException("D1 baseline page safety limit exceeded");
            Thread.yield();
        }
        db.setMetaLong(META_REV, baselineRev);
        deltaSync(db, CHANGE_PAGE_LIMIT);
    }

    private static void deltaSync(EternalHistoryDb db, int maxPages) throws Exception {
        long cursor = db.getMetaLong(META_REV, 0);
        for (int page = 0; page < maxPages; page++) {
            JSONObject result = requestJson("GET", "/v1/changes?limit=500&after=" + cursor, null);
            JSONArray records = result.optJSONArray("records");
            if (records != null && records.length() > 0) db.upsertVideos(records);

            long next = result.optLong("nextCursor", cursor);
            boolean hasMore = result.optBoolean("hasMore", false);
            if (next > cursor) {
                cursor = next;
                db.setMetaLong(META_REV, cursor);
            }
            if (!hasMore) return;
            if (next <= 0 || next <= db.getMetaLong(META_REV, 0) && records != null && records.length() == 0) {
                throw new IllegalStateException("D1 change cursor did not advance");
            }
            Thread.yield();
        }
        throw new IllegalStateException("D1 change backlog exceeds cleanup safety limit");
    }

    private static JSONObject requestJson(String method, String path, JSONObject body) throws Exception {
        URL url = new URL(normalizedWorkerUrl() + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(12000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Authorization", "Bearer " + EternalHistorySettings.API_TOKEN.get().trim());
        connection.setRequestProperty("Accept", "application/json");
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
        }
        int code = connection.getResponseCode();
        InputStream in = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        String text = readAll(in);
        connection.disconnect();
        if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code + ": " + text);
        return text.isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null;) out.append(line);
        }
        return out.toString();
    }

    private static String normalizedWorkerUrl() {
        String value = EternalHistorySettings.WORKER_URL.get().trim();
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private static String enc(String value) throws Exception {
        return URLEncoder.encode(value == null ? "" : value, "UTF-8");
    }

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return message == null || message.trim().isEmpty()
                ? (t == null ? "unknown" : t.getClass().getSimpleName())
                : message;
    }

    static final class Result {
        final boolean success;
        final long videoCount;
        final String error;

        private Result(boolean success, long videoCount, String error) {
            this.success = success;
            this.videoCount = videoCount;
            this.error = error;
        }

        static Result success(long videoCount) { return new Result(true, videoCount, null); }
        static Result failure(String error) { return new Result(false, 0, error); }
    }

    private EternalCleanupLedgerSync() { }
}
