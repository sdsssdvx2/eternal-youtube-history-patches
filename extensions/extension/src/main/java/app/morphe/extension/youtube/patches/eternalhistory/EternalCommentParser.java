package app.morphe.extension.youtube.patches.eternalhistory;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure parser for YouTube InnerTube {@code next} comment responses (WEB client). It mirrors the
 * PC extension's comment-search-core.js and knows both the legacy {@code commentRenderer} shape
 * and the 2024+ {@code commentViewModel} + {@code frameworkUpdates} entity shape. Unknown shapes
 * yield no comments instead of throwing.
 */
final class EternalCommentParser {
    static final class Comment {
        final String id;
        final String author;
        final String text;
        final String likes;
        final String published;
        final boolean isReply;
        final String haystack;

        Comment(String id, String author, String text, String likes, String published, boolean isReply) {
            this.id = id;
            this.author = author == null ? "" : author.trim();
            this.text = text == null ? "" : text;
            this.likes = likes == null ? "" : likes.trim();
            this.published = published == null ? "" : published.trim();
            this.isReply = isReply;
            this.haystack = norm(this.text + "\n" + this.author);
        }
    }

    static final class Page {
        final List<Comment> comments = new ArrayList<>();
        final List<String> replyTokens = new ArrayList<>();
        String next;
        String totalText;
        String visitorData;
    }

    private static final Pattern QUERY_TERM = Pattern.compile("\"([^\"]+)\"|(\\S+)");

    static String text(Object value) {
        if (value == null || value == JSONObject.NULL) return "";
        if (value instanceof String s) return s;
        if (!(value instanceof JSONObject o)) return "";
        if (o.has("simpleText")) return o.optString("simpleText", "");
        if (o.has("content")) return o.optString("content", "");
        JSONArray runs = o.optJSONArray("runs");
        if (runs == null) return "";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < runs.length(); i++) {
            JSONObject r = runs.optJSONObject(i);
            if (r != null) b.append(r.optString("text", ""));
        }
        return b.toString();
    }

    private static JSONObject path(JSONObject root, String... keys) {
        JSONObject cur = root;
        for (String k : keys) {
            if (cur == null) return null;
            cur = cur.optJSONObject(k);
        }
        return cur;
    }

    private static String nonEmpty(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    static String tokenOf(JSONObject node) {
        if (node == null) return null;
        JSONObject cmd = path(node, "continuationEndpoint", "continuationCommand");
        if (cmd != null && nonEmpty(cmd.optString("token", "")) != null) return cmd.optString("token");
        cmd = path(node, "button", "buttonRenderer", "command", "continuationCommand");
        if (cmd != null && nonEmpty(cmd.optString("token", "")) != null) return cmd.optString("token");
        cmd = node.optJSONObject("continuationCommand");
        if (cmd != null && nonEmpty(cmd.optString("token", "")) != null) return cmd.optString("token");
        return null;
    }

    /** First continuation token of the comment section in a {@code next} response for a videoId. */
    static String initialCommentsToken(JSONObject json) {
        if (json == null) return null;
        JSONObject results = path(json, "contents", "twoColumnWatchNextResults", "results", "results");
        JSONArray contents = results == null ? null : results.optJSONArray("contents");
        if (contents != null) {
            for (int i = 0; i < contents.length(); i++) {
                JSONObject section = path(contents.optJSONObject(i), "itemSectionRenderer");
                if (section == null) continue;
                String id = section.optString("sectionIdentifier", section.optString("targetId", ""));
                if (!id.isEmpty() && !id.toLowerCase(Locale.ROOT).contains("comment")) continue;
                String token = firstContinuation(section.optJSONArray("contents"));
                if (token != null) return token;
            }
        }
        JSONArray panels = json.optJSONArray("engagementPanels");
        if (panels != null) {
            for (int i = 0; i < panels.length(); i++) {
                JSONObject p = path(panels.optJSONObject(i), "engagementPanelSectionListRenderer");
                if (p == null) continue;
                String id = p.optString("panelIdentifier", p.optString("targetId", ""));
                if (!id.toLowerCase(Locale.ROOT).contains("comment")) continue;
                JSONObject list = path(p, "content", "sectionListRenderer");
                JSONArray sections = list == null ? null : list.optJSONArray("contents");
                if (sections == null) continue;
                for (int j = 0; j < sections.length(); j++) {
                    JSONObject s = path(sections.optJSONObject(j), "itemSectionRenderer");
                    String token = s == null ? null : firstContinuation(s.optJSONArray("contents"));
                    if (token != null) return token;
                }
            }
        }
        return null;
    }

    private static String firstContinuation(JSONArray items) {
        if (items == null) return null;
        for (int i = 0; i < items.length(); i++) {
            String token = tokenOf(path(items.optJSONObject(i), "continuationItemRenderer"));
            if (token != null) return token;
        }
        return null;
    }

    private static Map<String, JSONObject> entities(JSONObject json) {
        Map<String, JSONObject> map = new HashMap<>();
        JSONObject batch = path(json, "frameworkUpdates", "entityBatchUpdate");
        JSONArray mutations = batch == null ? null : batch.optJSONArray("mutations");
        if (mutations == null) return map;
        for (int i = 0; i < mutations.length(); i++) {
            JSONObject m = mutations.optJSONObject(i);
            JSONObject payload = m == null ? null : m.optJSONObject("payload");
            JSONObject comment = payload == null ? null : payload.optJSONObject("commentEntityPayload");
            if (comment != null) map.put(m.optString("entityKey", ""), comment);
        }
        return map;
    }

    private static Comment fromLegacy(JSONObject r, boolean isReply) {
        if (r == null) return null;
        String id = r.optString("commentId", "");
        if (id.isEmpty()) return null;
        return new Comment(id, text(r.opt("authorText")), text(r.opt("contentText")),
                text(r.opt("voteCount")), text(r.opt("publishedTimeText")), isReply);
    }

    private static Comment fromViewModel(JSONObject vm, Map<String, JSONObject> entities, boolean isReply) {
        if (vm == null) return null;
        JSONObject e = entities.get(vm.optString("commentKey", ""));
        if (e == null) return null;
        JSONObject props = e.optJSONObject("properties");
        if (props == null) props = new JSONObject();
        String id = props.optString("commentId", vm.optString("commentId", ""));
        if (id.isEmpty()) return null;
        JSONObject author = e.optJSONObject("author");
        JSONObject toolbar = e.optJSONObject("toolbar");
        return new Comment(id,
                author == null ? "" : author.optString("displayName", ""),
                text(props.opt("content")),
                toolbar == null ? "" : toolbar.optString("likeCountNotliked", ""),
                props.optString("publishedTime", ""),
                isReply || props.optInt("replyLevel", 0) > 0);
    }

    static Page parsePage(JSONObject json, boolean isReplyPage) {
        Page page = new Page();
        if (json == null) return page;
        JSONObject ctx = json.optJSONObject("responseContext");
        if (ctx != null) page.visitorData = nonEmpty(ctx.optString("visitorData", ""));
        Map<String, JSONObject> entities = entities(json);
        for (String key : new String[]{"onResponseReceivedEndpoints", "onResponseReceivedActions", "onResponseReceivedCommands"}) {
            JSONArray actions = json.optJSONArray(key);
            if (actions == null) continue;
            for (int i = 0; i < actions.length(); i++) {
                JSONObject a = actions.optJSONObject(i);
                if (a == null) continue;
                JSONObject holder = a.optJSONObject("reloadContinuationItemsCommand");
                if (holder == null) holder = a.optJSONObject("appendContinuationItemsAction");
                JSONArray items = holder == null ? null : holder.optJSONArray("continuationItems");
                if (items == null) continue;
                for (int j = 0; j < items.length(); j++) parseItem(items.optJSONObject(j), entities, isReplyPage, page);
            }
        }
        return page;
    }

    private static void parseItem(JSONObject item, Map<String, JSONObject> entities, boolean isReplyPage, Page page) {
        if (item == null) return;
        JSONObject header = item.optJSONObject("commentsHeaderRenderer");
        if (header != null) {
            String t = text(header.opt("countText"));
            if (t.isEmpty()) t = text(header.opt("commentsCount"));
            if (!t.isEmpty()) page.totalText = t;
            return;
        }
        JSONObject cont = item.optJSONObject("continuationItemRenderer");
        if (cont != null) {
            String token = tokenOf(cont);
            if (token != null) page.next = token;
            return;
        }
        JSONObject thread = item.optJSONObject("commentThreadRenderer");
        if (thread != null) {
            Comment c = fromLegacy(path(thread, "comment", "commentRenderer"), false);
            if (c == null) c = fromViewModel(path(thread, "commentViewModel", "commentViewModel"), entities, false);
            if (c != null) page.comments.add(c);
            JSONObject replies = path(thread, "replies", "commentRepliesRenderer");
            JSONArray rc = replies == null ? null : replies.optJSONArray("contents");
            if (rc != null) {
                for (int k = 0; k < rc.length(); k++) {
                    String token = tokenOf(path(rc.optJSONObject(k), "continuationItemRenderer"));
                    if (token != null) page.replyTokens.add(token);
                }
            }
            return;
        }
        Comment direct = fromLegacy(item.optJSONObject("commentRenderer"), isReplyPage);
        if (direct == null) direct = fromViewModel(item.optJSONObject("commentViewModel"), entities, isReplyPage);
        if (direct != null) page.comments.add(direct);
    }

    static String norm(String value) {
        String s = value == null ? "" : value;
        try { s = Normalizer.normalize(s, Normalizer.Form.NFKC); } catch (Throwable ignored) { }
        return s.toLowerCase(Locale.ROOT);
    }

    static List<String> queryTerms(String query) {
        List<String> terms = new ArrayList<>();
        Matcher m = QUERY_TERM.matcher(query == null ? "" : query);
        while (m.find() && terms.size() < 12) {
            String t = norm(m.group(1) != null ? m.group(1) : m.group(2)).trim();
            if (!t.isEmpty()) terms.add(t);
        }
        return terms;
    }

    /** AND search over comment text + author, original order, capped. */
    static List<Comment> search(List<Comment> comments, String query, int limit) {
        List<String> terms = queryTerms(query);
        List<Comment> out = new ArrayList<>();
        if (terms.isEmpty() || comments == null) return out;
        for (Comment c : comments) {
            boolean all = true;
            for (String t : terms) {
                if (!c.haystack.contains(t)) { all = false; break; }
            }
            if (all) {
                out.add(c);
                if (out.size() >= limit) break;
            }
        }
        return out;
    }

    private EternalCommentParser() { }
}
