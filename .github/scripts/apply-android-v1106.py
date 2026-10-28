from pathlib import Path


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {n}')
    return text.replace(old, new, 1)

base = Path('extensions/extension/src/main/java/app/morphe/extension/youtube/patches/eternalhistory')

# 1) Startup: preserve the crash quarantine, but mount the independent Eternal control and stop
# force-resetting the user's safe automatic-cleanup preference.
p = base / 'EternalHistoryAddOn.java'
s = read(p)
s = once(s, '''        if (EternalWatchLaterSafety.isLocked()) {
            // Preserve the user's preference value for future migration, but disable every runtime
            // entry point that could delete from Watch Later. refreshSchedule() also cancels any
            // periodic JobScheduler job left behind by an older installed build.
            EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(false);
        }

''', '', 'addon forced cleanup lock')
s = once(s, '''            EternalWatchLaterJobService.refreshSchedule();
        });''', '''            EternalWatchLaterJobService.refreshSchedule();
            EternalHistoryToolbar.ensureControlSoon();
        });''', 'addon video start mount')
s = once(s, '''        EternalWatchLaterStateMigration.migrate();
        EternalWatchLaterJobService.refreshSchedule();
    }
''', '''        EternalWatchLaterStateMigration.migrate();
        EternalWatchLaterJobService.refreshSchedule();
        // Independent root control only. Do not re-enable YouTube navigation/browse/toolbar hooks.
        EternalHistoryToolbar.ensureControlSoon();
    }
''', 'addon initial mount')
write(p, s)

# 2) Header control: keep the independent parent, but constrain it to the masthead band so it never
# floats over feed/player content. Simplify quick settings to two modes + one threshold.
p = base / 'EternalHistoryToolbar.java'
s = read(p)
s = once(s, '/** Compact Eternal overlay with live page-scoped settings. */',
'''/** Compact Eternal header-band control with live page-scoped settings. */''', 'toolbar class doc')
s = once(s,
'''        control.setX(Math.max(Dim.dp8, root.getWidth() - control.getWidth() - Dim.dp10));
        control.setY(topInset + Dim.dp(56));''',
'''        // Stay inside YouTube's top masthead band. Leave the native right-side action icons alone
        // and never float over the first feed row/player as the old +56dp position did.
        int rightGap = Dim.dp(156);
        int x = root.getWidth() - control.getWidth() - rightGap;
        control.setX(Math.max(Dim.dp(96), x));
        control.setY(topInset + Dim.dp8);''', 'toolbar masthead position')
s = once(s,
'''        TextView note = text(activity,
                inherited
                        ? "현재 공통 기본값을 사용 중입니다. 값을 바꾸면 이 페이지의 개별 설정으로 즉시 저장됩니다.\n흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다."
                        : "이 페이지의 개별 설정입니다. 변경 내용은 화면에 즉시 반영됩니다.\n흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다.",
                13, false);''',
'''        TextView note = text(activity,
                inherited
                        ? "공통 기본값 사용 중 · 바꾸면 이 페이지에만 저장됩니다."
                        : "이 페이지 전용 설정 · 숨김이 흐림보다 우선합니다.",
                13, false);''', 'toolbar concise note')
old = '''        CheckBox dim = check(activity, "흐리게 표시", profile.dimEnabled);
        CheckBox hide = check(activity, "숨기기", profile.hideEnabled);
        CheckBox linked = check(activity, "흐림/숨김 진행률 기준 같이 사용", profile.linkedThresholds);
        box.addView(dim);
        box.addView(hide);
        box.addView(linked);

        ThresholdRow shared = threshold(activity, "공통 최소 진행률", profile.sharedThreshold);
        ThresholdRow dimThreshold = threshold(activity, "흐림 최소 진행률", profile.dimThreshold);
        ThresholdRow hideThreshold = threshold(activity, "숨김 최소 진행률", profile.hideThreshold);
        box.addView(shared.root);
        box.addView(dimThreshold.root);
        box.addView(hideThreshold.root);

        Runnable refreshThresholdRows = () -> {
            shared.root.setVisibility(linked.isChecked() ? View.VISIBLE : View.GONE);
            dimThreshold.root.setVisibility(linked.isChecked() ? View.GONE : View.VISIBLE);
            hideThreshold.root.setVisibility(linked.isChecked() ? View.GONE : View.VISIBLE);
        };
        Runnable persistVisuals = () -> {
            EternalSurfaceSettings.save(
                    surface,
                    dim.isChecked(),
                    hide.isChecked(),
                    linked.isChecked(),
                    shared.seek.getProgress(),
                    dimThreshold.seek.getProgress(),
                    hideThreshold.seek.getProgress());
            if (dim.isChecked() || hide.isChecked()) EternalHistoryClient.ensureFeedCacheStarted();
            refreshControl();
            schedulePresentationRefresh();
        };
        dim.setOnCheckedChangeListener((button, checked) -> persistVisuals.run());
        hide.setOnCheckedChangeListener((button, checked) -> persistVisuals.run());
        linked.setOnCheckedChangeListener((button, checked) -> {
            refreshThresholdRows.run();
            persistVisuals.run();
        });
        shared.onUserChange = persistVisuals;
        dimThreshold.onUserChange = persistVisuals;
        hideThreshold.onUserChange = persistVisuals;
        refreshThresholdRows.run();
'''
new = '''        CheckBox dim = check(activity, "흐리게 표시", profile.dimEnabled);
        CheckBox hide = check(activity, "숨기기", profile.hideEnabled);
        box.addView(dim);
        box.addView(hide);

        int initialThreshold = profile.linkedThresholds
                ? profile.sharedThreshold
                : Math.max(profile.effectiveDimThreshold(), profile.effectiveHideThreshold());
        ThresholdRow shared = threshold(activity, "최소 진행률", initialThreshold);
        box.addView(shared.root);

        Runnable persistVisuals = () -> {
            // The compact UI intentionally uses one shared threshold. Existing separate thresholds
            // remain stored and are not deleted; they are simply no longer needed in the quick UI.
            EternalSurfaceSettings.save(
                    surface,
                    dim.isChecked(),
                    hide.isChecked(),
                    true,
                    shared.seek.getProgress(),
                    profile.dimThreshold,
                    profile.hideThreshold);
            if (dim.isChecked() || hide.isChecked()) EternalHistoryClient.ensureFeedCacheStarted();
            refreshControl();
            schedulePresentationRefresh();
        };
        dim.setOnCheckedChangeListener((button, checked) -> persistVisuals.run());
        hide.setOnCheckedChangeListener((button, checked) -> persistVisuals.run());
        shared.onUserChange = persistVisuals;
'''
s = once(s, old, new, 'toolbar compact visual controls')
s = once(s, 'autoCleanup = check(activity, "기준 이상 시 자동 정리", EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get());',
             'autoCleanup = check(activity, "자동 정리", EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get());', 'toolbar cleanup label')
s = once(s, 'cleanupThreshold = threshold(activity, "자동/수동 정리 기준", EternalHistorySettings.watchLaterCleanupProgressPercent());',
             'cleanupThreshold = threshold(activity, "정리 기준", EternalHistorySettings.watchLaterCleanupProgressPercent());', 'toolbar cleanup threshold label')
s = once(s, 'cleanNow.setText("지금 나중에 볼 동영상 정리…");', 'cleanNow.setText("지금 정리…");', 'toolbar cleanup button')
write(p, s)

# 3) Safe cleaner: expose an automatic entry point that reuses the exact durable transaction path.
p = base / 'EternalWatchLaterSafeCleaner.java'
s = read(p)
s = once(s,
'''/**
 * Manual-only fail-closed Watch Later cleanup. Legacy and automatic deletion stay locked.
 */''',
'''/**
 * Fail-closed Watch Later cleanup. Manual and opt-in automatic runs share one durable transaction path.
 */''', 'safe cleaner doc')
insert_after = '''    private static volatile String lastStatus = "아직 실행하지 않음";
'''
auto_method = '''    private static volatile String lastStatus = "아직 실행하지 않음";

    static void runAutomaticCleanup(Runnable completion) {
        if (!EternalHistorySettings.ENABLED.get()
                || !EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get()) {
            complete(completion);
            return;
        }
        if (!running.compareAndSet(false, true)) {
            complete(completion);
            return;
        }
        IO.execute(() -> {
            boolean handedToTransaction = false;
            try {
                EternalCleanupLedgerSync.Result sync = EternalCleanupLedgerSync.refresh();
                if (!sync.success) {
                    throw new IllegalStateException("중앙 기록 동기화 실패: " + sync.error);
                }
                ensureSignedIn();
                ListResult preview = listWatchLaterStrict(MAX_PAGES);
                if (preview.entries.isEmpty()) {
                    throw new IllegalStateException("Watch Later 항목이 0개로 파싱되어 빈 목록인지 확인할 수 없으므로 삭제하지 않습니다.");
                }
                Map<String, Float> progress = EternalHistoryDb.get().loadProgressSnapshot();
                int threshold = cleanupThreshold();
                JSONObject tx = EternalWatchLaterTransactionStore.newTransaction(
                        "androidwl:auto:" + UUID.randomUUID(), threshold, preview.pages,
                        snapshotJson(preview.entries), candidatesJson(preview.entries, progress, threshold));
                JSONArray candidates = tx.optJSONArray("candidates");
                int count = candidates == null ? 0 : candidates.length();
                if (count == 0) {
                    lastStatus = "자동 정리: " + threshold + "% 이상 대상 없음";
                    return;
                }
                lastStatus = "자동 안전 정리 준비: " + preview.entries.size() + "개 중 " + count + "개 대상";
                handedToTransaction = true;
                executeCleanup(null, tx);
            } catch (Throwable t) {
                lastStatus = "자동 안전 정리 중단: " + safeMessage(t);
                Logger.printDebug(() -> lastStatus);
            } finally {
                if (!handedToTransaction) running.set(false);
                complete(completion);
            }
        });
    }
'''
s = once(s, insert_after, auto_method, 'safe cleaner auto method')
s = once(s,
'''            activity.runOnUiThread(() -> Utils.showToastShort("확인 후 Watch Later 전체 목록을 다시 검증합니다…"));''',
'''            postToastShort(activity, "Watch Later 전체 목록을 다시 검증합니다…");''', 'safe cleaner reread toast')
s = once(s,
'''                activity.runOnUiThread(() -> Utils.showToastShort(index + "/" + total + " 삭제 직전 식별자 확인…"));''',
'''                postToastShort(activity, index + "/" + total + " 삭제 직전 식별자 확인…");''', 'safe cleaner item toast')
s = once(s,
'''            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));''',
'''            postToastLong(activity, lastStatus);''', 'safe cleaner success toast')
s = once(s,
'''            activity.runOnUiThread(() -> Utils.showToastLong(lastStatus));
        } finally {
            running.set(false);
        }
    }

    private static JSONObject persistResult''',
'''            postToastLong(activity, lastStatus);
        } finally {
            running.set(false);
        }
    }

    private static void postToastShort(Activity activity, String message) {
        if (activity == null) {
            Logger.printDebug(() -> "Eternal Watch Later: " + message);
            return;
        }
        activity.runOnUiThread(() -> Utils.showToastShort(message));
    }

    private static void postToastLong(Activity activity, String message) {
        if (activity == null) {
            Logger.printDebug(() -> "Eternal Watch Later: " + message);
            return;
        }
        activity.runOnUiThread(() -> Utils.showToastLong(message));
    }

    private static void complete(Runnable completion) {
        if (completion == null) return;
        try { completion.run(); } catch (Throwable ignored) { }
    }

    private static JSONObject persistResult''', 'safe cleaner toast helpers')
s = once(s, 'return "수동 안전 정리=" + (running.get() ? "진행 중" : lastStatus)',
             'return "안전 정리=" + (running.get() ? "진행 중" : lastStatus)', 'safe cleaner diagnostic label')
write(p, s)

# 4) JobService uses only the journaled safe cleaner. DESTRUCTIVE_CLEANUP_LOCKED remains as a
# permanent boundary for legacy direct mutation paths, not for this verified transaction path.
p = base / 'EternalWatchLaterJobService.java'
write(p, '''package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;

/** Opt-in low-frequency device-side Watch Later maintenance through the safe transaction path. */
@SuppressWarnings("unused")
public final class EternalWatchLaterJobService extends JobService {
    static final int JOB_ID = 0x45594857;
    private static final long PERIOD_MS = 6L * 60L * 60L * 1000L;
    private static final AtomicBoolean running = new AtomicBoolean();
    private static volatile Boolean scheduledEnabled;

    static synchronized void refreshSchedule() {
        Context context = Utils.getContext();
        if (context == null) return;
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;

        boolean enabled = EternalHistorySettings.ENABLED.get()
                && EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get();
        if (scheduledEnabled != null && scheduledEnabled == enabled) return;

        if (!enabled) {
            scheduler.cancel(JOB_ID);
            scheduledEnabled = Boolean.FALSE;
            return;
        }
        try {
            JobInfo info = new JobInfo.Builder(
                    JOB_ID,
                    new ComponentName(context, EternalWatchLaterJobService.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(PERIOD_MS)
                    .build();
            int result = scheduler.schedule(info);
            if (result == JobScheduler.RESULT_SUCCESS) {
                scheduledEnabled = Boolean.TRUE;
                EternalWatchLaterSafeCleaner.runAutomaticCleanup(null);
            } else {
                scheduledEnabled = null;
                Logger.printDebug(() -> "Eternal Watch Later JobScheduler rejected the periodic job");
            }
        } catch (Throwable t) {
            scheduledEnabled = null;
            Logger.printDebug(() -> "Eternal Watch Later job scheduling deferred: " + t.getMessage());
        }
    }

    static void runNow() {
        EternalWatchLaterSafeCleaner.runAutomaticCleanup(null);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        if (!EternalHistorySettings.ENABLED.get()
                || !EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get()) return false;
        if (!running.compareAndSet(false, true)) return false;
        EternalWatchLaterSafeCleaner.runAutomaticCleanup(() -> {
            running.set(false);
            jobFinished(params, false);
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        running.set(false);
        return true;
    }
}
''')

# 5) Manual coordinator no longer turns off the user's automatic preference.
p = base / 'EternalCleanupCoordinator.java'
s = read(p)
s = once(s,
'''        // v1.10.3's emergency boundary remains intact for every legacy/automatic destructive path.
        // Manual cleanup may proceed only through EternalWatchLaterSafeCleaner below.
        EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(false);
        EternalWatchLaterJobService.refreshSchedule();

''',
'''        // Legacy direct deletion remains locked. Manual cleanup and opt-in automatic cleanup both
        // use EternalWatchLaterSafeCleaner, so opening this dialog must not overwrite the preference.

''', 'coordinator forced auto off')
s = once(s,
'''                + "\n기존/자동 삭제 경로=" + (EternalWatchLaterSafety.isLocked() ? "안전 잠금 유지" : "열림")''',
'''                + "\n기존 직접 삭제 경로=" + (EternalWatchLaterSafety.isLocked() ? "잠금 유지" : "열림")''', 'coordinator diagnostic')
write(p, s)

# 6) Settings: keep basic controls on the first screen; move uncommon tuning into a nested Advanced
# screen. No setting key is deleted, so existing values survive the UI reorganization.
p = Path('patches/src/main/resources/addresources/youtube/addon_prefs.xml')
write(p, '''<?xml version="1.0" encoding="utf-8"?>
<morphe-add-on-preferences xmlns:android="http://schemas.android.com/apk/res/android">
  <screen key="morphe_settings_screen_12_video">
    <PreferenceScreen android:key="morphe_eternal_history_screen_sort_by_key" android:title="@string/morphe_eternal_history_screen_title" android:summary="@string/morphe_eternal_history_screen_summary">
      <SwitchPreference android:key="morphe_eternal_history_enabled" android:title="@string/morphe_eternal_history_enabled_title" />
      <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_worker_url" android:title="@string/morphe_eternal_history_worker_url_title" android:inputType="textUri" />
      <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_api_token" android:title="@string/morphe_eternal_history_api_token_title" android:inputType="textPassword" />

      <Preference android:key="morphe_eternal_history_default_profile_note" android:title="@string/morphe_eternal_history_default_profile_title" android:summary="@string/morphe_eternal_history_default_profile_summary" android:selectable="false" />
      <SwitchPreference android:key="morphe_eternal_history_default_dim_enabled" android:title="@string/morphe_eternal_history_default_dim_enabled_title" />
      <SwitchPreference android:key="morphe_eternal_history_default_hide_enabled" android:title="@string/morphe_eternal_history_default_hide_enabled_title" />
      <SwitchPreference android:key="morphe_eternal_history_default_linked_thresholds" android:title="@string/morphe_eternal_history_default_linked_thresholds_title" />
      <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_default_shared_threshold" android:title="@string/morphe_eternal_history_default_shared_threshold_title" android:inputType="number" />

      <SwitchPreference android:key="morphe_eternal_history_watch_later_auto_cleanup" android:title="@string/morphe_eternal_history_watch_later_auto_cleanup_title" android:summary="@string/morphe_eternal_history_watch_later_auto_cleanup_summary" />
      <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_watch_later_cleanup_min_progress" android:title="@string/morphe_eternal_history_watch_later_cleanup_min_progress_title" android:inputType="number" />
      <Preference android:key="morphe_eternal_history_watch_later_note" android:title="@string/morphe_eternal_history_watch_later_note_title" android:summary="@string/morphe_eternal_history_watch_later_note_summary" android:selectable="false" />

      <PreferenceScreen android:key="morphe_eternal_history_advanced_screen" android:title="@string/morphe_eternal_history_advanced_title" android:summary="@string/morphe_eternal_history_advanced_summary">
        <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_min_seconds" android:title="@string/morphe_eternal_history_min_seconds_title" android:inputType="number" />
        <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_progress_step" android:title="@string/morphe_eternal_history_progress_step_title" android:inputType="number" />
        <SwitchPreference android:key="morphe_eternal_history_sync_cache" android:title="@string/morphe_eternal_history_sync_cache_title" />
        <SwitchPreference android:key="morphe_eternal_history_auto_update_check" android:title="@string/morphe_eternal_history_auto_update_check_title" />
        <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_default_dim_threshold" android:title="@string/morphe_eternal_history_default_dim_threshold_title" android:inputType="number" />
        <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_default_hide_threshold" android:title="@string/morphe_eternal_history_default_hide_threshold_title" android:inputType="number" />
        <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_thumbnail_opacity" android:title="@string/morphe_eternal_history_thumbnail_opacity_title" android:inputType="number" />
        <SwitchPreference android:key="morphe_eternal_history_thumbnail_grayscale" android:title="@string/morphe_eternal_history_thumbnail_grayscale_title" />
        <SwitchPreference android:key="morphe_eternal_history_dim_card_info" android:title="@string/morphe_eternal_history_dim_card_info_title" />
      </PreferenceScreen>
    </PreferenceScreen>
  </screen>
</morphe-add-on-preferences>
''')

# Concise text for the user-facing first screen; legacy/advanced strings remain for compatibility.
p = Path('patches/src/main/resources/addresources/values/youtube/strings.xml')
s = read(p)
repls = {
    '<string name="morphe_eternal_history_screen_summary">D1 중앙 원장에 시청 기록과 진행률을 직접 동기화합니다.</string>': '<string name="morphe_eternal_history_screen_summary">시청 기록 동기화 · 표시 · 나중에 볼 정리</string>',
    '<string name="morphe_eternal_history_default_profile_summary">안정화 모드에서는 모든 일반 영상 목록에 이 공통 기본값만 적용합니다. 기존 페이지별 개별 설정은 삭제하지 않고 보존되며, 탭 전환 안정성이 확인된 뒤 다시 사용할 수 있습니다.</string>': '<string name="morphe_eternal_history_default_profile_summary">공통 기본값입니다. 페이지별 설정은 상단 E 버튼에서 바꿀 수 있습니다.</string>',
    '<string name="morphe_eternal_history_watch_later_auto_cleanup_summary">안전 잠금 상태입니다. 데이터 손실 회귀가 완전히 검증되기 전까지 자동 삭제는 실행하지 않습니다.</string>': '<string name="morphe_eternal_history_watch_later_auto_cleanup_summary">켜면 정리 기준 이상 본 항목만 안전 transaction으로 정리합니다.</string>',
    '<string name="morphe_eternal_history_watch_later_note_title">나중에 볼 안전 잠금</string>': '<string name="morphe_eternal_history_watch_later_note_title">정리 안전 장치</string>',
    '<string name="morphe_eternal_history_watch_later_note_summary">탭 전환 crash 격리 동안 페이지 E overlay가 비활성화되어 앱 내부 수동 정리 버튼도 일시 중지됩니다. 기존 Watch Later 데이터와 거래 저널은 삭제하지 않습니다.</string>': '<string name="morphe_eternal_history_watch_later_note_summary">전체 목록 재검증과 삭제 직전 식별자 확인에 실패하면 아무것도 더 지우지 않습니다. 마지막 정리는 되돌릴 수 있습니다.</string>',
}
for old, new in repls.items():
    s = once(s, old, new, 'strings concise text')
needle = '  <string name="morphe_eternal_history_watch_later_note_summary">전체 목록 재검증과 삭제 직전 식별자 확인에 실패하면 아무것도 더 지우지 않습니다. 마지막 정리는 되돌릴 수 있습니다.</string>\n'
addition = needle + '  <string name="morphe_eternal_history_advanced_title">고급 설정</string>\n  <string name="morphe_eternal_history_advanced_summary">평소에는 바꿀 필요 없는 동기화·표시 세부값</string>\n'
s = once(s, needle, addition, 'strings advanced labels')
write(p, s)

# 7) Update maintenance CI contract: legacy direct deletion remains locked; automatic cleanup must
# route only through SafeCleaner and host navigation hooks remain quarantined.
p = Path('.github/workflows/validate-maintenance.yml')
s = read(p)
s = once(s,
'''          # Automatic and legacy deletion remain locked after the real-user data-loss report.
          grep -F 'new BooleanSetting("morphe_eternal_history_watch_later_auto_cleanup", FALSE' "$settings"
          grep -F 'DESTRUCTIVE_CLEANUP_LOCKED = true' "$safety"
          grep -F 'EternalWatchLaterSafety.isLocked()' "$job"
          grep -F 'scheduler.cancel(JOB_ID)' "$job"
          grep -F 'EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(false)' "$addon"
          grep -F 'if (!EternalWatchLaterSafety.isLocked())' "$addon"
          grep -F 'EternalWatchLaterJobService.refreshSchedule()' "$addon"
          grep -F 'EternalWatchLaterJobService.runNow()' "$toolbar"

          # The new manual path is isolated from the legacy cleaner and refreshes central progress first.
          grep -F 'EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(false)' "$coordinator"
          grep -F 'EternalCleanupLedgerSync.refresh()' "$coordinator"
''',
'''          # Legacy direct deletion remains locked after the real-user data-loss report. The opt-in
          # automatic route is allowed only through the same durable SafeCleaner transaction.
          grep -F 'new BooleanSetting("morphe_eternal_history_watch_later_auto_cleanup", FALSE' "$settings"
          grep -F 'DESTRUCTIVE_CLEANUP_LOCKED = true' "$safety"
          grep -F 'scheduler.cancel(JOB_ID)' "$job"
          ! grep -F 'EternalWatchLaterAutoSweep.runAsync' "$job"
          grep -F 'EternalWatchLaterSafeCleaner.runAutomaticCleanup' "$job"
          ! grep -F 'EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(false)' "$addon"
          grep -F 'if (!EternalWatchLaterSafety.isLocked())' "$addon"
          grep -F 'EternalWatchLaterJobService.refreshSchedule()' "$addon"
          grep -F 'EternalWatchLaterJobService.runNow()' "$toolbar"
          grep -F 'HOST_NAVIGATION_HOOKS_ENABLED = false' "$addon"
          grep -F 'EternalHistoryToolbar.ensureControlSoon()' "$addon"

          # Manual and automatic safe paths refresh central progress and use the same SafeCleaner.
          ! grep -F 'EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(false)' "$coordinator"
          grep -F 'EternalCleanupLedgerSync.refresh()' "$coordinator"
          grep -F 'static void runAutomaticCleanup' "$safe_cleaner"
          grep -F 'EternalCleanupLedgerSync.refresh()' "$safe_cleaner"
''', 'maintenance lock contract')
s = once(s,
'''          # Existing auto-sweep code remains fail-closed even though runtime scheduling is locked.
''',
'''          # Legacy auto-sweep code remains fail-closed but must no longer be called by JobService.
''', 'maintenance sweep comment')
s = once(s,
'''          grep -F 'positionControl(root, control)' "$toolbar"
          grep -F 'scheduleControlMount(220L)' "$toolbar"
''',
'''          grep -F 'positionControl(root, control)' "$toolbar"
          grep -F 'control.setY(topInset + Dim.dp8)' "$toolbar"
          grep -F 'scheduleControlMount(220L)' "$toolbar"
''', 'maintenance header position')
s = once(s,
'''          echo 'PASS Android legacy/automatic lock + manual transactional Watch Later safety'
''',
'''          echo 'PASS Android legacy lock + shared transactional Watch Later safety + header control quarantine'
''', 'maintenance pass label')
write(p, s)

print('PASS guarded Android v1.10.6 rewrite')
