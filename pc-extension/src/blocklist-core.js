(() => {
  'use strict';

  // Pure, DOM-free channel/keyword block-list matching (BlockTube-style).
  // Shared by content.js (card renderer), options.js (validation) and node self-tests.
  //
  // Channel lines:  @handle  |  UCxxxxxxxxxxxxxxxxxxxxxx (channel id)  |  exact channel display name
  // Keyword lines:  plain text (case-insensitive substring)  |  /regex/flags
  // Lines starting with # are comments. Matching is NFKC + lower-case normalized.

  const MAX_LINES = 2000;
  const MAX_LINE_LENGTH = 300;
  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

  function norm(value) {
    let s = String(value ?? '');
    try { s = s.normalize('NFKC'); } catch { }
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function splitLines(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/);
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const line = String(item ?? '').trim().slice(0, MAX_LINE_LENGTH);
      if (!line || line.startsWith('#')) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= MAX_LINES) break;
    }
    return out;
  }

  function handleFromHref(href) {
    const s = String(href || '');
    const m = s.match(/(?:^|youtube\.com)\/(@[^/?#\s]+)/i);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }

  function channelIdFromHref(href) {
    const m = String(href || '').match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
    return m ? m[1] : null;
  }

  function parseRegexLine(line) {
    const m = line.match(/^\/(.+)\/([a-z]*)$/i);
    if (!m) return null;
    const flags = [...new Set((m[2] || '').replace(/[^imsu]/g, '') + 'i')].join('');
    try { return new RegExp(m[1], flags); }
    catch (error) { return { error: String(error?.message || error) }; }
  }

  function compile({ channels = [], keywords = [], enabled = true } = {}) {
    const handles = new Set();
    const ids = new Set();
    const names = new Set();
    const words = [];
    const regexes = [];
    const errors = [];

    for (const line of splitLines(channels)) {
      if (CHANNEL_ID_RE.test(line)) { ids.add(line); continue; }
      const fromUrl = channelIdFromHref(line);
      if (fromUrl) { ids.add(fromUrl); continue; }
      const handle = line.startsWith('@') ? line : handleFromHref(line);
      if (handle) { handles.add(norm(handle)); continue; }
      names.add(norm(line));
    }
    for (const line of splitLines(keywords)) {
      const re = parseRegexLine(line);
      if (re instanceof RegExp) regexes.push({ re, source: line });
      else if (re?.error) errors.push({ line, error: re.error });
      else {
        const n = norm(line);
        if (n) words.push({ text: n, source: line });
      }
    }

    const active = Boolean(enabled) && (handles.size + ids.size + names.size + words.length + regexes.length) > 0;

    function match(meta = {}) {
      if (!active || !meta) return null;
      const channelId = meta.channelId || channelIdFromHref(meta.channelHref);
      if (channelId && ids.has(channelId)) return { kind: 'channel', value: channelId };
      const handle = meta.channelHandle || handleFromHref(meta.channelHref);
      if (handle && handles.has(norm(handle))) return { kind: 'channel', value: handle };
      const name = norm(meta.channelName);
      if (name && (names.has(name) || handles.has(norm(`@${name.replace(/\s+/g, '')}`)))) {
        return { kind: 'channel', value: meta.channelName };
      }
      const title = String(meta.title || '');
      if (title) {
        const t = norm(title);
        for (const w of words) if (t.includes(w.text)) return { kind: 'keyword', value: w.source };
        for (const r of regexes) {
          r.re.lastIndex = 0;
          if (r.re.test(title)) return { kind: 'regex', value: r.source };
        }
      }
      return null;
    }

    // Cheap stable identity so the renderer can cache per-card decisions.
    const signature = active
      ? [...ids, '|', ...handles, '|', ...names, '|', ...words.map(w => w.text), '|', ...regexes.map(r => r.source)].join('\u0001')
      : '';

    return {
      active,
      match,
      errors,
      signature,
      counts: { channels: handles.size + ids.size + names.size, keywords: words.length + regexes.length }
    };
  }

  /** Best identifier to store when the user blocks a channel from a card/link. */
  function channelEntryFromMeta(meta = {}) {
    const handle = meta.channelHandle || handleFromHref(meta.channelHref);
    if (handle) return handle;
    const id = meta.channelId || channelIdFromHref(meta.channelHref);
    if (id) return id;
    const name = String(meta.channelName || '').trim();
    return name || null;
  }

  function addLine(list, line) {
    const lines = splitLines(list);
    const value = String(line || '').trim();
    if (!value) return lines;
    if (!lines.some(x => x.toLowerCase() === value.toLowerCase())) lines.push(value);
    return lines;
  }

  globalThis.EYHBlocklistCore = Object.freeze({
    compile, splitLines, norm, handleFromHref, channelIdFromHref, channelEntryFromMeta, addLine
  });
})();
