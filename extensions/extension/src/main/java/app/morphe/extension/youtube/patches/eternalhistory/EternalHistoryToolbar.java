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
    private static final String CONTROL_TAG = "eternal-history-toolbar-control";
    private static final AtomicBoolean mountPending = new AtomicBoolean();
    private static WeakReference<ViewGroup> hostRef = new WeakReference<>(null);
    private static WeakReference<TextView> controlRef = new WeakReference<>(null);

    /** Injection point: called when YouTube materializes native toolbar ImageViews. */
    public static void onToolbarImageView(ImageView imageView) {
        if (imageView == null || !EternalHistorySettings.ENABLED.get()) return;
        if (!mountPending.compareAndSet(false, true)) return;
        imageView.post(() -> {
            try { mountOnVisibleToolbar(imageView); }
            finally { mountPending.set(false); }
        });
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
                    && existing.isAttachedToWindow()
                    && existing.isShown()) {
                refreshLabel(existing);
                return;
            }

            // v1.9.0 could latch onto an attached but hidden/transient YouTube toolbar and then
            // refuse every later mount. Detach that stale control so a currently visible toolbar
            // can take ownership. This also guarantees that only one Eternal control survives.
            if (existing != null && existing.getParent() instanceof ViewGroup oldHost) {
                oldHost.removeView(existing);
            }
            removeTaggedControls(host);

            TextView control = new TextView(host.getContext());
            control.setTag(CONTROL_TAG);
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

            // The direct item-parent host is the placement that was runtime-visible in v1.8.x.
            // Let that concrete host create its own LayoutParams subtype before sizing it.
            host.addView(control, 0);
            ViewGroup.LayoutParams params = control.getLayoutParams();
            if (params != null) {
                params.width = Dim.dp(62);
                params.height = Dim.dp36;
                control.setLayoutParams(params);
            }
            hostRef = new WeakReference<>(host);
            controlRef = new WeakReference<>(control);
        } catch (Throwable t) {
            Logger.printDebug(() -> "Eternal toolbar mount deferred: " + t.getMessage());
        }
    }

    private static ViewGroup findVisibleToolbarHost(ImageView imageView) {
        if (!isVisibleAndAttached(imageView)) return null;

        // Prefer the exact hierarchy that was proven visible before the v1.9.0 dedupe change:
        // ImageView -> menu item view -> shared toolbar/action host.
        ViewParent itemParent = imageView.getParent();
        if (itemParent instanceof View itemView && isVisibleAndAttached(itemView)) {
            ViewParent hostParent = itemView.getParent();
            if (hostParent instanceof ViewGroup host && isVisibleAndAttached(host)) {
                return host;
            }
        }

        // Conservative compatibility fallback for a future YouTube hierarchy change. Do not use
        // arbitrary outer containers: only a visible named ActionMenu/Toolbar ancestor is safe.
        View current = imageView;
        for (int depth = 0; depth < 6; depth++) {
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

    private static boolean isVisibleAndAttached(View view) {
        return view.isAttachedToWindow()
                && view.isShown()
                && view.getWindowVisibility() == View.VISIBLE;
    }

    private static void removeTaggedControls(ViewGroup host) {
        for (int i = host.getChildCount() - 1; i >= 0; i--) {
            View child = host.getChildAt(i);
            if (CONTROL_TAG.equals(child.getTag())) host.removeViewAt(i);
        }
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
