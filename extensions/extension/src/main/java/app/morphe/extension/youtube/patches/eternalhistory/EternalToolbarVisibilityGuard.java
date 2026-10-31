package app.morphe.extension.youtube.patches.eternalhistory;

import android.app.Activity;
import android.graphics.Rect;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.ImageView;

import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicBoolean;

import app.morphe.extension.shared.Logger;
import app.morphe.extension.shared.Utils;
import app.morphe.extension.shared.ui.Dim;
import app.morphe.extension.youtube.shared.ShortsPlayerState;

/**
 * Keeps Eternal's root-level E control visually attached to YouTube's real native header.
 *
 * The v1.10 crash quarantine deliberately avoids NavigationBar and browse-id callbacks. This guard
 * therefore uses only two passive/cached signals that do not re-enter host navigation state:
 * the toolbar ImageView YouTube is already rendering and Morphe's cached ShortsPlayerState.
 */
@SuppressWarnings("unused")
public final class EternalToolbarVisibilityGuard {
    private static final String CONTROL_TAG = "eternal-history-floating-control";
    private static final AtomicBoolean bindPending = new AtomicBoolean();
    private static WeakReference<ImageView> anchorRef = new WeakReference<>(null);
    private static WeakReference<View> controlRef = new WeakReference<>(null);
    private static WeakReference<ViewGroup> boundRootRef = new WeakReference<>(null);
    private static ViewTreeObserver.OnPreDrawListener preDrawListener;

    // All callbacks that use these geometry buffers run on YouTube's main/UI thread. Reuse them so
    // the pre-draw guard does not allocate Rect/int[] objects every rendered frame.
    private static final Rect visibleRect = new Rect();
    private static final int[] rootLocation = new int[2];
    private static final int[] anchorLocation = new int[2];
    private static final int[] candidateLocation = new int[2];
    private static final int[] currentAnchorLocation = new int[2];

    /** Passive bytecode injection point. Never mutates YouTube's toolbar hierarchy. */
    public static void onToolbarImageView(ImageView imageView) {
        EternalHistoryToolbar.onToolbarImageView(imageView);
        if (imageView == null) return;
        imageView.post(() -> {
            try {
                rememberBestAnchor(imageView);
                bindToCurrentRoot();
            } catch (Throwable t) {
                Logger.printDebug(() -> "Eternal toolbar visibility anchor ignored: " + safeMessage(t));
            }
        });
    }

    private static void rememberBestAnchor(ImageView candidate) {
        if (!basicAnchor(candidate)) return;
        ImageView current = anchorRef.get();
        if (!basicAnchor(current)) {
            anchorRef = new WeakReference<>(candidate);
            return;
        }
        try {
            candidate.getLocationInWindow(candidateLocation);
            current.getLocationInWindow(currentAnchorLocation);
            // Match EternalHistoryToolbar: the left-most live native action icon is the stable
            // geometry anchor for the empty slot immediately before YouTube's action cluster.
            if (candidateLocation[0] < currentAnchorLocation[0]) {
                anchorRef = new WeakReference<>(candidate);
            }
        } catch (Throwable ignored) { }
    }

    private static boolean basicAnchor(ImageView anchor) {
        return anchor != null && anchor.isAttachedToWindow() && anchor.isShown()
                && anchor.getWidth() > 0 && anchor.getHeight() > 0;
    }

    private static void bindToCurrentRoot() {
        if (!bindPending.compareAndSet(false, true)) return;
        Utils.runOnMainThreadDelayed(() -> {
            try {
                Activity activity = Utils.getActivity();
                if (activity == null || activity.isFinishing()) return;
                View content = activity.findViewById(android.R.id.content);
                if (!(content instanceof ViewGroup root)) return;

                ViewGroup previous = boundRootRef.get();
                if (previous == root && preDrawListener != null
                        && root.getViewTreeObserver().isAlive()) {
                    sync(root);
                    return;
                }
                detachPrevious();
                boundRootRef = new WeakReference<>(root);
                preDrawListener = () -> {
                    try { sync(root); }
                    catch (Throwable t) {
                        Logger.printDebug(() -> "Eternal toolbar visibility sync ignored: " + safeMessage(t));
                    }
                    return true;
                };
                ViewTreeObserver observer = root.getViewTreeObserver();
                if (observer.isAlive()) observer.addOnPreDrawListener(preDrawListener);
                sync(root);
            } finally {
                bindPending.set(false);
            }
        }, 0L);
    }

    private static void detachPrevious() {
        ViewGroup previous = boundRootRef.get();
        ViewTreeObserver.OnPreDrawListener listener = preDrawListener;
        if (previous != null && listener != null) {
            try {
                ViewTreeObserver observer = previous.getViewTreeObserver();
                if (observer.isAlive()) observer.removeOnPreDrawListener(listener);
            } catch (Throwable ignored) { }
        }
        preDrawListener = null;
        boundRootRef = new WeakReference<>(null);
        controlRef = new WeakReference<>(null);
    }

    /** O(1) on steady-state frames; direct-child scan happens only while the control is absent/replaced. */
    private static View findControl(ViewGroup root) {
        View cached = controlRef.get();
        if (cached != null && cached.getParent() == root && cached.isAttachedToWindow()) return cached;
        for (int i = 0; i < root.getChildCount(); i++) {
            View child = root.getChildAt(i);
            if (CONTROL_TAG.equals(child.getTag())) {
                controlRef = new WeakReference<>(child);
                return child;
            }
        }
        controlRef = new WeakReference<>(null);
        return null;
    }

    private static void sync(ViewGroup root) {
        View control = findControl(root);
        if (control == null) return;

        if (!EternalHistorySettings.ENABLED.get()) {
            setVisible(control, false);
            return;
        }

        // Shorts has no recommendation-list presentation surface. Use Morphe's cached player-state
        // signal rather than the quarantined NavigationBar/browse callbacks.
        if (ShortsPlayerState.isOpen()) {
            setVisible(control, false);
            return;
        }

        ImageView anchor = anchorRef.get();
        if (!captureVisibleGeometry(root, anchor)) {
            setVisible(control, false);
            return;
        }

        int width = control.getWidth() > 0 ? control.getWidth() : Dim.dp(36);
        int height = control.getHeight() > 0 ? control.getHeight() : Dim.dp32;
        float x = anchorLocation[0] - rootLocation[0] - width - Dim.dp8;
        float y = anchorLocation[1] - rootLocation[1] + (anchor.getHeight() - height) / 2f;
        if (x < Dim.dp4 || x + width > root.getWidth() - Dim.dp4
                || y < 0 || y > Dim.dp(160)) {
            setVisible(control, false);
            return;
        }

        // Avoid invalidating the root hierarchy when YouTube has not moved the native toolbar.
        if (Math.abs(control.getX() - x) > 0.5f) control.setX(x);
        if (Math.abs(control.getY() - y) > 0.5f) control.setY(y);
        setVisible(control, true);
    }

    /**
     * isShown() alone is insufficient: YouTube can keep the toolbar view attached/shown while its
     * parent is translated or clipped off-screen. Capture global geometry once per frame and leave
     * the coordinates in reusable buffers for sync() to consume without duplicate location calls.
     */
    private static boolean captureVisibleGeometry(ViewGroup root, ImageView anchor) {
        if (root == null || !basicAnchor(anchor) || root.getWidth() <= 0
                || anchor.getWindowVisibility() != View.VISIBLE || anchor.getAlpha() <= 0.05f) return false;
        try {
            if (!anchor.getGlobalVisibleRect(visibleRect)) return false;
            int requiredWidth = Math.max(1, (anchor.getWidth() * 3) / 4);
            int requiredHeight = Math.max(1, (anchor.getHeight() * 3) / 4);
            if (visibleRect.width() < requiredWidth || visibleRect.height() < requiredHeight) return false;

            root.getLocationInWindow(rootLocation);
            anchor.getLocationInWindow(anchorLocation);
            int relativeX = anchorLocation[0] - rootLocation[0];
            int relativeY = anchorLocation[1] - rootLocation[1];
            return relativeX >= 0 && relativeX < root.getWidth()
                    && relativeY >= 0 && relativeY <= Dim.dp(160);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static void setVisible(View control, boolean visible) {
        int desired = visible ? View.VISIBLE : View.GONE;
        if (control.getVisibility() != desired) control.setVisibility(desired);
    }

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return message == null ? (t == null ? "unknown" : t.getClass().getSimpleName()) : message;
    }

    private EternalToolbarVisibilityGuard() { }
}
