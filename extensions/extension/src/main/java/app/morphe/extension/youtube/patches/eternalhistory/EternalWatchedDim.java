package app.morphe.extension.youtube.patches.eternalhistory;

/**
 * Carries one watched-card dim decision across Morphe's Litho filter call to the immediately
 * following component return on the same layout worker thread.
 *
 * No View matching, global FIFO, accessibility text, or server request is involved. The bytecode
 * patch consumes this flag and writes alpha into that exact component's Litho NodeInfo before the
 * component leaves YouTube's parser.
 */
@SuppressWarnings("unused")
public final class EternalWatchedDim {
    private static final ThreadLocal<Boolean> PREPARED_DIM = new ThreadLocal<>();

    private EternalWatchedDim() { }

    /** Called once at the beginning of Eternal's classification for every Litho component. */
    static void beginCardDecision() {
        // remove(), rather than set(false), keeps ordinary/unwatched components allocation-free.
        PREPARED_DIM.remove();
    }

    /** Called only after the protobuf videoId + local cache positively identify a watched card. */
    static void markCard(String videoId, String accessibilityId, String accessibilityText) {
        if (EternalHistorySettings.isDimMode()) {
            PREPARED_DIM.set(Boolean.TRUE);
        }
    }

    /**
     * Injection point immediately before YouTube returns the original unfiltered component.
     * Consuming also clears the thread-local, so a decision can never leak into a later card.
     */
    public static boolean consumePreparedDim() {
        Boolean prepared = PREPARED_DIM.get();
        PREPARED_DIM.remove();
        return Boolean.TRUE.equals(prepared);
    }
}
