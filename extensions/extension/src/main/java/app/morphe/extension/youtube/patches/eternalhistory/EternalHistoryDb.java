package app.morphe.extension.youtube.patches.eternalhistory;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import app.morphe.extension.shared.Utils;

/** Durable Android-side display cache + upload outbox. */
final class EternalHistoryDb extends SQLiteOpenHelper {
    private static final String DB_NAME = "eternal_youtube_history.db";
    private static final int DB_VERSION = 1;
    private static volatile EternalHistoryDb instance;

    static EternalHistoryDb get() {
        EternalHistoryDb local = instance;
        if (local != null) return local;
        synchronized (EternalHistoryDb.class) {
            if (instance == null) {
                Context context = Utils.getContext();
                if (context == null) throw new IllegalStateException("Android context is not ready");
                instance = new EternalHistoryDb(context.getApplicationContext());
            }
            return instance;
        }
    }

    private EternalHistoryDb(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS videos (" +
                "video_id TEXT PRIMARY KEY," +
                "title TEXT, channel_name TEXT, channel_id TEXT," +
                "first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL," +
                "last_precise_watched_at INTEGER, max_progress_pct REAL, updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS outbox (" +
                "outbox_key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }

    /** Uses only SQLite syntax available on old Android versions; no 3.24+ UPSERT dependency. */
    private static void upsertVideoInternal(SQLiteDatabase db, JSONObject r) {
        if (r == null) return;
        final String videoId = r.optString("videoId", "");
        if (videoId.length() != 11) return;
        final long now = System.currentTimeMillis();
        final String title = nullIfEmpty(r.optString("title", null));
        final String channelName = nullIfEmpty(r.optString("channelName", null));
        final String channelId = nullIfEmpty(r.optString("channelId", null));
        final long first = r.optLong("firstSeenAt", now);
        final long last = r.optLong("lastSeenAt", now);
        final Object precise = r.isNull("lastPreciseWatchedAt") ? null : r.optLong("lastPreciseWatchedAt");
        final Object progress = r.isNull("maxProgressPct") ? null : r.optDouble("maxProgressPct");
        final long updated = r.optLong("updatedAt", now);

        db.execSQL(
                "INSERT OR IGNORE INTO videos(video_id,title,channel_name,channel_id,first_seen_at,last_seen_at,last_precise_watched_at,max_progress_pct,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                new Object[]{videoId,title,channelName,channelId,first,last,precise,progress,updated});

        db.execSQL(
                "UPDATE videos SET " +
                "title=COALESCE(?,title)," +
                "channel_name=COALESCE(?,channel_name)," +
                "channel_id=COALESCE(?,channel_id)," +
                "first_seen_at=MIN(first_seen_at,?)," +
                "last_seen_at=MAX(last_seen_at,?)," +
                "last_precise_watched_at=CASE WHEN ? IS NULL THEN last_precise_watched_at WHEN last_precise_watched_at IS NULL THEN ? ELSE MAX(last_precise_watched_at,?) END," +
                "max_progress_pct=CASE WHEN ? IS NULL THEN max_progress_pct WHEN max_progress_pct IS NULL THEN ? ELSE MAX(max_progress_pct,?) END," +
                "updated_at=MAX(updated_at,?) WHERE video_id=?",
                new Object[]{title,channelName,channelId,first,last,precise,precise,precise,progress,progress,progress,updated,videoId});
    }

    synchronized void upsertVideo(JSONObject r) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            upsertVideoInternal(db, r);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    synchronized void upsertVideos(JSONArray rows) throws Exception {
        if (rows == null || rows.length() == 0) return;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (int i = 0; i < rows.length(); i++) upsertVideoInternal(db, rows.getJSONObject(i));
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    synchronized void enqueue(String key, String kind, JSONObject payload) {
        ContentValues v = new ContentValues();
        v.put("outbox_key", key);
        v.put("kind", kind);
        v.put("payload", payload.toString());
        v.put("created_at", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("outbox", null, v, SQLiteDatabase.CONFLICT_REPLACE);
    }

    synchronized List<OutboxItem> outbox(int limit) {
        List<OutboxItem> result = new ArrayList<>();
        try (Cursor c = getReadableDatabase().query("outbox",
                new String[]{"outbox_key","kind","payload"}, null, null, null, null,
                "created_at ASC", Integer.toString(Math.max(1, limit)))) {
            while (c.moveToNext()) result.add(new OutboxItem(c.getString(0), c.getString(1), c.getString(2)));
        }
        return result;
    }

    synchronized void deleteOutbox(List<String> keys) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (String key : keys) db.delete("outbox", "outbox_key=?", new String[]{key});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    synchronized long videoCount() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM videos", null)) {
            return c.moveToFirst() ? c.getLong(0) : 0;
        }
    }

    /** Minimal in-memory feed cache: -1 means watched with unknown progress. */
    synchronized Map<String, Float> loadProgressSnapshot() {
        Map<String, Float> out = new HashMap<>();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT video_id,max_progress_pct FROM videos", null)) {
            while (c.moveToNext()) out.put(c.getString(0), c.isNull(1) ? -1f : c.getFloat(1));
        }
        return out;
    }

    /** Titles are used only for the dim renderer bridge; loaded in one background snapshot. */
    synchronized Map<String, String> loadTitleSnapshot() {
        Map<String, String> out = new HashMap<>();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT video_id,title FROM videos WHERE title IS NOT NULL AND title <> ''", null)) {
            while (c.moveToNext()) out.put(c.getString(0), c.getString(1));
        }
        return out;
    }

    synchronized long getMetaLong(String key, long fallback) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT meta_value FROM meta WHERE meta_key=?", new String[]{key})) {
            if (!c.moveToFirst()) return fallback;
            try { return Long.parseLong(c.getString(0)); } catch (Exception ignored) { return fallback; }
        }
    }

    /** Revision/timestamp metadata is monotonic; concurrent cache refreshes must never move it back. */
    synchronized void setMetaLong(String key, long value) {
        long current = getMetaLong(key, Long.MIN_VALUE);
        if (current >= value) return;
        ContentValues v = new ContentValues();
        v.put("meta_key", key);
        v.put("meta_value", Long.toString(value));
        getWritableDatabase().insertWithOnConflict("meta", null, v, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static String nullIfEmpty(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    static final class OutboxItem {
        final String key;
        final String kind;
        final String payload;
        OutboxItem(String key, String kind, String payload) {
            this.key = key; this.kind = kind; this.payload = payload;
        }
    }
}
