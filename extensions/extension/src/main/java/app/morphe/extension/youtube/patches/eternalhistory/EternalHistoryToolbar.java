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

/**
 * Small Eternal control mounted beside YouTube's own visible header actions.
 *
 * v1.10.0-v1.10.4 moved this UI to an Activity-root floating overlay whose lifetime was driven by
 * bottom-navigation and browse callbacks. Real devices then began crashing exactly during those tab
 * transitions. v1.10.5 restores the v1.9.1 ownership boundary: YouTube creates/destroys its toolbar;
 * Eternal only reacts to an already-materialized ImageView and never touches the navigation host.
 */
@SuppressWarnings("unused")
public final class EternalHistoryToolbar {
    private static final int MENU_SHOW = 101;
    private static final int MENU_DIM = 102;
    private static final int MENU_HIDE = 103;
    private static final int MENU_CLEAN = 202;
    private static final int MENU_DIAGNOSTICS = 301;
    private static final String CONTROL_TAG = "eternal-history-toolbar-control";
    private static final AtomicBoolean mountPending = new AtomicBoolean();
    private static WeakReference<ViewGroup> hostRef = new WeakReference<>(null);
    private static WeakReference<TextView> controlRef = new WeakReference<>(null);

    /** Injection point: called only when YouTube materializes a native toolbar ImageView. */
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
            control.setContentDescription("Eternal YouTube History 표시 설정");
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

            // Let YouTube's concrete toolbar host create the correct LayoutParams subtype. Never add
            // a child to android.R.id.content or any navigation/root container.
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
            Logger.printDebug(() -> "Eternal toolbar mount deferred: " + safeMessage(t));
        }
    }

    private static ViewGroup findVisibleToolbarHost(ImageView imageView) {
        if (!isVisibleAndAttached(imageView)) return null;

        // Proven v1.9.1 hierarchy: ImageView -> menu item view -> shared toolbar/action host.
        ViewParent itemParent = imageView.getParent();
        if (itemParent instanceof View itemView && isVisibleAndAttached(itemView)) {
            ViewParent hostParent = itemView.getParent();
            if (hostParent instanceof ViewGroup host && isVisibleAndAttached(host)) return host;
        }

        // Conservative compatibility fallback. Never walk into arbitrary outer/root containers.
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
        try {
            PopupMenu popup = new PopupMenu(anchor.getContext(), anchor);
            Menu menu = popup.getMenu();
            EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.defaultProfile(false);
            String mode = effectiveMode(profile);
            menu.add(0, MENU_SHOW, 0, mark("표시", "none".equals(mode)));
            menu.add(0, MENU_DIM, 1, mark("흐리게", "dim".equals(mode)));
            menu.add(0, MENU_HIDE, 2, mark("숨기기", "hide".equals(mode)));
            menu.add(1, MENU_CLEAN, 10,
                    EternalHistorySettings.watchLaterCleanupProgressPercent() + "%+ 나중에 볼 지금 정리…");
            menu.add(2, MENU_DIAGNOSTICS, 20, "Eternal 진단 정보");
            popup.setOnMenuItemClickListener(item -> {
                switch (item.getItemId()) {
                    case MENU_SHOW -> setMode("none");
                    case MENU_DIM -> setMode("dim");
                    case MENU_HIDE -> setMode("hide");
                    case MENU_CLEAN -> EternalCleanupCoordinator.previewAndConfirm(Utils.getActivity());
                    case MENU_DIAGNOSTICS -> showDiagnostics();
                    default -> { return false; }
                }
                refreshControl();
                return true;
            });
            popup.show();
        } catch (Throwable t) {
            Logger.printException(() -> "Eternal toolbar menu failure", t);
            Utils.showToastShort("Eternal 표시 설정을 열지 못했습니다.");
        }
    }

    /**
     * Keep all v1.10.x page-profile SharedPreferences intact, but change only the common profile
     * while page-specific runtime tracking is dormant. This makes rollback non-destructive.
     */
    private static void setMode(String mode) {
        EternalHistorySettings.DEFAULT_DIM_ENABLED.save("dim".equals(mode));
        EternalHistorySettings.DEFAULT_HIDE_ENABLED.save("hide".equals(mode));
        if (!"none".equals(mode)) EternalHistoryClient.ensureFeedCacheStarted();
        Utils.showToastShort("시청 영상 표시: " + modeName(mode));
    }

    private static String effectiveMode(EternalSurfaceSettings.Profile profile) {
        if (profile.hideEnabled) return "hide";
        if (profile.dimEnabled) return "dim";
        return "none";
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
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.defaultProfile(false);
        String mode = effectiveMode(profile);
        control.setText("E·" + ("dim".equals(mode) ? "흐림" : "hide".equals(mode) ? "숨김" : "표시"));
        control.setContentDescription("Eternal YouTube History · " + modeName(mode)
                + " · 공통 기본값 · 흐림 " + profile.effectiveDimThreshold() + "%+"
                + " · 숨김 " + profile.effectiveHideThreshold() + "%+");
    }

    private static void showDiagnostics() {
        Activity activity = Utils.getActivity();
        if (activity == null || activity.isFinishing()) return;
        EternalSurfaceSettings.Profile profile = EternalSurfaceSettings.defaultProfile(false);
        activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                .setTitle("Eternal 진단")
                .setMessage("표시 런타임=v1.9.1 안정 구조 (공통 기본값)"
                        + "\n페이지별 v1.10.x 설정=보존됨 · 런타임 휴면"
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

    private EternalHistoryToolbar() { }
}
