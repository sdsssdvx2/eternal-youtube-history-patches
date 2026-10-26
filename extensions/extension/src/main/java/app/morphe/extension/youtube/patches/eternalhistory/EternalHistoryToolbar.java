package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.Menu;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.ImageView;
import android.widget.PopupMenu;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.ui.Dim;
import app.morphe.extension.shared.theme.ThemeUtils;

/** Small Eternal control mounted beside YouTube's own header action buttons. */
@SuppressWarnings("unused")
public final class EternalHistoryToolbar {
    private static final int MENU_SHOW = 101;
    private static final int MENU_DIM = 102;
    private static final int MENU_HIDE = 103;
    private static final int MENU_AUTO = 201;
    private static final int MENU_CLEAN = 202;
    private static final int MENU_DIAGNOSTICS = 301;
    private static final AtomicBoolean mountPending = new AtomicBoolean();
    private static WeakReference<TextView> controlRef = new WeakReference<>(null);

    /** Injection point: called when YouTube materializes native toolbar ImageViews. */
    public static void onToolbarImageView(ImageView imageView) {
        if (imageView == null || !EternalHistorySettings.ENABLED.get()) return;
        TextView existing = controlRef.get();
        if (existing != null && existing.getParent() != null) {
            refreshLabel(existing);
            return;
        }
        if (!mountPending.compareAndSet(false, true)) return;
        imageView.post(() -> {
            try { mountOnce(imageView); }
            finally { mountPending.set(false); }
        });
    }

    private static void mountOnce(ImageView imageView) {
        try {
            TextView existing = controlRef.get();
            if (existing != null && existing.getParent() != null) {
                refreshLabel(existing);
                return;
            }
            ViewGroup host = findToolbarHost(imageView);
            if (host == null) return;

            TextView control = new TextView(host.getContext());
            control.setGravity(Gravity.CENTER);
            control.setTextSize(11);
            control.setSingleLine(true);
            control.setPadding(Dim.dp6, 0, Dim.dp6, 0);
            control.setMinWidth(Dim.dp48);
            control.setClickable(true);
            control.setFocusable(true);
            control.setContentDescription("Eternal YouTube History 표시 및 나중에 볼 정리");
            control.setTextColor(ThemeUtils.getAppForegroundColor());
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.RECTANGLE);
            bg.setCornerRadius(Dim.dp16);
            bg.setColor(ThemeUtils.getEditTextBackground());
            control.setBackground(bg);
            control.setElevation(Dim.dp(2));
            refreshLabel(control);
            control.setOnClickListener(v -> showMenu(control));
            control.setOnLongClickListener(v -> { showDiagnostics(); return true; });

            host.addView(control, 0);
            ViewGroup.LayoutParams params = control.getLayoutParams();
            if (params != null) {
                params.width = Dim.dp(62);
                params.height = Dim.dp36;
                control.setLayoutParams(params);
            }
            controlRef = new WeakReference<>(control);
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal toolbar mount deferred: " + t.getMessage());
        }
    }

    private static ViewGroup findToolbarHost(ImageView imageView) {
        View current = imageView;
        ViewGroup fallback = null;
        for (int depth = 0; depth < 7; depth++) {
            ViewParent parent = current.getParent();
            if (!(parent instanceof ViewGroup group)) break;
            String name = group.getClass().getName();
            if (name.contains("ActionMenu") || name.contains("Toolbar")) return group;
            if (group.getChildCount() >= 2 && fallback == null) fallback = group;
            current = group;
        }
        return fallback;
    }

    private static void showMenu(TextView anchor) {
        PopupMenu popup = new PopupMenu(anchor.getContext(), anchor);
        Menu menu = popup.getMenu();
        String mode = EternalHistorySettings.feedMode();
        menu.add(0, MENU_SHOW, 0, mark("표시", "none".equals(mode)));
        menu.add(0, MENU_DIM, 1, mark("흐리게", "dim".equals(mode)));
        menu.add(0, MENU_HIDE, 2, mark("숨기기", "hide".equals(mode)));
        int threshold = EternalHistorySettings.watchLaterCleanupProgressPercent();
        boolean auto = EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get();
        menu.add(1, MENU_AUTO, 10, "나중에 볼 자동 정리: " + (auto ? "켜짐" : "꺼짐") + " (" + threshold + "%+)");
        menu.add(1, MENU_CLEAN, 11, threshold + "%+ 나중에 볼 지금 정리…");
        menu.add(2, MENU_DIAGNOSTICS, 20, "Eternal 진단 정보");
        popup.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case MENU_SHOW -> setMode("none");
                case MENU_DIM -> setMode("dim");
                case MENU_HIDE -> setMode("hide");
                case MENU_AUTO -> {
                    boolean enabled = !EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.get();
                    EternalHistorySettings.WATCH_LATER_AUTO_CLEANUP.save(enabled);
                    EternalWatchLaterJobService.refreshSchedule();
                    if (enabled) EternalWatchLaterJobService.runNow();
                    Utils.showToastShort("나중에 볼 자동 정리: " + (enabled ? "켜짐" : "꺼짐"));
                }
                case MENU_CLEAN -> EternalCleanupCoordinator.previewAndConfirm(Utils.getActivity());
                case MENU_DIAGNOSTICS -> showDiagnostics();
                default -> { return false; }
            }
            refreshControl();
            return true;
        });
        popup.show();
    }

    private static void setMode(String mode) {
        EternalHistorySettings.FEED_MODE.save(mode);
        if (!"none".equals(mode)) EternalHistoryClient.ensureFeedCacheStarted();
        Utils.showToastShort("시청 영상 표시: " + modeName(mode));
    }

    private static String mark(String text, boolean selected) { return selected ? "✓ " + text : text; }
    private static String modeName(String mode) {
        if ("dim".equals(mode)) return "흐리게";
        if ("hide".equals(mode)) return "숨기기";
        return "표시";
    }

    private static void refreshControl() {
        TextView control = controlRef.get();
        if (control != null) refreshLabel(control);
    }

    private static void refreshLabel(TextView control) {
        String mode = EternalHistorySettings.feedMode();
        control.setText("E·" + ("dim".equals(mode) ? "흐림" : "hide".equals(mode) ? "숨김" : "표시"));
    }

    private static void showDiagnostics() {
        Activity activity = Utils.getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                .setTitle("Eternal 진단")
                .setMessage(EternalWatchLaterCleaner.diagnosticSummary()
                        + "\n" + EternalCleanupCoordinator.diagnosticSummary()
                        + "\n" + EternalWatchLaterAutoSweep.diagnosticSummary())
                .setPositiveButton(android.R.string.ok, null)
                .show());
    }

    private EternalHistoryToolbar() { }
}
