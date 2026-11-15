package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Process;
import android.text.Editable;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.TextWatcher;
import android.text.style.BackgroundColorSpan;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.theme.ThemeUtils;
import app.morphe.extension.shared.ui.Dim;

/**
 * In-app comment search for the most recently played video, opened from the Eternal "E" header
 * control. Comments are fetched read-only and unauthenticated through the public InnerTube
 * {@code next} endpoint (the same request YouTube's web client makes when you scroll to the
 * comments), paced on one background thread, and searched locally. Nothing is written anywhere.
 */
final class EternalCommentSearch {
    private static final String ENDPOINT = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false";
    /** Fallback WEB client version; replaced by the live value scraped from the watch page if rejected. */
    private static final String DEFAULT_CLIENT_VERSION = "2.20251101.01.00";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
    private static final int PAGES_PER_LOAD = 100;   // ~20 comments/page
    private static final int MAX_SHOWN = 200;
    private static final long PAGE_DELAY_MS = 150L;
    private static final Pattern CLIENT_VERSION = Pattern.compile("\"INNERTUBE_CLIENT_VERSION\":\"([0-9.]+)\"");
    private static final Pattern VISITOR = Pattern.compile("\"VISITOR_DATA\":\"([^\"]+)\"");

    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> {
            try { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); } catch (Throwable ignored) { }
            r.run();
        }, "EternalCommentSearch");
        t.setDaemon(true);
        return t;
    });

    /** Loaded state for one video; touched on the IO thread, read on the UI thread via snapshots. */
    private static final class Session {
        final String videoId;
        final List<EternalCommentParser.Comment> comments = new ArrayList<>();
        final Set<String> ids = new HashSet<>();
        final AtomicBoolean cancelled = new AtomicBoolean();
        volatile boolean loading;
        volatile boolean started;
        volatile boolean done;
        volatile String next;
        volatile String totalText;
        volatile String error;
        volatile boolean disabled;
        String clientVersion = DEFAULT_CLIENT_VERSION;
        String visitorData;

        Session(String videoId) { this.videoId = videoId; }

        synchronized List<EternalCommentParser.Comment> snapshot() { return new ArrayList<>(comments); }

        synchronized void add(List<EternalCommentParser.Comment> list) {
            for (EternalCommentParser.Comment c : list) if (ids.add(c.id)) comments.add(c);
        }

        synchronized int size() { return comments.size(); }
    }

    private static Session lastSession;

    static void show(Activity activity, String videoId) {
        if (activity == null || activity.isFinishing()) return;
        if (videoId == null || videoId.length() != 11) {
            Utils.showToastShort("먼저 영상을 재생한 뒤 댓글 검색을 열어주세요.");
            return;
        }
        Session session = lastSession != null && lastSession.videoId.equals(videoId) && lastSession.error == null
                ? lastSession : new Session(videoId);
        if (lastSession != null && lastSession != session) lastSession.cancelled.set(true);
        session.cancelled.set(false);
        lastSession = session;

        int fg = ThemeUtils.getAppForegroundColor();
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Dim.dp16, Dim.dp8, Dim.dp16, 0);

        String title = EternalHistoryClient.cachedTitle(videoId);
        TextView heading = label(activity, title == null ? "최근 재생 영상 (" + videoId + ")" : title, 13, true, fg);
        heading.setMaxLines(2);
        box.addView(heading);

        EditText input = new EditText(activity);
        input.setSingleLine(true);
        input.setHint("댓글 검색 (여러 단어 = 모두 포함, \"따옴표\" = 구문)");
        input.setTextColor(fg);
        box.addView(input);

        TextView status = label(activity, "", 12, false, fg);
        status.setAlpha(0.75f);
        box.addView(status);

        Button more = new Button(activity);
        box.addView(more);

        LinearLayout results = new LinearLayout(activity);
        results.setOrientation(LinearLayout.VERTICAL);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(results);
        box.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Dim.dp(360)));

        Runnable repaint = () -> paint(activity, session, input.getText().toString(), status, more, results, fg);
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { repaint.run(); }
        });
        more.setOnClickListener(v -> {
            if (session.loading) session.cancelled.set(true);
            else if (!session.done) startLoading(activity, session, repaint);
        });

        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("댓글 검색")
                .setView(box)
                .setNegativeButton("닫기", null)
                .create();
        dialog.setOnDismissListener(d -> session.cancelled.set(true));
        dialog.show();
        repaint.run();
        if (!session.started) startLoading(activity, session, repaint);
    }

    private static void startLoading(Activity activity, Session session, Runnable repaint) {
        if (session.loading) return;
        session.loading = true;
        session.started = true;
        session.cancelled.set(false);
        session.error = null;
        activity.runOnUiThread(repaint);
        IO.execute(() -> {
            try {
                int pages = 0;
                if (session.next == null && !session.done) {
                    String token = initialToken(session);
                    if (token == null) {
                        session.disabled = true;
                        session.done = true;
                        return;
                    }
                    session.next = token;
                }
                while (!session.cancelled.get() && session.next != null && pages < PAGES_PER_LOAD) {
                    EternalCommentParser.Page page = EternalCommentParser.parsePage(post(session, continuationBody(session, session.next)), false);
                    pages++;
                    if (page.visitorData != null && session.visitorData == null) session.visitorData = page.visitorData;
                    if (page.totalText != null) session.totalText = page.totalText;
                    session.add(page.comments);
                    session.next = page.next;
                    if (page.next == null) session.done = true;
                    activity.runOnUiThread(repaint);
                    Thread.sleep(PAGE_DELAY_MS);
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            } catch (Throwable t) {
                session.error = safeMessage(t);
                Logger.printDebug(() -> "Eternal comment search failed: " + safeMessage(t));
            } finally {
                session.loading = false;
                activity.runOnUiThread(repaint);
            }
        });
    }

    private static String initialToken(Session session) throws Exception {
        JSONObject body = new JSONObject().put("context", context(session)).put("videoId", session.videoId)
                .put("racyCheckOk", true).put("contentCheckOk", true);
        JSONObject json;
        try {
            json = post(session, body);
        } catch (Exception first) {
            // A stale fallback client version can be rejected; adopt the live one and retry once.
            if (!refreshClientFromWatchPage(session)) throw first;
            body.put("context", context(session));
            json = post(session, body);
        }
        JSONObject ctx = json.optJSONObject("responseContext");
        if (ctx != null && session.visitorData == null && !ctx.optString("visitorData", "").isEmpty()) {
            session.visitorData = ctx.optString("visitorData");
        }
        String token = EternalCommentParser.initialCommentsToken(json);
        if (token == null && refreshClientFromWatchPage(session)) {
            body.put("context", context(session));
            token = EternalCommentParser.initialCommentsToken(post(session, body));
        }
        return token;
    }

    private static boolean refreshClientFromWatchPage(Session session) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("https://www.youtube.com/watch?v=" + session.videoId + "&hl=ko").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setRequestProperty("User-Agent", USER_AGENT);
            c.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9");
            try {
                if (c.getResponseCode() != 200) return false;
                String html = readAll(c.getInputStream(), 3_000_000);
                Matcher v = CLIENT_VERSION.matcher(html);
                boolean changed = false;
                if (v.find() && !v.group(1).equals(session.clientVersion)) { session.clientVersion = v.group(1); changed = true; }
                Matcher vd = VISITOR.matcher(html);
                if (vd.find()) { session.visitorData = vd.group(1); changed = true; }
                return changed;
            } finally {
                c.disconnect();
            }
        } catch (Throwable t) {
            return false;
        }
    }

    private static JSONObject context(Session session) throws Exception {
        JSONObject client = new JSONObject()
                .put("clientName", "WEB")
                .put("clientVersion", session.clientVersion)
                .put("hl", Locale.getDefault().getLanguage().isEmpty() ? "ko" : Locale.getDefault().getLanguage())
                .put("gl", Locale.getDefault().getCountry().isEmpty() ? "KR" : Locale.getDefault().getCountry());
        if (session.visitorData != null) client.put("visitorData", session.visitorData);
        return new JSONObject().put("client", client);
    }

    private static JSONObject continuationBody(Session session, String token) throws Exception {
        return new JSONObject().put("context", context(session)).put("continuation", token);
    }

    private static JSONObject post(Session session, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(ENDPOINT).openConnection();
        try {
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setRequestProperty("User-Agent", USER_AGENT);
            c.setRequestProperty("X-Youtube-Client-Name", "1");
            c.setRequestProperty("X-Youtube-Client-Version", session.clientVersion);
            c.setRequestProperty("Origin", "https://www.youtube.com");
            if (session.visitorData != null) c.setRequestProperty("X-Goog-Visitor-Id", session.visitorData);
            try (OutputStream out = c.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new IllegalStateException("YouTube HTTP " + code);
            return new JSONObject(readAll(c.getInputStream(), 8_000_000));
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in, int maxChars) throws Exception {
        if (in == null) return "";
        StringBuilder b = new StringBuilder();
        char[] buf = new char[8192];
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (int n; (n = r.read(buf)) > 0;) {
                b.append(buf, 0, n);
                if (b.length() > maxChars) break;
            }
        }
        return b.toString();
    }

    // ---------------- UI ----------------

    private static void paint(Activity activity, Session session, String query, TextView status,
                              Button more, LinearLayout results, int fg) {
        if (activity.isFinishing()) return;
        StringBuilder line = new StringBuilder("불러온 댓글 ").append(String.format(Locale.ROOT, "%,d", session.size())).append("개");
        if (session.totalText != null) line.append(" / ").append(session.totalText);
        if (session.loading) line.append(" · 불러오는 중…");
        else if (session.disabled) line.setLength(0);
        if (session.disabled) line.append("이 영상은 댓글이 꺼져 있거나 불러올 수 없습니다.");
        else if (session.done && !session.loading) line.append(" · 전부 불러옴");
        if (session.error != null) line.append(" · 오류: ").append(session.error);
        status.setText(line);

        more.setVisibility(session.done && !session.loading ? View.GONE : View.VISIBLE);
        more.setText(session.loading ? "중지" : "더 불러오기");

        results.removeAllViews();
        String q = query == null ? "" : query.trim();
        if (q.isEmpty()) {
            results.addView(label(activity, "검색어를 입력하면 불러온 댓글에서 바로 찾습니다. 결과를 누르면 YouTube에서 해당 댓글을 열고, 길게 누르면 복사합니다.", 12, false, fg));
            return;
        }
        List<EternalCommentParser.Comment> matches = EternalCommentParser.search(session.snapshot(), q, MAX_SHOWN);
        results.addView(label(activity, (matches.size() >= MAX_SHOWN ? MAX_SHOWN + "+" : String.valueOf(matches.size())) + "개 일치", 12, true, fg));
        List<String> terms = EternalCommentParser.queryTerms(q);
        for (EternalCommentParser.Comment c : matches) {
            LinearLayout row = new LinearLayout(activity);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(0, Dim.dp8, 0, Dim.dp8);
            String meta = (c.author.isEmpty() ? "(이름 없음)" : c.author)
                    + (c.published.isEmpty() ? "" : " · " + c.published)
                    + (c.likes.isEmpty() ? "" : " · 좋아요 " + c.likes)
                    + (c.isReply ? " · 답글" : "");
            TextView metaView = label(activity, meta, 12, false, fg);
            metaView.setAlpha(0.72f);
            TextView body = new TextView(activity);
            body.setTextSize(14);
            body.setTextColor(fg);
            body.setText(highlight(c.text, terms));
            row.addView(metaView);
            row.addView(body);
            row.setClickable(true);
            row.setOnClickListener(v -> openComment(activity, session.videoId, c.id));
            row.setOnLongClickListener(v -> { copy(activity, c.text); return true; });
            results.addView(row);
        }
    }

    private static CharSequence highlight(String text, List<String> terms) {
        String lower = EternalCommentParser.norm(text);
        if (lower.length() != text.length() || terms.isEmpty()) return text;
        SpannableString span = new SpannableString(text);
        for (String t : terms) {
            int from = 0;
            for (int guard = 0; guard < 100; guard++) {
                int i = lower.indexOf(t, from);
                if (i < 0) break;
                span.setSpan(new BackgroundColorSpan(0x66FFD54A), i, i + t.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                from = i + t.length();
            }
        }
        return span;
    }

    private static void openComment(Activity activity, String videoId, String commentId) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW,
                    Uri.parse("https://www.youtube.com/watch?v=" + videoId + "&lc=" + Uri.encode(commentId)));
            intent.setPackage(activity.getPackageName());
            activity.startActivity(intent);
        } catch (Throwable t) {
            copy(activity, "https://www.youtube.com/watch?v=" + videoId + "&lc=" + commentId);
        }
    }

    private static void copy(Activity activity, String text) {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("YouTube comment", text));
                Utils.showToastShort("복사했습니다.");
            }
        } catch (Throwable ignored) { }
    }

    private static TextView label(Activity activity, String text, int sp, boolean bold, int color) {
        TextView v = new TextView(activity);
        v.setText(text);
        v.setTextSize(sp);
        v.setTextColor(color);
        if (bold) v.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return v;
    }

    private static String safeMessage(Throwable t) {
        String m = t == null ? null : t.getMessage();
        return m == null ? (t == null ? "unknown" : t.getClass().getSimpleName()) : m;
    }

    private EternalCommentSearch() { }
}
