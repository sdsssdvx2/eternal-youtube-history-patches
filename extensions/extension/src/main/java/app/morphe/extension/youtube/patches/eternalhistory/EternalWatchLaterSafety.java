package app.morphe.extension.youtube.patches.eternalhistory;

/**
 * Fail-closed boundary for Watch Later maintenance.
 *
 * Legacy direct-delete paths stay permanently locked. The newer safe path is allowed only because
 * it writes a crash-safe full snapshot/journal before deletion, re-enumerates the complete playlist,
 * revalidates videoId/setVideoId immediately before every request, stops on the first anomaly, and
 * preserves an undo path. Keeping these capabilities separate prevents a UI unlock from silently
 * reopening the old destructive implementation.
 */
final class EternalWatchLaterSafety {
    static final boolean LEGACY_DESTRUCTIVE_CLEANUP_LOCKED = true;
    static final boolean SAFE_TRANSACTIONAL_CLEANUP_AVAILABLE = true;
    static final String MESSAGE = "기존 직접 삭제 경로는 잠겨 있고, 검증·저널·되돌리기가 있는 안전 정리만 사용합니다.";

    /** Compatibility name used by legacy per-video cleanup. Intentionally remains true. */
    static boolean isLocked() {
        return LEGACY_DESTRUCTIVE_CLEANUP_LOCKED;
    }

    static boolean safeCleanupAvailable() {
        return SAFE_TRANSACTIONAL_CLEANUP_AVAILABLE;
    }

    private EternalWatchLaterSafety() { }
}
