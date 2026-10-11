(() => {
  const SOURCE = 'eternal-youtube-history-page';
  const TARGET = 'eternal-youtube-history-content';

  function cfg(key, fallback = undefined) {
    try {
      return globalThis.ytcfg?.get?.(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function getClientContext() {
    const full = cfg('INNERTUBE_CONTEXT');
    if (full?.client) return structuredClone(full);

    return {
      client: {
        clientName: cfg('INNERTUBE_CLIENT_NAME', 'WEB'),
        clientVersion: cfg('INNERTUBE_CLIENT_VERSION', '2.20261001.00.00'),
        hl: cfg('HL', document.documentElement.lang?.split('-')[0] || 'en'),
        gl: cfg('GL', 'US')
      }
    };
  }

  async function sha1Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function readCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function authHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Bootstrap-Logged-In': 'true',
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME', 1)),
      'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION', '')),
      'X-Origin': location.origin
    };

    const authUser = cfg('SESSION_INDEX');
    if (authUser !== undefined && authUser !== null && authUser !== '') {
      headers['X-Goog-AuthUser'] = String(authUser);
    }

    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID') || readCookie('__Secure-1PAPISID');
    if (sapisid) {
      const ts = Math.floor(Date.now() / 1000);
      const hash = await sha1Hex(`${ts} ${sapisid} ${location.origin}`);
      headers.Authorization = `SAPISIDHASH ${ts}_${hash}`;
    }

    const pageId = cfg('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = String(pageId);
    const visitor = cfg('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    return headers;
  }

  function textFromRuns(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') return obj.trim() || null;
    if (typeof obj.simpleText === 'string') return obj.simpleText.trim() || null;
    if (typeof obj.content === 'string') return obj.content.trim() || null;
    if (Array.isArray(obj.runs)) return obj.runs.map(r => r?.text || '').join('').trim() || null;
    return null;
  }

  function extractVideoIdFromAny(node) {
    if (!node || typeof node !== 'object') return null;
    const direct = node.videoId || node.video_id || node.contentId || node.content_id;
    if (typeof direct === 'string' && /^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;

    const ep = node.navigationEndpoint || node.endpoint || node.onTap?.innertubeCommand || node.onTap ||
      node.rendererContext?.commandContext?.onTap?.innertubeCommand;
    const vid = ep?.watchEndpoint?.videoId || ep?.reelWatchEndpoint?.videoId ||
      ep?.commandMetadata?.webCommandMetadata?.url?.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1];
    if (vid) return vid;

    const url = node.url || node.canonicalBaseUrl || ep?.commandMetadata?.webCommandMetadata?.url;
    if (typeof url === 'string') {
      const m = url.match(/(?:[?&]v=|\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  }

  function extractProgressPct(root) {
    if (!root || typeof root !== 'object') return null;
    const seen = new WeakSet();
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < 1200) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      visited += 1;
      if (Object.prototype.hasOwnProperty.call(node, 'percentDurationWatched')) {
        const n = Number(node.percentDurationWatched);
        if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return null;
  }

  function rendererToRecord(renderer, dateLabel) {
    if (!renderer || typeof renderer !== 'object') return null;
    const videoId = extractVideoIdFromAny(renderer);
    if (!videoId) return null;

    const lockupMeta = renderer.metadata?.lockupMetadataViewModel;
    const title = textFromRuns(renderer.title) || textFromRuns(renderer.headline) ||
      textFromRuns(lockupMeta?.title) || renderer.accessibilityText || null;
    const channelName = textFromRuns(renderer.ownerText) || textFromRuns(renderer.shortBylineText) ||
      textFromRuns(renderer.longBylineText) || textFromRuns(renderer.byline) || null;
    const channelId = renderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
      renderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
      renderer.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null;

    return { videoId, title, channelName, channelId, historyDateLabel: dateLabel || null, maxProgressPct: extractProgressPct(renderer) };
  }

  function selectedBrowseContent(root) {
    const candidates = [
      root?.contents?.twoColumnBrowseResultsRenderer?.tabs,
      root?.contents?.singleColumnBrowseResultsRenderer?.tabs
    ];
    for (const tabs of candidates) {
      if (!Array.isArray(tabs)) continue;
      const selected = tabs.find(t => t?.tabRenderer?.selected && t?.tabRenderer?.content) ||
        tabs.find(t => t?.tabRenderer?.content);
      if (selected?.tabRenderer?.content) return selected.tabRenderer.content;
    }
    return null;
  }

  function pushContainer(out, node, kind) {
    if (!node || typeof node !== 'object') return;
    const items = node.contents || node.items || node.continuationItems;
    if (!Array.isArray(items)) return;
    out.push({ items, continuations: node.continuations || [], kind });
  }

  function historyFeedContainers(root) {
    const out = [];
    const selected = selectedBrowseContent(root);
    pushContainer(out, selected?.sectionListRenderer, 'initial-section-list');
    pushContainer(out, selected?.richGridRenderer, 'initial-rich-grid');

    pushContainer(out, root?.continuationContents?.sectionListContinuation, 'continuation-section-list');
    pushContainer(out, root?.continuationContents?.gridContinuation, 'continuation-grid');

    for (const key of ['onResponseReceivedActions', 'onResponseReceivedEndpoints', 'onResponseReceivedCommands']) {
      const actions = root?.[key];
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        pushContainer(out, action?.appendContinuationItemsAction, `${key}:append`);
        pushContainer(out, action?.reloadContinuationItemsCommand, `${key}:reload-command`);
        pushContainer(out, action?.reloadContinuationItemsAction, `${key}:reload-action`);
      }
    }

    return out;
  }

  function normalizeHistoryDateLabel(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const now = new Date();
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (/^오늘$/i.test(s)) return ymd(now);
    if (/^어제$/i.test(s)) return ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const m = s.match(/(?:(\d{4})\s*[.\-/년]\s*)?(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/);
    if (!m) return s;
    let year = m[1] ? Number(m[1]) : now.getFullYear();
    const month = Number(m[2]), day = Number(m[3]);
    if (!m[1]) {
      const candidate = new Date(year, month - 1, day);
      if (candidate.getTime() > now.getTime() + 7 * 86400000) year -= 1;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return s;
    return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  function itemSectionDate(section, fallback = null) {
    const raw = textFromRuns(section?.header?.itemSectionHeaderRenderer?.title) ||
      textFromRuns(section?.header?.itemSectionHeaderRenderer?.header) || fallback;
    return normalizeHistoryDateLabel(raw) || fallback;
  }

  const RENDERER_KEYS = [
    'videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistVideoRenderer',
    'reelItemRenderer', 'shortsLockupViewModel', 'shortsLockupViewModelV2', 'videoWithContextRenderer', 'lockupViewModel'
  ];

  function collectHistoryRecordsFromItems(items) {
    const out = [];
    const seenNodes = new WeakSet();

    function walk(node, dateLabel = null) {
      if (!node || typeof node !== 'object') return;
      if (seenNodes.has(node)) return;
      seenNodes.add(node);

      if (node.itemSectionRenderer) {
        const section = node.itemSectionRenderer;
        const nextDate = itemSectionDate(section, dateLabel);
        if (Array.isArray(section.contents)) {
          for (const child of section.contents) walk(child, nextDate);
        }
        return;
      }

      for (const key of RENDERER_KEYS) {
        if (node[key]) {
          const rec = rendererToRecord(node[key], dateLabel);
          if (rec) out.push(rec);
        }
      }

      // Only traverse wrappers that can legitimately live inside a history feed item.
      const wrappers = [
        node.richItemRenderer?.content,
        node.shelfRenderer?.content,
        node.reelShelfRenderer?.items,
        node.reelShelfRenderer?.contents,
        node.gridShelfViewModel?.items,
        node.gridShelfViewModel?.contents,
        node.verticalListRenderer?.items,
        node.horizontalListRenderer?.items,
        node.richShelfRenderer?.contents,
        node.richGridRenderer?.contents
      ];
      for (const wrapper of wrappers) {
        if (Array.isArray(wrapper)) for (const child of wrapper) walk(child, dateLabel);
        else if (wrapper && typeof wrapper === 'object') walk(wrapper, dateLabel);
      }
    }

    for (const item of items || []) walk(item, null);

    const dedup = new Map();
    for (const r of out) {
      const old = dedup.get(r.videoId);
      if (!old) dedup.set(r.videoId, r);
      else dedup.set(r.videoId, {
        ...old,
        title: old.title || r.title,
        channelName: old.channelName || r.channelName,
        channelId: old.channelId || r.channelId,
        historyDateLabel: old.historyDateLabel || r.historyDateLabel,
        maxProgressPct: (() => {
          const norm = value => {
            if (value === null || value === undefined || value === '') return null;
            const n = Number(value);
            return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
          };
          const aa = norm(old.maxProgressPct);
          const bb = norm(r.maxProgressPct);
          return bb == null ? aa : (aa == null ? bb : Math.max(aa, bb));
        })()
      });
    }
    return [...dedup.values()];
  }

  function continuationTokenFromNode(node) {
    if (!node || typeof node !== 'object') return null;
    return node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
      node?.continuationItemViewModel?.continuationCommand?.token ||
      node?.continuationItemView?.continuationCommand?.token ||
      node?.continuationCommand?.token ||
      node?.nextContinuationData?.continuation ||
      node?.reloadContinuationData?.continuation || null;
  }

  function topLevelContinuations(container) {
    const out = [];
    const push = (token, source) => {
      if (typeof token !== 'string' || token.length <= 10) return;
      if (!out.some(x => x.token === token)) out.push({ token, source });
    };

    // Only inspect continuation objects that are direct children of the feed body.
    // Do not recurse into shelves/renderers: those can have unrelated continuations.
    for (let i = 0; i < (container?.items || []).length; i++) {
      const item = container.items[i];
      const token = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
        item?.continuationItemViewModel?.continuationCommand?.token ||
        item?.continuationItemView?.continuationCommand?.token || null;
      push(token, `item:${i}`);
    }

    for (let i = 0; i < (container?.continuations || []).length; i++) {
      const c = container.continuations[i];
      push(c?.nextContinuationData?.continuation || c?.reloadContinuationData?.continuation || continuationTokenFromNode(c), `continuations:${i}`);
    }
    return out;
  }

  function analyzeFeedContainers(containers) {
    const analyzed = [];
    for (let i = 0; i < containers.length; i++) {
      const c = containers[i];
      const records = collectHistoryRecordsFromItems(c.items);
      const continuations = topLevelContinuations(c);
      analyzed.push({ ...c, index: i, records, continuations });
    }
    return analyzed;
  }

  function chooseHistoryContainer(analyzed) {
    const preferred = analyzed.filter(c => c.records.length > 0);
    const pool = preferred.length ? preferred : analyzed;
    if (!pool.length) return null;

    // Prefer a container that both contains history records and exposes a body continuation.
    // If several exist, prefer the one with more unique history records. This avoids selecting
    // unrelated header/filter actions that may coexist in onResponseReceived* arrays.
    return [...pool].sort((a, b) => {
      const aHas = a.continuations.length ? 1 : 0;
      const bHas = b.continuations.length ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.records.length !== b.records.length) return b.records.length - a.records.length;
      return a.index - b.index;
    })[0];
  }

  function tokenFingerprint(token) {
    if (!token) return null;
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function pageSignature(records) {
    return records.slice(0, 8).map(r => r.videoId).join('|') + '::' + records.slice(-8).map(r => r.videoId).join('|');
  }

  function parseHistoryResponse(json, responseSource = 'innertube-api') {
    const containers = historyFeedContainers(json);
    if (!containers.length) return null;

    const analyzed = analyzeFeedContainers(containers);
    const chosen = chooseHistoryContainer(analyzed);
    if (!chosen) return null;

    const dedup = new Map(chosen.records.map(r => [r.videoId, r]));
    const cleanRecords = [...dedup.values()];
    const chosenContinuation = chosen.continuations.at(-1) || null;

    return {
      records: cleanRecords,
      continuation: chosenContinuation?.token || null,
      signature: pageSignature(cleanRecords),
      containerKinds: containers.map(c => c.kind),
      chosenKind: chosen.kind,
      continuationSource: chosenContinuation?.source || null,
      continuationFingerprint: tokenFingerprint(chosenContinuation?.token || null),
      candidateCount: chosen.continuations.length,
      responseSource,
      containerSummary: analyzed.map(c => ({
        kind: c.kind,
        records: c.records.length,
        continuationCount: c.continuations.length
      }))
    };
  }

  function extractBalancedJsonAfterMarker(text, marker) {
    const idx = text.indexOf(marker);
    if (idx < 0) return null;
    const start = text.indexOf('{', idx + marker.length);
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); }
          catch { return null; }
        }
      }
    }
    return null;
  }

  function extractInitialDataFromHtml(html) {
    const markers = [
      'var ytInitialData =',
      'window["ytInitialData"] =',
      "window['ytInitialData'] =",
      'window.ytInitialData =',
      'ytInitialData ='
    ];
    for (const marker of markers) {
      const parsed = extractBalancedJsonAfterMarker(html, marker);
      if (parsed) return parsed;
    }
    return null;
  }


  function loadedHistoryBootstrap() {
    try {
      const data = globalThis.ytInitialData;
      if (!data || typeof data !== 'object') return null;
      return parseHistoryResponse(data, 'loaded-top-level-history');
    } catch {
      return null;
    }
  }

  async function fetchFreshHistoryBootstrap() {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await fetch(`/feed/history?eyh_sync=${encodeURIComponent(nonce)}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (!res.ok) return null;

    const html = await res.text();
    const initialData = extractInitialDataFromHtml(html);
    if (!initialData) return null;
    return parseHistoryResponse(initialData, 'fresh-history-html');
  }

  async function fetchHistoryPage({ continuation = null, useLoadedPage = false }) {
    // A freshly-created top-level /feed/history tab is the closest equivalent to the
    // manual page refresh that YouTube uses to expose newly-synced account history.
    if (!continuation && useLoadedPage) {
      const loaded = loadedHistoryBootstrap();
      if (loaded?.records?.length) return loaded;
    }

    // Fallback for normal existing tabs: silently fetch a new /feed/history document.
    if (!continuation) {
      try {
        const fresh = await fetchFreshHistoryBootstrap();
        if (fresh?.records?.length) return fresh;
      } catch {
        // Fall through to the direct Innertube request below.
      }
    }

    const apiKey = cfg('INNERTUBE_API_KEY');
    if (!apiKey) throw new Error('YouTube INNERTUBE_API_KEY를 찾지 못했습니다. YouTube 페이지를 새로고침한 뒤 다시 시도하세요.');

    const body = { context: getClientContext() };
    if (continuation) body.continuation = continuation;
    else body.browseId = 'FEhistory';

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await fetch(`/youtubei/v1/browse?key=${encodeURIComponent(apiKey)}&prettyPrint=false&eyh_sync=${encodeURIComponent(nonce)}`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        ...(await authHeaders()),
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`YouTube History 요청 실패: HTTP ${res.status}${txt ? ` / ${txt.slice(0, 200)}` : ''}`);
    }

    const json = await res.json();
    const parsed = parseHistoryResponse(json, 'innertube-api');
    if (!parsed) {
      throw new Error('YouTube History 피드 영역을 찾지 못했습니다. YouTube 응답 형식이 바뀌었을 수 있습니다.');
    }
    return parsed;
  }

  async function syncHistory(requestId, maxPages = 3, useLoadedPage = false) {
    const all = new Map();
    const seenTokens = new Set();
    const seenSignatures = new Set();
    let continuation = null;
    let pages = 0;
    let loopDetected = false;
    let stopReason = null;
    const pageStats = [];
    let latestRecord = null;

    do {
      if (continuation && seenTokens.has(continuation)) {
        loopDetected = true;
        stopReason = 'same-continuation-token';
        break;
      }
      if (continuation) seenTokens.add(continuation);

      const page = await fetchHistoryPage({ continuation, useLoadedPage: useLoadedPage && pages === 0 });
      pages += 1;

      if (pages === 1 && page.records.length) latestRecord = page.records[0];

      const before = all.size;
      for (const r of page.records) if (!all.has(r.videoId)) all.set(r.videoId, r);
      const added = all.size - before;
      pageStats.push({
        page: pages,
        records: page.records.length,
        added,
        kinds: page.containerKinds,
        chosenKind: page.chosenKind,
        continuationSource: page.continuationSource,
        continuationFingerprint: page.continuationFingerprint,
        candidateCount: page.candidateCount,
        responseSource: page.responseSource,
        containerSummary: page.containerSummary
      });

      if (pages > 1 && page.signature && seenSignatures.has(page.signature)) {
        loopDetected = true;
        stopReason = 'same-page-signature';
        break;
      }
      if (page.signature) seenSignatures.add(page.signature);

      continuation = page.continuation;
      window.postMessage({ source: SOURCE, target: TARGET, type: 'EYH_HISTORY_PROGRESS', requestId, pages, count: all.size, added }, '*');

      if (!continuation) {
        stopReason = 'end-of-history';
        break;
      }
      if (pages > 1 && page.records.length > 0 && added === 0) {
        loopDetected = true;
        stopReason = 'zero-new-records';
        break;
      }

      await new Promise(r => setTimeout(r, 120));
    } while (pages < maxPages);

    return {
      records: [...all.values()],
      pages,
      hasMore: Boolean(continuation) && !loopDetected,
      loopDetected,
      stopReason: stopReason || (pages >= maxPages ? 'page-limit' : null),
      pageStats,
      latestRecord
    };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== TARGET || msg.target !== SOURCE || msg.type !== 'EYH_REQUEST_HISTORY') return;
    const requestId = msg.requestId;
    try {
      const result = await syncHistory(requestId, Math.max(1, Math.min(Number(msg.maxPages) || 3, 500)), Boolean(msg.useLoadedPage));
      window.postMessage({ source: SOURCE, target: TARGET, type: 'EYH_HISTORY_RESULT', requestId, ok: true, ...result }, '*');
    } catch (error) {
      window.postMessage({ source: SOURCE, target: TARGET, type: 'EYH_HISTORY_RESULT', requestId, ok: false, error: String(error?.message || error) }, '*');
    }
  });
})();
