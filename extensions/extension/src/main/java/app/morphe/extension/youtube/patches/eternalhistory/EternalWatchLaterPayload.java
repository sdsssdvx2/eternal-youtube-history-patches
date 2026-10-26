package app.morphe.extension.youtube.patches.eternalhistory;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Conservative parser for old renderer and modern lockup Watch Later browse payloads. */
final class EternalWatchLaterPayload {
    private static final Set<String> ITEM_KEYS = Set.of(
            "playlistVideoRenderer",
            "playlistPanelVideoRenderer",
            "playlistVideoViewModel",
            "lockupViewModel",
            "videoViewModel",
            "videoLockupViewModel",
            "compactVideoViewModel",
            "mediaLockupRenderer"
    );

    static void collect(Object node, Map<String, String> bySetVideoId,
                        List<String> continuations, int depth) {
        if (node == null || depth > 64) return;
        if (node instanceof JSONObject obj) {
            parseDirectPair(obj, bySetVideoId);
            addToken(obj.optJSONObject("continuationCommand"), "token", continuations);
            addToken(obj.optJSONObject("nextContinuationData"), "continuation", continuations);
            addToken(obj.optJSONObject("reloadContinuationData"), "continuation", continuations);

            Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object child = obj.opt(key);
                if (child instanceof JSONObject childObj && ITEM_KEYS.contains(key)) {
                    parseItemTree(childObj, bySetVideoId);
                }
                if (child instanceof JSONObject || child instanceof JSONArray) {
                    collect(child, bySetVideoId, continuations, depth + 1);
                }
            }
        } else if (node instanceof JSONArray arr) {
            for (int i = 0; i < arr.length(); i++) {
                collect(arr.opt(i), bySetVideoId, continuations, depth + 1);
            }
        }
    }

    private static void parseDirectPair(JSONObject obj, Map<String, String> out) {
        String videoId = firstValidVideoId(
                obj.optString("videoId", ""),
                obj.optString("contentId", ""));
        String setVideoId = firstValidSetVideoId(
                obj.optString("setVideoId", ""),
                obj.optString("playlistSetVideoId", ""));
        if (videoId != null && setVideoId != null) out.put(setVideoId, videoId);
    }

    /**
     * Modern lockup models often put the video id near the root while the playlist setVideoId is
     * nested in a menu/service endpoint. Pair them only when each subtree contains exactly one
     * valid candidate. Ambiguous subtrees fail closed instead of risking removal of the wrong row.
     */
    private static void parseItemTree(JSONObject item, Map<String, String> out) {
        Set<String> videos = new HashSet<>();
        Set<String> setIds = new HashSet<>();
        collectIds(item, videos, setIds, 0);
        if (videos.size() == 1 && setIds.size() == 1) {
            out.put(setIds.iterator().next(), videos.iterator().next());
        }
    }

    private static void collectIds(Object node, Set<String> videos, Set<String> setIds, int depth) {
        if (node == null || depth > 20 || videos.size() > 1 || setIds.size() > 1) return;
        if (node instanceof JSONObject obj) {
            addVideo(videos, obj.optString("videoId", ""));
            addVideo(videos, obj.optString("contentId", ""));
            addSetId(setIds, obj.optString("setVideoId", ""));
            addSetId(setIds, obj.optString("playlistSetVideoId", ""));
            Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                Object child = obj.opt(keys.next());
                if (child instanceof JSONObject || child instanceof JSONArray) {
                    collectIds(child, videos, setIds, depth + 1);
                }
            }
        } else if (node instanceof JSONArray arr) {
            for (int i = 0; i < arr.length(); i++) collectIds(arr.opt(i), videos, setIds, depth + 1);
        }
    }

    private static void addVideo(Set<String> out, String value) {
        if (validVideoId(value)) out.add(value);
    }

    private static void addSetId(Set<String> out, String value) {
        if (validSetVideoId(value)) out.add(value);
    }

    private static void addToken(JSONObject obj, String key, List<String> out) {
        if (obj == null) return;
        String token = obj.optString(key, "");
        if (validToken(token)) out.add(token);
    }

    private static String firstValidVideoId(String... values) {
        for (String value : values) if (validVideoId(value)) return value;
        return null;
    }

    private static String firstValidSetVideoId(String... values) {
        for (String value : values) if (validSetVideoId(value)) return value;
        return null;
    }

    static boolean validVideoId(String value) {
        return value != null && value.matches("^[A-Za-z0-9_-]{11}$");
    }

    static boolean validSetVideoId(String value) {
        if (value == null || value.length() < 4 || value.length() > 512) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x21 || c > 0x7e) return false;
        }
        return true;
    }

    static boolean validToken(String value) {
        return value != null && !value.trim().isEmpty() && value.length() < 8192;
    }

    private EternalWatchLaterPayload() { }
}
