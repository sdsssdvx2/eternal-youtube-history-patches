package app.morphe.extension.youtube.patches.eternalhistory;

import android.content.Context;
import android.content.SharedPreferences;

import app.morphe.extension.shared.Utils;

/** One-time state migration for the modern Watch Later payload parser. */
final class EternalWatchLaterStateMigration {
    private static final String PREFS = "eternal_history_watch_later_auto";
    private static final String PREF_PARSER_STATE_VERSION = "parser_state_version";
    private static final String PREF_LAST_ATTEMPT = "last_attempt_ms";
    private static final String PREF_LAST_SUCCESS = "last_success_ms";
    private static final int CURRENT_PARSER_STATE_VERSION = 2;

    static void migrate() {
        Context context = Utils.getContext();
        if (context == null) return;
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int version = p.getInt(PREF_PARSER_STATE_VERSION, 0);
        if (version >= CURRENT_PARSER_STATE_VERSION) return;

        // v1.9.1 could save a six-hour success after parsing zero rows from a newer lockup payload.
        // Clear only sweep throttling metadata. User opt-in, threshold, YouTube data and the central
        // Eternal ledger are untouched. The normal scheduler can then perform one fresh safe sweep.
        p.edit()
                .remove(PREF_LAST_ATTEMPT)
                .remove(PREF_LAST_SUCCESS)
                .putInt(PREF_PARSER_STATE_VERSION, CURRENT_PARSER_STATE_VERSION)
                .apply();
    }

    private EternalWatchLaterStateMigration() { }
}
