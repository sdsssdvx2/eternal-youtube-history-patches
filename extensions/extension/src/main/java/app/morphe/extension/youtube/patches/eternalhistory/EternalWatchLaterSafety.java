package app.morphe.extension.youtube.patches.eternalhistory;

/**
 * Emergency fail-closed boundary for destructive Watch Later maintenance.
 *
 * Cleanup stays locked until every delete has a durable pre-delete playlist snapshot, an exact
 * videoId/setVideoId journal, a fresh identity revalidation immediately before edit_playlist, and
 * a tested restore path. Read-only Eternal history/progress features remain available.
 */
final class EternalWatchLaterSafety {
    static final boolean DESTRUCTIVE_CLEANUP_LOCKED = true;
    static final String MESSAGE = "나중에 볼 정리는 복구 안전장치가 준비될 때까지 잠겨 있습니다.";

    static boolean isLocked() {
        return DESTRUCTIVE_CLEANUP_LOCKED;
    }

    private EternalWatchLaterSafety() { }
}
