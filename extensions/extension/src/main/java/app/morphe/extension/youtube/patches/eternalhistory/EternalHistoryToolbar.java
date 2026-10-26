package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.ui.Dim;
import app.morphe.extension.shared.theme.ThemeUtils;

/** Compact Eternal control with a page-scoped settings dialog. */
@SuppressWarnings("unused")
public final class EternalHistoryToolbar {
    private static final String CONTROL_TAG = "eternal-history-toolbar-control";
    private static final String FALLBACK_TAG = "eternal-history-floating-control";
    private static final AtomicBoolean mountPending = new AtomicBoolean();
    private static WeakReference<ViewGroup> hostRef = new WeakReference<>(null);
    private static WeakReference<TextView> controlRef = new WeakReference<>(null);
    private static WeakReference<TextView> fallbackRef = new WeakReference<>(null);

    /** Injection point: called when YouTube materializes native toolbar ImageViews. */
    public static void onToolbarImageView(ImageView imageView) {
        if (imageView == null || !EternalHistorySettings.ENABLED.get()) return;
        if (!mountPending.compareAndSet(false, true)) return;
        imageView.post(() -> {
            try { mountOnVisibleToolbar(imageView); }
            finally { mountPending.set(false); }
        });
    }

    static void onSurfaceChanged() {
        Activity activity = Utils.getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            refreshControls();
            scheduleFallbackMount();
        });
    }

    static void ensureControlSoon() {
        scheduleFallbackMount();
    }

    private static void mountOnVisibleToolbar(ImageView imageView) {
        try {
            ViewGroup host = findVisibleToolbarHost(imageView);
            if (host == null) return;

            TextView existing = controlRef.get();
            ViewGroup existingHost = hostRef.get();
            if (existing != null
                    && existingHost == host
                    && existing.getParent() == host
                    && isVisibleAndAttached(existing)) {
                refreshLabel(existing);
                removeFallback();
                return;
            }

            if (existing != null && existing.getParent() instanceof ViewGroup oldHost) {
                oldHost.removeView(existing);
            }
            removeTaggedControls(host, CONTROL_TAG);

            TextView control = createControl(host, CONTROL_TAG, false);
            int insertAt = Math.max(0, host.getChildCount() - 1);
            host.addView(control, insertAt);
            ViewGroup.LayoutParams params = control.getLayoutParams();
            if (params != null) {
                params.width = Dim.dp(40);
                params.height = Dim.dp32;
                control.setLayoutParams(params);
            }
            hostRef = new WeakReference<>(host);
            controlRef = new WeakReference<>(control);
            removeFallback();
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal toolbar mount deferred: " + t.getMessage());
            scheduleFallbackMount();
        }
    }

    private static TextView createControl(ViewGroup host, String tag, boolean floating) {
        TextView control = new TextView(host.getContext());
        control.setTag(tag);
        control.setGravity(Gravity.CENTER);
        control.setTextSize(12);
        control.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        control.setSingleLine(true);
        control.setPadding(Dim.dp6, 0, Dim.dp6, 0);
        control.setClickable(true);
        control.setFocusable(true);
        control.setTextColor(ThemeUtils.getAppForegroundColor());
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.RECTANGLE);
        bg.setCornerRadius(Dim.dp16);
        bg.setColor(ThemeUtils.getEditTextBackground());
        control.setBackground(bg);
        control.setElevation(Dim.dp(floating ? 8 : 2));
        refreshLabel(control);
        control.setOnClickListener(v -> showSurfaceDialog());
        control.setOnLongClickListener(v -> { showDiagnostics(); return true; });
        return control;
    }

    private static ViewGroup findVisibleToolbarHost(ImageView imageView) {
        if (!isVisibleAndAttached(imageView)) return null;

        ViewParent itemParent = imageView.getParent();
        if (itemParent instanceof View itemView && isVisibleAndAttached(itemView)) {
            ViewParent hostParent = itemView.getParent();
            if (hostParent instanceof ViewGroup host && isVisibleAndAttached(host)) return host;
        }

        View current = imageView;
        for (int depth = 0; depth < 7; depth++) {
            ViewParent parent = current.getParent();
            if (!(parent instanceof ViewGroup group)) break;
            if (!isVisibleAndAttached(group)) {
                current = group;
                continue;
            }
            String name = group.getClass().getName();
            if (name.contains("ActionMenu") || name.contains("Toolbar")) return group;
            current = group;
        }
        return null;
    }

    private static void scheduleFallbackMount() {
        Utils.runOnMainThreadDelayed(EternalHistoryToolbar::ensureFallbackControl, 900L);
    }

    private static void ensureFallbackControl() {
        try {
            TextView nativeControl = controlRef.get();
            if (nativeControl != null && isVisibleAndAttached(nativeControl)) {
                removeFallback();
                return;
            }
            Activity activity = Utils.getActivity();
            if (activity == null || activity.isFinishing()) return;
            View content = activity.findViewById(android.R.id.content);
            if (!(content instanceof ViewGroup root) || root.getWidth() <= 0) return;

            TextView existing = fallbackRef.get();
            if (existing != null && existing.getParent() == root && existing.isAttachedToWindow()) {
                refreshLabel(existing);
                positionFallback(root, existing);
                return;
            }
            removeTaggedControls(root, FALLBACK_TAG);
            TextView floating = createControl(root, FALLBACK_TAG, true);
            root.addView(floating, new ViewGroup.LayoutParams(Dim.dp(40), Dim.dp32));
            fallbackRef = new WeakReference<>(floating);
            floating.post(() -> positionFallback(root, floating));
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal fallback control deferred: " + t.getMessage());
        }
    }

    private static void positionFallback(ViewGroup root, View control) {
        if (root.getWidth() <= 0) return;
        control.setX(Math.max(Dim.dp8, root.getWidth() - control.getWidth() - Dim.dp8));
        // Below the app bar: avoids YouTube's back/search/overflow actions while remaining easy to reach.
        control.setY(Dim.dp(58));
    }

    private static void removeFallback() {
        TextView fallback = fallbackRef.get();
        if (fallback != null && fallback.getParent() instanceof ViewGroup group) group.removeView(fallback);
        fallbackRef = new WeakReference<>(null);
    }

    private static boolean isVisibleAndAttached(View view) {
        return view.isAttachedToWindow() && view.isShown() && view.getWindowVisibility() == View.VISIBLE;
    }

    private static void removeTaggedControls(ViewGroup host, String tag) {
        for (int i = host.getChildCount() - 1; i >= 0; i--) {
            View child = host.getChildAt(i);
            if (tag.equals(child.getTag())) host.removeViewAt(i);
        }
    }

    private static void showSurfaceDialog() {
        Activity activity = Utils.getActivity();
        if (activity == null) return;
        EternalSurfaceSettings.Surface surface = EternalSurfaceTracker.currentForUi();
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.get(surface);

        ScrollView scroll = new ScrollView(activity);
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Dim.dp16, Dim.dp8, Dim.dp16, Dim.dp8);
        scroll.addView(box);

        TextView note = text(activity,
                "이 설정은 이 기기의 ‘" + surface.label + "’ 페이지에만 저장됩니다.\n"
                        + "흐림과 숨김을 함께 켜면 숨김 조건이 우선합니다.", 13, false);
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
        linked.setOnCheckedChangeListener((button, checked) -> refreshThresholdRows.run());
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
                .setTitle("Eternal · " + surface.label)
                .setView(scroll)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton("적용", null)
                .create();

        reset.setOnClickListener(v -> {
            EternalSurfaceSettings.reset(surface);
            Utils.showToastShort(surface.label + " 설정을 기본값으로 되돌렸습니다.");
            dialog.dismiss();
            refreshControls();
        });
        diagnostics.setOnClickListener(v -> showDiagnostics());

        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            EternalSurfaceSettings.save(
                    surface,
                    dim.isChecked(),
                    hide.isChecked(),
                    linked.isChecked(),
                    shared.seek.getProgress(),
                    dimThreshold.seek.getProgress(),
                    hideThreshold.seek.getProgress());
            if (autoCleanup != null && cleanupThreshold != null) {
                EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(autoCleanup.isChecked());
                EternalHistorySettings.WATCH_LATER_CLEANUP_MIN_PROGRESS.save(cleanupThreshold.seek.getProgress());
                EternalWatchLaterJobService.refreshSchedule();
                if (autoCleanup.isChecked()) EternalWatchLaterJobService.runNow();
            }
            if (dim.isChecked() || hide.isChecked()) EternalHistoryClient.ensureFeedCacheStarted();
            Utils.showToastShort(surface.label + " 표시 설정을 저장했습니다.");
            dialog.dismiss();
            refreshControls();
        }));
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
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int p, boolean fromUser) {
                value.setText(label + ": " + p + "%");
            }
            @Override public void onStartTrackingTouch(SeekBar bar) { }
            @Override public void onStopTrackingTouch(SeekBar bar) { }
        });
        root.addView(value);
        root.addView(seek);
        return new ThresholdRow(root, seek);
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

    private static void refreshControls() {
        TextView control = controlRef.get();
        if (control != null) refreshLabel(control);
        TextView fallback = fallbackRef.get();
        if (fallback != null) refreshLabel(fallback);
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
        control.setContentDescription("Eternal · " + surface.label + " · " + state);
        control.setAlpha(p.visualEnabled() ? 1.0f : 0.72f);
    }

    private static void showDiagnostics() {
        Activity activity = Utils.getActivity();
        if (activity == null) return;
        EternalSurfaceSettings.Surface surface = EternalSurfaceTracker.currentForUi();
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.get(surface);
        activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                .setTitle("Eternal 진단")
                .setMessage("현재 페이지=" + surface.label
                        + "\n흐림=" + profile.dimEnabled + " (" + profile.effectiveDimThreshold() + "%+)"
                        + "\n숨김=" + profile.hideEnabled + " (" + profile.effectiveHideThreshold() + "%+)"
                        + "\n진행률 기준 연동=" + profile.linkedThresholds
                        + "\n" + EternalWatchLaterCleaner.diagnosticSummary()
                        + "\n" + EternalCleanupCoordinator.diagnosticSummary()
                        + "\n" + EternalWatchLaterAutoSweep.diagnosticSummary())
                .setPositiveButton(android.R.string.ok, null)
                .show());
    }

    private record ThresholdRow(LinearLayout root, SeekBar seek) { }

    private EternalHistoryToolbar() { }
}
