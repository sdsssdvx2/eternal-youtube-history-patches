package app.morphe.extension.youtube.patches.eternalhistory;

import android.content.Context;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

import app.morphe.extension.shared.Utils;

/** App-private, crash-safe journal for the most recent Watch Later cleanup transaction. */
final class EternalWatchLaterTransactionStore {
    static final int SCHEMA = 1;
    static final int MAX_SNAPSHOT_ENTRIES = 5000;
    private static final String CURRENT_FILE = "eternal-watch-later-transaction-v1.json";
    private static final String PREVIOUS_FILE = "eternal-watch-later-transaction-v1.previous.json";

    static synchronized JSONObject saveVerified(JSONObject transaction) throws Exception {
        if (transaction == null) throw new IllegalArgumentException("transaction == null");
        transaction.put("schema", SCHEMA);
        transaction.put("updatedAt", System.currentTimeMillis());
        byte[] bytes = transaction.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 4 * 1024 * 1024) {
            throw new IllegalStateException("Watch Later 안전 journal이 비정상적으로 커서 저장을 중단합니다.");
        }
        AtomicFile file = atomicFile(CURRENT_FILE);
        writeAtomic(file, bytes);
        byte[] readBack = readAll(file);
        if (!Arrays.equals(sha256(bytes), sha256(readBack)) || !Arrays.equals(bytes, readBack)) {
            throw new IllegalStateException("Watch Later 안전 journal 저장 후 무결성 확인에 실패했습니다.");
        }
        JSONObject parsed = new JSONObject(new String(readBack, StandardCharsets.UTF_8));
        if (!transaction.optString("id", "").equals(parsed.optString("id", ""))) {
            throw new IllegalStateException("Watch Later 안전 journal ID 확인에 실패했습니다.");
        }
        if (parsed.optInt("schema", 0) != SCHEMA) {
            throw new IllegalStateException("Watch Later 안전 journal schema 확인에 실패했습니다.");
        }
        return parsed;
    }

    static synchronized JSONObject loadCurrent() throws Exception {
        AtomicFile file = atomicFile(CURRENT_FILE);
        if (!file.getBaseFile().exists()) return null;
        return new JSONObject(new String(readAll(file), StandardCharsets.UTF_8));
    }

    static synchronized JSONObject loadPrevious() throws Exception {
        AtomicFile file = atomicFile(PREVIOUS_FILE);
        if (!file.getBaseFile().exists()) return null;
        return new JSONObject(new String(readAll(file), StandardCharsets.UTF_8));
    }

    static synchronized void archiveCurrentIfReplaceable() throws Exception {
        JSONObject current = loadCurrent();
        if (current == null) return;
        String state = current.optString("state", "");
        if ("prepared".equals(state) || "removing".equals(state) || "undoing".equals(state)) {
            throw new IllegalStateException("완료되지 않은 이전 안전 정리가 있습니다. 먼저 마지막 정리 되돌리기를 실행하세요.");
        }
        byte[] bytes = current.toString().getBytes(StandardCharsets.UTF_8);
        AtomicFile previous = atomicFile(PREVIOUS_FILE);
        writeAtomic(previous, bytes);
        byte[] readBack = readAll(previous);
        if (!Arrays.equals(bytes, readBack)) {
            throw new IllegalStateException("이전 Watch Later journal 보존 확인에 실패했습니다.");
        }
    }

    static JSONObject newTransaction(String id, int threshold, int pages,
                                     JSONArray snapshot, JSONArray candidates) throws Exception {
        if (snapshot == null || snapshot.length() == 0) {
            throw new IllegalStateException("Watch Later 전체 스냅샷이 비어 있어 정리를 중단합니다.");
        }
        if (snapshot.length() > MAX_SNAPSHOT_ENTRIES) {
            throw new IllegalStateException("Watch Later 항목이 안전 한도 " + MAX_SNAPSHOT_ENTRIES + "개를 초과합니다.");
        }
        JSONObject tx = new JSONObject();
        tx.put("schema", SCHEMA);
        tx.put("id", id);
        tx.put("createdAt", System.currentTimeMillis());
        tx.put("updatedAt", System.currentTimeMillis());
        tx.put("state", "prepared");
        tx.put("threshold", threshold);
        tx.put("pages", pages);
        tx.put("snapshot", snapshot);
        tx.put("candidates", candidates == null ? new JSONArray() : candidates);
        tx.put("removedCount", 0);
        tx.put("failureCount", 0);
        tx.put("undoRestoredCount", 0);
        tx.put("undoFailureCount", 0);
        return tx;
    }

    static void recalcCounts(JSONObject tx) {
        JSONArray candidates = tx.optJSONArray("candidates");
        int removed = 0, failures = 0, restored = 0, undoFailures = 0;
        if (candidates != null) {
            for (int i = 0; i < candidates.length(); i++) {
                JSONObject c = candidates.optJSONObject(i);
                if (c == null) continue;
                String status = c.optString("status", "");
                String undo = c.optString("undoStatus", "");
                if ("removed".equals(status)) removed++;
                if ("failed".equals(status) || "identity_mismatch".equals(status) || "missing".equals(status)) failures++;
                if ("restored".equals(undo) || "already_present".equals(undo)) restored++;
                if ("failed".equals(undo)) undoFailures++;
            }
        }
        try {
            tx.put("removedCount", removed);
            tx.put("failureCount", failures);
            tx.put("undoRestoredCount", restored);
            tx.put("undoFailureCount", undoFailures);
        } catch (Exception ignored) { }
    }

    static boolean hasUndoableCurrent() {
        try {
            JSONObject tx = loadCurrent();
            if (tx == null) return false;
            JSONArray candidates = tx.optJSONArray("candidates");
            return candidates != null && candidates.length() > 0 && !"undone".equals(tx.optString("state", ""));
        } catch (Throwable ignored) {
            return false;
        }
    }

    static String diagnosticSummary() {
        try {
            JSONObject tx = loadCurrent();
            if (tx == null) return "안전 정리 journal=없음";
            return "안전 정리 journal=" + tx.optString("state", "unknown")
                    + ", 대상 " + (tx.optJSONArray("candidates") == null ? 0 : tx.optJSONArray("candidates").length())
                    + ", 제거 " + tx.optInt("removedCount", 0)
                    + ", 복구 " + tx.optInt("undoRestoredCount", 0);
        } catch (Throwable t) {
            return "안전 정리 journal=읽기 실패";
        }
    }

    private static AtomicFile atomicFile(String name) {
        Context context = Utils.getContext();
        if (context == null) throw new IllegalStateException("Android Context를 가져올 수 없습니다.");
        File dir = new File(context.getFilesDir(), "eternal-history");
        if (!dir.exists() && !dir.mkdirs() && !dir.exists()) {
            throw new IllegalStateException("Eternal 안전 journal 디렉터리를 만들 수 없습니다.");
        }
        return new AtomicFile(new File(dir, name));
    }

    private static void writeAtomic(AtomicFile file, byte[] bytes) throws Exception {
        FileOutputStream out = null;
        try {
            out = file.startWrite();
            out.write(bytes);
            out.flush();
            out.getFD().sync();
            file.finishWrite(out);
            out = null;
        } catch (Throwable t) {
            if (out != null) file.failWrite(out);
            if (t instanceof Exception e) throw e;
            throw new IllegalStateException(t);
        }
    }

    private static byte[] readAll(AtomicFile file) throws Exception {
        try (FileInputStream in = file.openRead(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int n;
            while ((n = in.read(buffer)) >= 0) {
                if (n > 0) out.write(buffer, 0, n);
            }
            return out.toByteArray();
        }
    }

    private static byte[] sha256(byte[] bytes) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(bytes);
    }

    private EternalWatchLaterTransactionStore() { }
}
