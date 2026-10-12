package app.morphe.extension.youtube.patches.eternalhistory;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;

import app.eternal.extension.BuildConfig;

/**
 * Signature-protected bridge used by the separately installed Eternal Updater.
 *
 * The Worker bearer token is never embedded in the updater APK. Android only allows callers signed
 * with the same certificate as the patched YouTube app to reach this provider (manifest permission).
 */
public final class EternalUpdaterConfigProvider extends ContentProvider {
    private static final String METHOD = "getUpdaterConfig";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Bundle call(String method, String arg, Bundle extras) {
        if (!METHOD.equals(method)) return super.call(method, arg, extras);

        Bundle out = new Bundle();
        if (!EternalHistorySettings.ENABLED.get()) return out;

        String workerUrl = EternalHistorySettings.WORKER_URL.get().trim();
        String apiToken = EternalHistorySettings.API_TOKEN.get().trim();
        if (workerUrl.isEmpty() || apiToken.isEmpty()) return out;

        out.putString("workerUrl", workerUrl);
        out.putString("apiToken", apiToken);
        out.putString("eternalVersion", BuildConfig.VERSION_NAME);
        return out;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
