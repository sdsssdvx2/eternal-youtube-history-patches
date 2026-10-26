package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.ui.Dim;
import app.morphe.extension.shared.theme.ThemeUtils;

/** Compact Eternal overlay with live page-scoped settings. */
@SuppressWarnings("unused")
public final class EternalHistoryToolbar {
    private static final String CONTROL_TAG = "eternal-history-floating-control";
    private static final AtomicBoolean mountPending = new AtomicBoolean();
    private static final AtomicBoolean refreshPending = new AtomicBoolean();
    private static WeakReference<TextView> controlRef = new WeakReference<>(null);

    /** Injection point: toolbar activity is only used as a signal that a visible YouTube UI exists. */
    public static void onToolbarImageView(ImageView imageView) {
        if (imageView == null || !EternalHistorySettings.ENABLED.get()) return;
        scheduleControlMount(80L);
    }

    static void onSurfaceChanged() {
        try {
            Activity activity = Utils.getActivity();
            if (activity == null) return;
            activity.runOnUiThread(() -> {
                try {
                    refreshControl();
                    ensureControl();
                } catch (Throwable t) {
                    Logger.printDebug(() -> "Eternal surface UI refresh ignored: " + safeMessage(t));
                }
            });
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal surface UI event ignored: " + safeMessage(t));
        }
    }

    static void ensureControlSoon() {
        scheduleControlMount(250L);
    }

    private static void scheduleControlMount(long delayMs) {
        if (!mountPending.compareAndSet(false, true)) return;
        Utils.runOnMainThreadDelayed(() -> {
            try { ensureControl(); }
            finally { mountPending.set(false); }
        }, delayMs);
    }

    /**
     * Never insert into YouTube's native ActionMenu/Toolbar. Those containers are rebuilt during
     * Shorts/search/tab transitions and their child positions belong to YouTube. A single overlay
     * below the app bar avoids both overlap and host-menu lifecycle crashes.
     */
    private static void ensureControl() {
        try {
            Activity activity = Utils.getActivity();
            if (activity == null || activity.isFinishing()) return;
            View content = activity.findViewById(android.R.id.content);
            if (!(content instanceof ViewGroup root) || root.getWidth() <= 0) {
                scheduleControlMount(350L);
                return;
            }

            TextView existing = controlRef.get();
            if (existing != null && existing.getParent() == root && existing.isAttachedToWindow()) {
                refreshLabel(existing);
                positionControl(root, existing);
                return;
            }
            removeTaggedControls(root);
            TextView control = createControl(root);
            root.addView(control, new ViewGroup.LayoutParams(Dim.dp(36), Dim.dp32));
            controlRef = new WeakReference<>(control);
            control.post(() -> positionControl(root, control));
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal overlay mount deferred: " + safeMessage(t));
        }
    }

    private static TextView createControl(ViewGroup host) {
        TextView control = new TextView(host.getContext());
        control.setTag(CONTROL_TAG);
        control.setGravity(Gravity.CENTER);
        control.setTextSize(12);
        control.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        control.setSingleLine(true);
        control.setPadding(Dim.dp4, 0, Dim.dp4, 0);
        control.setClickable(true);
        control.setFocusable(true);
        control.setTextColor(ThemeUtils.getAppForegroundColor());
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.RECTANGLE);
        bg.setCornerRadius(Dim.dp16);
        bg.setColor(ThemeUtils.getEditTextBackground());
        control.setBackground(bg);
        control.setElevation(Dim.dp8);
        refreshLabel(control);
        control.setOnClickListener(v -> safeShowSurfaceDialog());
        control.setOnLongClickListener(v -> { safeShowDiagnostics(); return true; });
        return control;
    }

    private static void positionControl(ViewGroup root, View control) {
        if (root.getWidth() <= 0) return;
        int topInset = 0;
        try {
            WindowInsets insets = root.getRootWindowInsets();
            if (insets != null) topInset = insets.getSystemWindowInsetTop();
        } catch (Throwable ignored) { }
        control.setX(Math.max(Dim.dp8, root.getWidth() - control.getWidth() - Dim.dp10));
        // Status bar + YouTube app bar. Keep the Eternal control out of the native action row.
        control.setY(topInset + Dim.dp(56));
    }

    private static void removeTaggedControls(ViewGroup host) {
        for (int i = host.getChildCount() - 1; i >= 0; i--) {
            View child = host.getChildAt(i);
            if (CONTROL_TAG.equals(child.getTag())) host.removeViewAt(i);
        }
    }

    private static void safeShowSurfaceDialog() {
        try { showSurfaceDialog(); }
        catch (Throwable t) {
            Logger.printException(() -> "Eternal page settings dialog failure", t);
            Utils.showToastShort("Eternal 페이지 설정을 열지 못했습니다.");
        }
    }

    private static void showSurfaceDialog() {
        Activity activity = Utils.getActivity();
        if (activity == null || activity.isFinishing()) return;
        EternalSurfaceSettings.Surface surface = EternalSurfaceTracker.currentForUi();
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.get(surface);
        boolean inherited = !EternalSurfaceSettings.hasExplicitProfile(surface);

        ScrollView scroll = new ScrollView(activity);
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Dim.dp16, Dim.dp8, Dim.dp16, Dim.dp8);
        scroll.addView(box);

        TextView note = text(activity,
                inherited
                        ? "현재 공통 기본값을 사용 중입니다. 값을 바꾸면 이 페이지의 개별 설정으로 즉시 저장됩니다.\n흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다."
                        : "이 페이지의 개별 설정입니다. 변경 내용은 화면에 즉시 반영됩니다.\n흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다.",
                13, false);
        note.setPadding(0, 0, 0, Dim.dp8);
        box.addView(note);

        CheckBox dim = check(activity, "흐리게 표시", profile.dimEnabled);
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

        final CheckBox autoCleanup;
        final ThresholdRow cleanupThreshold;
        if (surface == EternalSurfaceSettings.Surface.WATCH_LATER) {
            TextView wlTitle = text(activity, "나중에 볼 동영상 정리", 15, true);
            wlTitle.setPadding(0, Dim.dp12, 0, Dim.dp4);
            box.addView(wlTitle);
            autoCleanup = check(activity, "기준 이상 시 자동 정리", EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get());
            cleanupThreshold = threshold(activity, "자동/수동 정리 기준", EternalHistorySettings.watchLaterCleanupProgressPercent());
            box.addView(autoCleanup);
            box.addView(cleanupThreshold.root);
            autoCleanup.setOnCheckedChangeListener((button, checked) -> {
                EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(checked);
                EternalWatchLaterJobService.refreshSchedule();
                if (checked) EternalWatchLaterJobService.runNow();
            });
            cleanupThreshold.onUserChange = () -> {
                EternalHistorySettings.WATCH_LATER_CLEANUP_MIN_PROGRESS.save(cleanupThreshold.seek.getProgress());
                EternalWatchLaterJobService.refreshSchedule();
            };

            Button cleanNow = new Button(activity);
            cleanNow.setText("지금 나중에 볼 동영상 정리…");
            cleanNow.setOnClickListener(v -> EternalCleanupCoordinator.previewAndConfirm(activity));
            box.addView(cleanNow);
        } else {
            autoCleanup = null;
            cleanupThreshold = null;
        }

        Button reset = new Button(activity);
        reset.setText("이 페이지 설정을 기본값으로 되돌리기");
        box.addView(reset);

        Button diagnostics = new Button(activity);
        diagnostics.setText("Eternal 진단 정보");
        box.addView(diagnostics);

        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle(surface.label)
                .setView(scroll)
                .setNegativeButton("닫기", null)
                .create();

        reset.setOnClickListener(v -> {
            EternalSurfaceSettings.reset(surface);
            Utils.showToastShort(surface.label + " 페이지가 공통 기본값을 다시 사용합니다.");
            dialog.dismiss();
            refreshControl();
            schedulePresentationRefresh();
        });
        diagnostics.setOnClickListener(v -> safeShowDiagnostics());
        dialog.show();
    }

    private static ThresholdRow threshold(Activity activity, String label, int progress) {
        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(0, Dim.dp6, 0, Dim.dp2);
        TextView value = text(activity, label + ": " + progress + "%", 13, false);
        SeekBar seek = new SeekBar(activity);
        seek.setMax(100);
        seek.setProgress(Math.max(0, Math.min(100, progress)));
        ThresholdRow row = new ThresholdRow(root, seek);
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int p, boolean fromUser) {
                value.setText(label + ": " + p + "%");
                if (fromUser && row.onUserChange != null) row.onUserChange.run();
            }
            @Override public void onStartTrackingTouch(SeekBar bar) { }
            @Override public void onStopTrackingTouch(SeekBar bar) {
                if (row.onUserChange != null) row.onUserChange.run();
            }
        });
        root.addView(value);
        root.addView(seek);
        return row;
    }

    private static CheckBox check(Activity activity, String label, boolean checked) {
        CheckBox box = new CheckBox(activity);
        box.setText(label);
        box.setTextColor(ThemeUtils.getAppForegroundColor());
        box.setChecked(checked);
        return box;
    }

    private static TextView text(Activity activity, String value, int sp, boolean bold) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(ThemeUtils.getAppForegroundColor());
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private static void refreshControl() {
        TextView control = controlRef.get();
        if (control == null) return;
        try { refreshLabel(control); }
        catch (Throwable t) { Logger.printDebug(() -> "Eternal control label ignored: " + safeMessage(t)); }
    }

    private static void refreshLabel(TextView control) {
        EternalSurfaceSettings.Surface surface = EternalSurfaceTracker.currentForUi();
        EternalSurfaceSettings.Profile p = EternalSurfaceSettings.get(surface);
        control.setText("E");
        String state;
        if (p.dimEnabled && p.hideEnabled) {
            state = "흐림 " + p.effectiveDimThreshold() + "% · 숨김 " + p.effectiveHideThreshold() + "%";
        } else if (p.hideEnabled) {
            state = "숨김 " + p.effectiveHideThreshold() + "%";
        } else if (p.dimEnabled) {
            state = "흐림 " + p.effectiveDimThreshold() + "%";
        } else {
            state = "표시 변경 없음";
        }
        String scope = p.explicit ? "개별 설정" : "공통 기본값";
        control.setContentDescription("Eternal · " + surface.label + " · " + scope + " · " + state);
        control.setAlpha(p.visualEnabled() ? 1.0f : 0.72f);
    }

    /** Debounced live rebind: reruns Litho filtering for visible RecyclerView content without recreating Activity. */
    private static void schedulePresentationRefresh() {
        if (!refreshPending.compareAndSet(false, true)) return;
        Utils.runOnMainThreadDelayed(() -> {
            refreshPending.set(false);
            try {
                Activity activity = Utils.getActivity();
                if (activity == null || activity.isFinishing()) return;
                View content = activity.findViewById(android.R.id.content);
                if (content == null) return;
                postRecyclerRebinds(content);
                content.requestLayout();
                content.invalidate();
            } catch (Throwable t) {
                Logger.printDebug(() -> "Eternal live presentation refresh ignored: " + safeMessage(t));
            }
        }, 100L);
    }

    private static void postRecyclerRebinds(View view) {
        if (view == null) return;
        String className = view.getClass().getName();
        if (className.contains("RecyclerView")) {
            view.post(() -> notifyRecyclerAdapter(view));
        }
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) postRecyclerRebinds(group.getChildAt(i));
        }
    }

    private static void notifyRecyclerAdapter(View recycler) {
        try {
            Method getAdapter = findNoArgMethod(recycler.getClass(), "getAdapter");
            if (getAdapter == null) return;
            Object adapter = getAdapter.invoke(recycler);
            if (adapter == null) return;
            Method notifyDataSetChanged = findNoArgMethod(adapter.getClass(), "notifyDataSetChanged");
            if (notifyDataSetChanged != null) notifyDataSetChanged.invoke(adapter);
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal RecyclerView rebind deferred: " + safeMessage(t));
        }
    }

    private static Method findNoArgMethod(Class<?> type, String name) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            try {
                Method method = current.getDeclaredMethod(name);
                method.setAccessible(true);
                return method;
            } catch (NoSuchMethodException ignored) { }
            catch (Throwable ignored) { return null; }
        }
        return null;
    }

    private static void safeShowDiagnostics() {
        try { showDiagnostics(); }
        catch (Throwable t) {
            Logger.printException(() -> "Eternal diagnostics dialog failure", t);
            Utils.showToastShort("Eternal 진단 정보를 열지 못했습니다.");
        }
    }

    private static void showDiagnostics() {
        Activity activity = Utils.getActivity();
        if (activity == null || activity.isFinishing()) return;
        EternalSurfaceSettings.Surface surface = EternalSurfaceTracker.currentForUi();
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.get(surface);
        activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                .setTitle("Eternal 진단")
                .setMessage("현재 페이지=" + surface.label
                        + "\n설정 범위=" + (profile.explicit ? "페이지 개별" : "공통 기본값")
                        + "\n흐림=" + profile.dimEnabled + " (" + profile.effectiveDimThreshold() + "%+)"
                        + "\n숨김=" + profile.hideEnabled + " (" + profile.effectiveHideThreshold() + "%+)"
                        + "\n진행률 기준 연동=" + profile.linkedThresholds
                        + "\n" + EternalWatchLaterCleaner.diagnosticSummary()
                        + "\n" + EternalCleanupCoordinator.diagnosticSummary()
                        + "\n" + EternalWatchLaterAutoSweep.diagnosticSummary())
                .setPositiveButton(android.R.string.ok, null)
                .show());
    }

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return message == null ? (t == null ? "unknown" : t.getClass().getSimpleName()) : message;
    }

    private static final class ThresholdRow {
        final LinearLayout root;
        final SeekBar seek;
        Runnable onUserChange;

        ThresholdRow(LinearLayout root, SeekBar seek) {
            this.root = root;
            this.seek = seek;
        }
    }

    private EternalHistoryToolbar() { }
}
