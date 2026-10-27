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

import app.morphe.extension.shared.Utils;

/** App-private, crash-safe journal for the most recent manual Watch Later cleanup transaction. */
final class EternalWatchLaterTransactionStore {
    static final int SCHEMA = 2;
    static final int MAX_SNAPSHOT_ENTRIES = 5000;
    private static final int MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
    private static final String CURRENT_FILE = "eternal-watch-later-transaction-v2.json";
    private static final String PREVIOUS_FILE = "eternal-watch-later-transaction-v2.previous.json";

    /**
     * Persist an integrity-wrapped transaction, fsync it, read it back, verify SHA-256, and only
     * then return the parsed payload. Destructive code must use the returned object, not the input.
     */
    static synchronized JSONObject saveVerified(JSONObject transaction) throws Exception {
        if (transaction == null) throw new IllegalArgumentException("transaction == null");
        transaction.put("schema", SCHEMA);
        transaction.put("updatedAt", System.currentTimeMillis());
        JSONObject parsed = writeVerified(atomicFile(CURRENT_FILE), transaction);
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
        return readVerified(file);
    }

    static synchronized JSONObject loadPrevious() throws Exception {
        AtomicFile file = atomicFile(PREVIOUS_FILE);
        if (!file.getBaseFile().exists()) return null;
        return readVerified(file);
    }

    /**
     * Never overwrite an unfinished transaction. Completed/partial/undone records may be archived
     * before a new manual cleanup starts so the latest rollback evidence is never silently lost.
     */
    static synchronized void archiveCurrentIfReplaceable() throws Exception {
        JSONObject current = loadCurrent();
        if (current == null) return;
        String state = current.optString("state", "");
        if ("prepared".equals(state) || "verified".equals(state)
                || "removing".equals(state) || "undoing".equals(state)) {
            throw new IllegalStateException("완료되지 않은 이전 안전 정리가 있습니다. 먼저 마지막 정리 되돌리기를 실행하세요.");
        }
        JSONObject archived = writeVerified(atomicFile(PREVIOUS_FILE), current);
        if (!current.optString("id", "").equals(archived.optString("id", ""))) {
            throw new IllegalStateException("이전 Watch Later journal 보존 확인에 실패했습니다.");
        }
    }

    static JSONObject newTransaction(String id, int threshold, int previewPages,
                                     JSONArray snapshot, JSONArray candidates) throws Exception {
        if (id == null || id.trim().isEmpty()) throw new IllegalArgumentException("transaction id is empty");
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
        tx.put("threshold", Math.max(1, Math.min(100, threshold)));
        tx.put("previewPages", Math.max(1, previewPages));
        tx.put("snapshot", snapshot);
        tx.put("candidates", candidates == null ? new JSONArray() : candidates);
        tx.put("removedCount", 0);
        tx.put("failureCount", 0);
        tx.put("uncertainCount", 0);
        tx.put("undoRestoredCount", 0);
        tx.put("undoFailureCount", 0);
        return tx;
    }

    static void recalcCounts(JSONObject tx) {
        JSONArray candidates = tx == null ? null : tx.optJSONArray("candidates");
        int removed = 0, failures = 0, uncertain = 0, restored = 0, undoFailures = 0;
        if (candidates != null) {
            for (int i = 0; i < candidates.length(); i++) {
                JSONObject c = candidates.optJSONObject(i);
                if (c == null) continue;
                String status = c.optString("status", "prepared");
                String undo = c.optString("undoStatus", "pending");
                if ("removed".equals(status)) removed++;
                if ("failed".equals(status) || "identity_mismatch".equals(status) || "missing".equals(status)) failures++;
                if ("attempting".equals(status)) uncertain++;
                if ("restored".equals(undo) || "already_present".equals(undo)) restored++;
                if ("failed".equals(undo)) undoFailures++;
            }
        }
        try {
            tx.put("removedCount", removed);
            tx.put("failureCount", failures);
            tx.put("uncertainCount", uncertain);
            tx.put("undoRestoredCount", restored);
            tx.put("undoFailureCount", undoFailures);
        } catch (Exception ignored) { }
    }

    /** Only entries that definitely or possibly received a delete request are rollback candidates. */
    static boolean shouldRestore(JSONObject candidate) {
        if (candidate == null) return false;
        String status = candidate.optString("status", "prepared");
        return "removed".equals(status) || "attempting".equals(status) || "failed".equals(status);
    }

    static boolean hasUndoableCurrent() {
        try {
            JSONObject tx = loadCurrent();
            if (tx == null || "undone".equals(tx.optString("state", ""))) return false;
            JSONArray candidates = tx.optJSONArray("candidates");
            if (candidates == null) return false;
            for (int i = 0; i < candidates.length(); i++) {
                JSONObject c = candidates.optJSONObject(i);
                if (shouldRestore(c)) {
                    String undo = c == null ? "" : c.optString("undoStatus", "pending");
                    if (!"restored".equals(undo) && !"already_present".equals(undo)) return true;
                }
            }
            return false;
        } catch (Throwable ignored) {
            return false;
        }
    }

    static String diagnosticSummary() {
        try {
            JSONObject tx = loadCurrent();
            if (tx == null) return "안전 정리 journal=없음";
            JSONArray candidates = tx.optJSONArray("candidates");
            return "안전 정리 journal=" + tx.optString("state", "unknown")
                    + ", 대상 " + (candidates == null ? 0 : candidates.length())
                    + ", 제거 " + tx.optInt("removedCount", 0)
                    + ", 불확실 " + tx.optInt("uncertainCount", 0)
                    + ", 복구 " + tx.optInt("undoRestoredCount", 0);
        } catch (Throwable t) {
            return "안전 정리 journal=무결성 확인 실패";
        }
    }

    private static JSONObject writeVerified(AtomicFile file, JSONObject transaction) throws Exception {
        String payload = transaction.toString();
        byte[] payloadBytes = payload.getBytes(StandardCharsets.UTF_8);
        if (payloadBytes.length > MAX_JOURNAL_BYTES) {
            throw new IllegalStateException("Watch Later 안전 journal이 비정상적으로 커서 저장을 중단합니다.");
        }
        JSONObject wrapper = new JSONObject();
        wrapper.put("format", "eternal-watch-later-journal-v2");
        wrapper.put("sha256", hex(sha256(payloadBytes)));
        wrapper.put("payload", payload);
        byte[] wrapperBytes = wrapper.toString().getBytes(StandardCharsets.UTF_8);
        writeAtomic(file, wrapperBytes);
        return readVerified(file);
    }

    private static JSONObject readVerified(AtomicFile file) throws Exception {
        byte[] bytes = readAll(file);
        if (bytes.length == 0 || bytes.length > MAX_JOURNAL_BYTES + 64 * 1024) {
            throw new IllegalStateException("Watch Later 안전 journal 크기가 올바르지 않습니다.");
        }
        JSONObject wrapper = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        if (!"eternal-watch-later-journal-v2".equals(wrapper.optString("format", ""))) {
            throw new IllegalStateException("Watch Later 안전 journal 형식을 확인할 수 없습니다.");
        }
        String payload = wrapper.optString("payload", null);
        String expected = wrapper.optString("sha256", "");
        if (payload == null || !expected.equals(hex(sha256(payload.getBytes(StandardCharsets.UTF_8))))) {
            throw new IllegalStateException("Watch Later 안전 journal SHA-256 무결성 확인에 실패했습니다.");
        }
        JSONObject parsed = new JSONObject(payload);
        if (parsed.optInt("schema", 0) != SCHEMA) {
            throw new IllegalStateException("지원하지 않는 Watch Later 안전 journal schema입니다.");
        }
        if (parsed.optString("id", "").trim().isEmpty()) {
            throw new IllegalStateException("Watch Later 안전 journal ID가 없습니다.");
        }
        return parsed;
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

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(java.util.Locale.US, "%02x", b & 0xff));
        return out.toString();
    }

    private EternalWatchLaterTransactionStore() { }
}
