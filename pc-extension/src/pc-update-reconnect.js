const UPDATE_RELOAD_STATE_KEY = 'eyhPcUpdateReloadState';

function isYouTubeTab(tab) {
  return Boolean(tab?.id != null && typeof tab.url === 'string' && tab.url.startsWith('https://www.youtube.com/'));
}

async function getReloadState() {
  const result = await chrome.storage.session.get({ [UPDATE_RELOAD_STATE_KEY]: null });
  return result[UPDATE_RELOAD_STATE_KEY];
}

async function saveReloadState(state) {
  await chrome.storage.session.set({ [UPDATE_RELOAD_STATE_KEY]: state });
}

async function reconnectTabForCurrentVersion(tab) {
  if (!isYouTubeTab(tab)) return;
  const version = chrome.runtime.getManifest().version;
  const state = await getReloadState();
  if (!state || state.version !== version) return;

  const reloaded = state.reloaded && typeof state.reloaded === 'object' ? { ...state.reloaded } : {};
  const key = String(tab.id);
  if (reloaded[key]) return;

  // Mark before reloading so activation/update events cannot create a reload loop.
  reloaded[key] = Date.now();
  await saveReloadState({ version, reloaded });

  // A tab that is already navigating will receive the new content scripts as part of that load.
  // Only completed documents need a one-time reload to replace invalidated old extension worlds.
  if (tab.status === 'complete') {
    await chrome.tabs.reload(tab.id, { bypassCache: false });
  }
}

chrome.runtime.onInstalled.addListener(details => {
  if (details?.reason !== 'update') return;
  (async () => {
    const version = chrome.runtime.getManifest().version;
    await saveReloadState({ version, reloaded: {} });
    const tabs = await chrome.tabs.query({
      active: true,
      url: ['https://www.youtube.com/*']
    });
    await Promise.allSettled(tabs.map(reconnectTabForCurrentVersion));
  })().catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  (async () => {
    const state = await getReloadState();
    if (!state || state.version !== chrome.runtime.getManifest().version) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await reconnectTabForCurrentVersion(tab);
  })().catch(() => {});
});
