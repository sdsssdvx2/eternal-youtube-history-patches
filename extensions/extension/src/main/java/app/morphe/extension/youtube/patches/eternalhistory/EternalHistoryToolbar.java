package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
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

/** Compact Eternal control visually anchored inside YouTube's real top toolbar row. */
@SuppressWarnings("unused")
public final class EternalHistoryToolbar {
    private static final String CONTROL_TAG = "eternal-history-floating-control";
    private static final AtomicBoolean mountPending = new AtomicBoolean();
    private static final AtomicBoolean refreshPending = new AtomicBoolean();
    private static WeakReference<TextView> controlRef = new WeakReference<>(null);
    private static WeakReference<ImageView> toolbarAnchorRef = new WeakReference<>(null);

    /**
     * Injection point beside YouTube's own toolbar ImageView. We never add children to the native
     * ActionMenu/Toolbar; the host view is geometry-only evidence that lets our root-level control
     * occupy the toolbar's empty space instead of floating over video content.
     */
    public static void onToolbarImageView(ImageView imageView) {
        if (imageView == null || !EternalHistorySettings.ENABLED.get()) return;
        imageView.post(() -> {
            try {
                rememberToolbarAnchor(imageView);
                scheduleControlMount(32L);
            } catch (Throwable t) {
                Logger.printDebug(() -> "Eternal toolbar anchor ignored: " + safeMessage(t));
            }
        });
    }

    /**
     * Navigation/browse callbacks can run while YouTube is rebuilding its view hierarchy. Never
     * add/remove overlay children synchronously from such a callback; defer and require a live
     * toolbar anchor again before showing anything.
     */
    static void onSurfaceChanged() {
        scheduleControlMount(120L);
    }

    static void ensureControlSoon() {
        scheduleControlMount(180L);
    }

    private static void rememberToolbarAnchor(ImageView candidate) {
        if (candidate == null || !candidate.isAttachedToWindow() || candidate.getWidth() <= 0
                || candidate.getHeight() <= 0 || !candidate.isShown()) return;
        ImageView current = toolbarAnchorRef.get();
        if (current == null || !current.isAttachedToWindow() || !current.isShown()) {
            toolbarAnchorRef = new WeakReference<>(candidate);
            return;
        }
        int[] candidateLocation = new int[2];
        int[] currentLocation = new int[2];
        candidate.getLocationInWindow(candidateLocation);
        current.getLocationInWindow(currentLocation);
        // Prefer the left-most live action icon so E sits immediately before the native action
        // cluster, which is the widest stable empty part of YouTube's header.
        if (candidateLocation[0] < currentLocation[0]) {
            toolbarAnchorRef = new WeakReference<>(candidate);
        }
    }

    private static void scheduleControlMount(long delayMs) {
        if (!mountPending.compareAndSet(false, true)) return;
        Utils.runOnMainThreadDelayed(() -> {
            try { ensureControl(); }
            finally { mountPending.set(false); }
        }, delayMs);
    }

    /** Never insert into YouTube's native ActionMenu/Toolbar. */
    private static void ensureControl() {
        try {
            Activity activity = Utils.getActivity();
            if (activity == null || activity.isFinishing()) return;
            View content = activity.findViewById(android.R.id.content);
            if (!(content instanceof ViewGroup root) || root.getWidth() <= 0) {
                scheduleControlMount(180L);
                return;
            }

            EternalSurfaceSettings.Surface surface = EternalSurfaceTracker.currentForUi();
            if (surface == EternalSurfaceSettings.Surface.SHORTS) {
                removeTaggedControls(root);
                controlRef = new WeakReference<>(null);
                return;
            }

            ImageView anchor = toolbarAnchorRef.get();
            if (!isUsableToolbarAnchor(root, anchor)) {
                // Fail closed visually: never fall back to a hard-coded content Y coordinate.
                TextView stale = controlRef.get();
                if (stale != null) stale.setVisibility(View.GONE);
                return;
            }

            TextView existing = controlRef.get();
            if (existing != null && existing.getParent() == root && existing.isAttachedToWindow()) {
                refreshLabel(existing);
                positionControl(root, existing, anchor);
                return;
            }
            removeTaggedControls(root);
            TextView control = createControl(root);
            control.setVisibility(View.INVISIBLE);
            root.addView(control, new ViewGroup.LayoutParams(Dim.dp(36), Dim.dp32));
            controlRef = new WeakReference<>(control);
            control.post(() -> {
                ImageView liveAnchor = toolbarAnchorRef.get();
                if (!positionControl(root, control, liveAnchor)) control.setVisibility(View.GONE);
            });
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal toolbar control mount deferred: " + safeMessage(t));
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
        control.setOnClickListener(v -> safeShowQuickDialog());
        control.setOnLongClickListener(v -> { safeShowDiagnostics(); return true; });
        return control;
    }

    private static boolean isUsableToolbarAnchor(ViewGroup root, ImageView anchor) {
        if (root == null || anchor == null || !anchor.isAttachedToWindow() || !anchor.isShown()
                || anchor.getWidth() <= 0 || anchor.getHeight() <= 0 || root.getWidth() <= 0) return false;
        try {
            int[] rootLocation = new int[2];
            int[] anchorLocation = new int[2];
            root.getLocationInWindow(rootLocation);
            anchor.getLocationInWindow(anchorLocation);
            int relativeY = anchorLocation[1] - rootLocation[1];
            int relativeX = anchorLocation[0] - rootLocation[0];
            return relativeX >= 0 && relativeX < root.getWidth()
                    && relativeY >= 0 && relativeY <= Dim.dp(160);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean positionControl(ViewGroup root, View control, ImageView anchor) {
        if (!isUsableToolbarAnchor(root, anchor) || control == null) return false;
        try {
            int[] rootLocation = new int[2];
            int[] anchorLocation = new int[2];
            root.getLocationInWindow(rootLocation);
            anchor.getLocationInWindow(anchorLocation);
            int width = control.getWidth() > 0 ? control.getWidth() : Dim.dp(36);
            int height = control.getHeight() > 0 ? control.getHeight() : Dim.dp32;
            float x = anchorLocation[0] - rootLocation[0] - width - Dim.dp8;
            float y = anchorLocation[1] - rootLocation[1]
                    + (anchor.getHeight() - height) / 2f;
            if (x < Dim.dp4 || x + width > root.getWidth() - Dim.dp4 || y < 0 || y > Dim.dp(160)) {
                control.setVisibility(View.GONE);
                return false;
            }
            control.setX(x);
            control.setY(y);
            control.setVisibility(View.VISIBLE);
            return true;
        } catch (Throwable t) {
            control.setVisibility(View.GONE);
            return false;
        }
    }

    private static void removeTaggedControls(ViewGroup host) {
        for (int i = host.getChildCount() - 1; i >= 0; i--) {
            View child = host.getChildAt(i);
            if (CONTROL_TAG.equals(child.getTag())) host.removeViewAt(i);
        }
    }

    private static void safeShowQuickDialog() {
        try { showQuickDialog(); }
        catch (Throwable t) {
            Logger.printException(() -> "Eternal quick settings dialog failure", t);
            Utils.showToastShort("Eternal 빠른 설정을 열지 못했습니다.");
        }
    }

    /**
     * During the navigation-crash quarantine the renderer intentionally uses the common/default
     * profile for normal lists, so the E dialog edits that exact effective profile instead of
     * pretending page-specific settings are active. Existing page-specific profiles stay stored
     * untouched for a future safe surface classifier.
     */
    private static void showQuickDialog() {
        Activity activity = Utils.getActivity();
        if (activity == null || activity.isFinishing()) return;
        if (EternalSurfaceTracker.currentForUi() == EternalSurfaceSettings.Surface.SHORTS) return;
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.defaultProfile(false);

        ScrollView scroll = new ScrollView(activity);
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Dim.dp16, Dim.dp8, Dim.dp16, Dim.dp8);
        scroll.addView(box);

        TextView note = text(activity,
                "일반 영상 목록에 실제 적용되는 공통 표시 설정입니다. 기존 페이지별 저장값은 그대로 보존됩니다.",
                13, false);
        note.setPadding(0, 0, 0, Dim.dp8);
        box.addView(note);

        CheckBox dim = check(activity, "시청한 영상 흐리게", profile.dimEnabled);
        CheckBox hide = check(activity, "시청한 영상 숨기기", profile.hideEnabled);
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
            saveCommonProfile(
                    dim.isChecked(), hide.isChecked(), linked.isChecked(),
                    shared.seek.getProgress(), dimThreshold.seek.getProgress(), hideThreshold.seek.getProgress());
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

        TextView wlTitle = text(activity, "나중에 볼 동영상 정리", 15, true);
        wlTitle.setPadding(0, Dim.dp12, 0, Dim.dp4);
        box.addView(wlTitle);
        CheckBox autoCleanup = check(activity, "기준 이상 시 자동 안전 정리",
                EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get());
        ThresholdRow cleanupThreshold = threshold(activity, "자동/수동 정리 기준",
                EternalHistorySettings.watchLaterCleanupProgressPercent());
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
        cleanNow.setText("지금 나중에 볼 동영상 안전 정리…");
        cleanNow.setOnClickListener(v -> EternalCleanupCoordinator.previewAndConfirm(activity));
        box.addView(cleanNow);

        Button diagnostics = new Button(activity);
        diagnostics.setText("진단 정보");
        box.addView(diagnostics);

        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("Eternal 빠른 설정")
                .setView(scroll)
                .setNegativeButton("닫기", null)
                .create();
        diagnostics.setOnClickListener(v -> safeShowDiagnostics());
        dialog.show();
    }

    private static void saveCommonProfile(boolean dimEnabled, boolean hideEnabled,
                                          boolean linkedThresholds, int sharedThreshold,
                                          int dimThreshold, int hideThreshold) {
        EternalHistorySettings.DEFAULT_DIM_ENABLED.save(dimEnabled);
        EternalHistorySettings.DEFAULT_HIDE_ENABLED.save(hideEnabled);
        EternalHistorySettings.DEFAULT_LINKED_THRESHOLDS.save(linkedThresholds);
        EternalHistorySettings.DEFAULT_SHARED_THRESHOLD.save(clamp(sharedThreshold));
        EternalHistorySettings.DEFAULT_DIM_THRESHOLD.save(clamp(dimThreshold));
        EternalHistorySettings.DEFAULT_HIDE_THRESHOLD.save(clamp(hideThreshold));
    }

    private static int clamp(int value) {
        return Math.max(0, Math.min(100, value));
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
        try {
            if (EternalSurfaceTracker.currentForUi() == EternalSurfaceSettings.Surface.SHORTS) {
                control.setVisibility(View.GONE);
                return;
            }
            refreshLabel(control);
            View parent = (View) control.getParent();
            ImageView anchor = toolbarAnchorRef.get();
            if (!(parent instanceof ViewGroup root) || !positionControl(root, control, anchor)) {
                control.setVisibility(View.GONE);
            }
        } catch (Throwable t) {
            control.setVisibility(View.GONE);
            Logger.printDebug(() -> "Eternal control label ignored: " + safeMessage(t));
        }
    }

    private static void refreshLabel(TextView control) {
        if (EternalSurfaceTracker.currentForUi() == EternalSurfaceSettings.Surface.SHORTS) {
            control.setVisibility(View.GONE);
            return;
        }
        EternalSurfaceSettings.Profile p = EternalSurfaceSettings.defaultProfile(false);
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
        control.setContentDescription("Eternal · 공통 표시 설정 · " + state);
        control.setAlpha(p.visualEnabled() ? 1.0f : 0.72f);
    }

    /** Debounced live rebind: reruns Litho filtering without recreating Activity. */
    private static void schedulePresentationRefresh() {
        if (!refreshPending.compareAndSet(false, true)) return;
        Utils.runOnMainThreadDelayed(() -> {
            refreshPending.set(false);
            try {
                if (EternalSurfaceTracker.currentForUi() == EternalSurfaceSettings.Surface.SHORTS) return;
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
        EternalSurfaceSettings.Surface surfaceHint = EternalSurfaceTracker.currentForUi();
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.defaultProfile(false);
        activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                .setTitle("Eternal 진단")
                .setMessage("표시 설정 범위=공통 기본값"
                        + "\n현재 페이지 힌트=" + surfaceHint.label
                        + "\n흐림=" + profile.dimEnabled + " (" + profile.effectiveDimThreshold() + "%+)"
                        + "\n숨김=" + profile.hideEnabled + " (" + profile.effectiveHideThreshold() + "%+)"
                        + "\n진행률 기준 연동=" + profile.linkedThresholds
                        + "\n기존 페이지별 설정=보존됨(현재 crash 격리 중 미적용)"
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
