package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import app.eternal.extension.BuildConfig;
import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;

/**
 * Very low-frequency updater for the privately distributed signed Morphe APK.
 *
 * It reads only the tiny public target-status JSON generated after the private build window. No
 * GitHub credential or signing material is stored in the app. If a newer validated target exists,
 * one dialog is shown for that exact target and the user can open the private GitHub release page.
 * Android still performs the normal user-approved package update; this class never installs APKs.
 */
final class EternalUpdateChecker {
    private static final String STATUS_URL =
            "https://raw.githubusercontent.com/sdsssdvx2/eternal-youtube-history-patches/main/android-update-status.json";
    private static final String PRIVATE_RELEASE_BASE =
            "https://github.com/sdsssdvx2/eternal-android-builds/releases/tag/";
    private static final String PREFS = "eternal_history_update_checker";
    private static final String PREF_LAST_CHECK = "last_check_ms";
    private static final String PREF_LAST_NOTIFIED = "last_notified_fingerprint";
    private static final long CHECK_INTERVAL_MS = 12L * 60L * 60L * 1000L;

    private static final AtomicBoolean scheduled = new AtomicBoolean();
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "EternalUpdateCheck");
        thread.setDaemon(true);
        return thread;
    });

    static void schedule() {
        if (!EternalHistorySettings.ENABLED.get()
                || !EternalHistorySettings.AUTO_UPDATE_CHECK.get()
                || !scheduled.compareAndSet(false, true)) return;

        IO.execute(() -> {
            try {
                checkNow();
            } catch (Throwable t) {
                Logger.printDebug(() -> "Eternal update check deferred: " + t.getMessage());
            } finally {
                scheduled.set(false);
            }
        });
    }

    private static void checkNow() throws Exception {
        Context context = Utils.getContext();
        if (context == null) return;

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long lastCheck = prefs.getLong(PREF_LAST_CHECK, 0L);
        if (lastCheck > 0L && now - lastCheck < CHECK_INTERVAL_MS) return;

        JSONObject status = fetchStatus();
        // Mark a successful check only after valid JSON arrived. Temporary network failures therefore
        // do not suppress the next app start, while normal use causes at most two tiny requests/day.
        prefs.edit().putLong(PREF_LAST_CHECK, now).apply();

        String latestEternal = status.optString("eternal_patches", "").trim();
        JSONObject youtube = status.optJSONObject("youtube");
        JSONObject music = status.optJSONObject("youtube_music");
        if (youtube == null || music == null || latestEternal.isEmpty()) return;

        String latestYoutube = youtube.optString("version", "").trim();
        String latestMusic = music.optString("version", "").trim();
        if (latestYoutube.isEmpty() || latestMusic.isEmpty()) return;

        String currentEternal = BuildConfig.VERSION_NAME;
        String currentYoutube = installedVersion(context);
        boolean eternalUpdate = compareVersions(latestEternal, currentEternal) > 0;
        boolean youtubeUpdate = compareVersions(latestYoutube, currentYoutube) > 0;
        if (!eternalUpdate && !youtubeUpdate) return;

        String fingerprint = latestEternal + "|yt:" + latestYoutube + "|music:" + latestMusic;
        if (fingerprint.equals(prefs.getString(PREF_LAST_NOTIFIED, ""))) return;

        String releaseTag = "android-" + latestYoutube + "-" + latestMusic + "-"
                + latestEternal.replaceFirst("^[vV]", "");
        String releaseUrl = PRIVATE_RELEASE_BASE + releaseTag;
        showUpdateDialog(
                prefs,
                fingerprint,
                currentEternal,
                latestEternal,
                currentYoutube,
                latestYoutube,
                releaseUrl
        );
    }

    private static JSONObject fetchStatus() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(STATUS_URL).openConnection();
        connection.setConnectTimeout(4_000);
        connection.setReadTimeout(4_000);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "Eternal-YouTube-History-Android");
        try {
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            return new JSONObject(body.toString());
        } finally {
            connection.disconnect();
        }
    }

    private static String installedVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName == null ? "0" : info.versionName;
        } catch (Throwable ignored) {
            return "0";
        }
    }

    private static void showUpdateDialog(SharedPreferences prefs,
                                         String fingerprint,
                                         String currentEternal,
                                         String latestEternal,
                                         String currentYoutube,
                                         String latestYoutube,
                                         String releaseUrl) {
        Utils.runOnMainThread(() -> {
            Activity activity = Utils.getActivity();
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;

            // Store only once we actually have an Activity and are about to show the dialog. If the
            // app started too early for an Activity, the next start is allowed to try again.
            prefs.edit().putString(PREF_LAST_NOTIFIED, fingerprint).apply();

            String message = "검증·서명된 새 Eternal YouTube 빌드가 있습니다.\n\n"
                    + "Eternal: " + currentEternal + " → " + latestEternal + "\n"
                    + "YouTube: " + currentYoutube + " → " + latestYoutube + "\n\n"
                    + "기존 앱을 삭제하지 말고 새 APK를 그대로 업데이트 설치하면 됩니다.";

            new AlertDialog.Builder(activity)
                    .setTitle("Eternal YouTube 업데이트")
                    .setMessage(message)
                    .setNegativeButton("나중에", null)
                    .setPositiveButton("업데이트 페이지 열기", (dialog, which) -> {
                        try {
                            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(releaseUrl)));
                        } catch (Throwable t) {
                            Logger.printException(() -> "Could not open Eternal update page", t);
                        }
                    })
                    .show();
        });
    }

    private static int compareVersions(String left, String right) {
        int[] a = numericVersion(left);
        int[] b = numericVersion(right);
        int length = Math.max(a.length, b.length);
        for (int i = 0; i < length; i++) {
            int av = i < a.length ? a[i] : 0;
            int bv = i < b.length ? b[i] : 0;
            if (av != bv) return Integer.compare(av, bv);
        }
        return 0;
    }

    private static int[] numericVersion(String value) {
        String normalized = value == null ? "" : value.replaceFirst("^[vV]", "");
        String[] parts = normalized.split("[^0-9]+");
        int count = 0;
        for (String part : parts) if (!part.isEmpty()) count++;
        if (count == 0) return new int[]{0};
        int[] result = new int[count];
        int index = 0;
        for (String part : parts) {
            if (part.isEmpty()) continue;
            try {
                result[index++] = Integer.parseInt(part);
            } catch (NumberFormatException ignored) {
                result[index - 1] = 0;
            }
        }
        return result;
    }

    private EternalUpdateChecker() { }
}
