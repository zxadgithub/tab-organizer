const DEFAULT_SETTINGS = {
  globalEnabled: true,
  dedupeEnabled: true,
  confirmMergeOnDuplicate: true,
  sortEnabled: true,
  ignoreHash: true,
  ignoreCommonTrackingParams: true,
  domainFilterMode: "all",
  domainFilterList: "",
  domainSplitEnabled: true,
  domainSplitThreshold: 5
};

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "msclkid",
  "oly_anon_id",
  "oly_enc_id",
  "vero_id"
]);

const PENDING_MERGES_KEY = "pendingMerges";
const DOMAIN_MERGE_PREFS_KEY = "domainMergePrefs";
const PAUSED_DOMAINS_KEY = "pausedDomains";
const DEDUPE_COOLDOWN_MS = 1800;
const TAB_CHECK_DEBOUNCE_MS = 240;

let isOrganizing = false;
let pendingOrganizeByWindow = new Map();
let pendingTabCheckByTab = new Map();
let recentDedupeActions = new Map();
let pausedDomainsCache = {};
let pausedDomainsLoaded = false;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
  await ensurePausedDomainsCache();
  await cleanPendingMerges();
  await organizeAllWindows();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes[PAUSED_DOMAINS_KEY]) return;
  pausedDomainsCache = normalizePausedDomains(changes[PAUSED_DOMAINS_KEY].newValue);
  pausedDomainsLoaded = true;
});

chrome.tabs.onCreated.addListener((tab) => {
  scheduleTabCheck(tab.id, tab.windowId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    scheduleTabCheck(tabId, tab.windowId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const timeoutId = pendingTabCheckByTab.get(tabId);
  if (timeoutId) clearTimeout(timeoutId);
  pendingTabCheckByTab.delete(tabId);
  void cleanPendingMerges();
});

chrome.tabs.onActivated.addListener(async ({ windowId }) => {
  const settings = await getSettings();
  if (!settings.globalEnabled) return;
  await ensurePausedDomainsCache();
  if (settings.sortEnabled || settings.domainSplitEnabled) {
    scheduleWindowOrganize(windowId);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-manager") {
    void openOrFocusManager();
  }
});

async function handleMessage(message) {
  if (message?.type === "getSettings") {
    return { ok: true, settings: await getSettings() };
  }

  if (message?.type === "saveSettings") {
    await chrome.storage.sync.set(normalizeInputSettings(message.settings || {}));
    await organizeAllWindows();
    return { ok: true, settings: await getSettings() };
  }

  if (message?.type === "organizeNow") {
    const settings = await getSettings();
    if (!settings.globalEnabled) return { ok: false, error: "全局开关已关闭" };
    await organizeAllWindows();
    return { ok: true };
  }

  if (message?.type === "getPendingMerges") {
    return { ok: true, pendingMerges: await getPendingMerges() };
  }

  if (message?.type === "resolvePendingMerge") {
    await resolvePendingMerge(message.mergeId, message.action);
    return { ok: true, pendingMerges: await getPendingMerges() };
  }

  if (message?.type === "focusTab") {
    const tabId = Number.parseInt(message.tabId, 10);
    if (!Number.isInteger(tabId)) return { ok: false, error: "Invalid tab id." };
    const tab = await safeGetTab(tabId);
    if (!tab) return { ok: false, error: "Tab not found." };
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  }

  if (message?.type === "getPausedDomains") {
    return { ok: true, pausedDomains: await getPausedDomains() };
  }

  if (message?.type === "pauseDomain") {
    const domain = String(message.domain || "").trim().toLowerCase();
    const minutes = Number.parseInt(message.minutes, 10);
    if (!domain) return { ok: false, error: "Invalid domain." };
    if (!Number.isFinite(minutes) || minutes < 1) return { ok: false, error: "Invalid minutes." };
    const expiresAt = Date.now() + minutes * 60 * 1000;
    await setDomainPausedUntil(domain, expiresAt);
    return { ok: true, pausedDomains: await getPausedDomains() };
  }

  if (message?.type === "unpauseDomain") {
    const domain = String(message.domain || "").trim().toLowerCase();
    if (!domain) return { ok: false, error: "Invalid domain." };
    await clearPausedDomain(domain);
    return { ok: true, pausedDomains: await getPausedDomains() };
  }

  return { ok: false, error: "Unknown message type." };
}

async function openOrFocusManager() {
  const managerUrl = chrome.runtime.getURL("manager.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url === managerUrl);
  if (existing?.id && Number.isInteger(existing.windowId)) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: managerUrl });
}

async function getSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return normalizeInputSettings(settings);
}

function normalizeInputSettings(input) {
  const normalized = { ...input };
  const threshold = Number.parseInt(normalized.domainSplitThreshold, 10);
  normalized.domainSplitThreshold = Number.isFinite(threshold) && threshold >= 2 ? threshold : 5;

  if (!["all", "exclude", "include"].includes(normalized.domainFilterMode)) {
    normalized.domainFilterMode = "all";
  }

  normalized.domainFilterList = String(normalized.domainFilterList || "");
  normalized.globalEnabled = Boolean(normalized.globalEnabled);
  normalized.confirmMergeOnDuplicate = Boolean(normalized.confirmMergeOnDuplicate);
  normalized.dedupeEnabled = Boolean(normalized.dedupeEnabled);
  normalized.sortEnabled = Boolean(normalized.sortEnabled);
  normalized.ignoreHash = Boolean(normalized.ignoreHash);
  normalized.ignoreCommonTrackingParams = Boolean(normalized.ignoreCommonTrackingParams);
  normalized.domainSplitEnabled = Boolean(normalized.domainSplitEnabled);
  return normalized;
}

function scheduleTabCheck(tabId, windowId) {
  const existing = pendingTabCheckByTab.get(tabId);
  if (existing) clearTimeout(existing);

  const timeoutId = setTimeout(async () => {
    pendingTabCheckByTab.delete(tabId);
    try {
      const settings = await getSettings();
      if (!settings.globalEnabled) return;
      await ensurePausedDomainsCache();

      if (settings.dedupeEnabled) {
        const duplicateHandled = await dedupeTab(tabId, settings);
        if (duplicateHandled) return;
      }

      if (settings.domainSplitEnabled) {
        const routed = await routeTabToDedicatedDomainWindow(tabId, settings);
        if (routed) return;
      }

      if ((settings.sortEnabled || settings.domainSplitEnabled) && Number.isInteger(windowId)) {
        scheduleWindowOrganize(windowId);
      }
    } catch (error) {
      if (!isExpectedTabError(error)) {
        console.error(error);
      }
    }
  }, TAB_CHECK_DEBOUNCE_MS);

  pendingTabCheckByTab.set(tabId, timeoutId);
}

function scheduleWindowOrganize(windowId) {
  if (!Number.isInteger(windowId)) return;

  clearTimeout(pendingOrganizeByWindow.get(windowId));
  const timeoutId = setTimeout(async () => {
    pendingOrganizeByWindow.delete(windowId);
    try {
      await ensurePausedDomainsCache();
      await organizeWindow(windowId);
    } catch (error) {
      if (!isExpectedTabError(error)) {
        console.error(error);
      }
    }
  }, 450);
  pendingOrganizeByWindow.set(windowId, timeoutId);
}

async function organizeAllWindows() {
  const settings = await getSettings();
  if (!settings.globalEnabled) return;
  if (!settings.sortEnabled && !settings.dedupeEnabled && !settings.domainSplitEnabled) return;
  await ensurePausedDomainsCache();

  const windows = await chrome.windows.getAll({ populate: false });
  for (const chromeWindow of windows) {
    if (settings.dedupeEnabled && !settings.confirmMergeOnDuplicate) {
      await dedupeWindow(chromeWindow.id, settings);
    }
    if (settings.sortEnabled || settings.domainSplitEnabled) {
      await organizeWindow(chromeWindow.id, settings);
    }
  }
}

async function dedupeTab(tabId, settings) {
  const tab = await safeGetTab(tabId);
  if (!tab || !isSortableUrl(tab.url)) return false;
  if (!shouldProcessUrl(tab.url, settings)) return false;

  const currentKey = normalizeUrl(tab.url, settings);
  if (!currentKey) return false;
  if (isCooldownActive(currentKey)) return false;

  const tabs = await chrome.tabs.query({});
  const duplicate = tabs
    .filter((candidate) => candidate.id !== tab.id)
    .filter((candidate) => isSortableUrl(candidate.url))
    .filter((candidate) => shouldProcessUrl(candidate.url, settings))
    .filter((candidate) => normalizeUrl(candidate.url, settings) === currentKey)
    .sort(compareDuplicatePriority(tab))[0];

  if (!duplicate) return false;

  const domain = getSortDomain(tab.url);
  if (settings.confirmMergeOnDuplicate) {
    // "Confirm before merge" should always queue for manual review and never
    // auto-merge based on historical domain preferences.
    await queuePendingMerge(tab, duplicate);
    setCooldown(currentKey);
    return false;
  }

  await activateAndMerge({
    removeTabId: tab.id,
    keepTabId: duplicate.id,
    sourceWindowId: tab.windowId,
    keepWindowId: duplicate.windowId,
    focusWindow: false
  });
  setCooldown(currentKey);
  return true;
}

async function dedupeWindow(windowId, settings) {
  const tabs = await chrome.tabs.query({ windowId });
  const seen = new Map();

  for (const tab of tabs) {
    if (!isSortableUrl(tab.url) || !shouldProcessUrl(tab.url, settings)) continue;
    const key = normalizeUrl(tab.url, settings);
    if (!key) continue;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, tab);
      continue;
    }

    const keep = existing.active ? existing : tab.active ? tab : existing;
    const remove = keep.id === existing.id ? tab : existing;
    seen.set(key, keep);

    if (!remove.active) {
      await chrome.tabs.remove(remove.id);
    }
  }
}

async function organizeWindow(windowId, suppliedSettings) {
  if (isOrganizing) return;
  isOrganizing = true;

  try {
    const settings = suppliedSettings || (await getSettings());
    if (!settings.globalEnabled) return;

    const tabs = await chrome.tabs.query({ windowId });
    const pinnedCount = tabs.filter((tab) => tab.pinned).length;
    const nonPinnedTabs = tabs.filter((tab) => !tab.pinned);

    if (settings.sortEnabled) {
      // Keep domain groups in first-seen order (not alphabetically) to avoid
      // newly opened domains being pulled into the middle of the tab strip.
      const domainFirstSeenOrder = new Map();
      let orderCursor = 0;
      for (const tab of [...nonPinnedTabs].sort((a, b) => a.index - b.index)) {
        if (!isSortableUrl(tab.url) || !shouldProcessUrl(tab.url, settings)) continue;
        const domain = getSortDomain(tab.url);
        if (!domainFirstSeenOrder.has(domain)) {
          domainFirstSeenOrder.set(domain, orderCursor);
          orderCursor += 1;
        }
      }

      const orderedTabs = [...nonPinnedTabs].sort((a, b) => {
        const aEligible = isSortableUrl(a.url) && shouldProcessUrl(a.url, settings);
        const bEligible = isSortableUrl(b.url) && shouldProcessUrl(b.url, settings);
        const aDomain = getSortDomain(a.url);
        const bDomain = getSortDomain(b.url);

        if (aEligible && bEligible) {
          const aOrder = domainFirstSeenOrder.get(aDomain) ?? Number.MAX_SAFE_INTEGER;
          const bOrder = domainFirstSeenOrder.get(bDomain) ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.index - b.index;
        }

        if (aEligible !== bEligible) return aEligible ? -1 : 1;
        return a.index - b.index;
      });

      for (let index = 0; index < orderedTabs.length; index += 1) {
        const tab = orderedTabs[index];
        await chrome.tabs.move(tab.id, { windowId, index: pinnedCount + index });
      }
    }

    if (settings.domainSplitEnabled) {
      await splitCrowdedDomainIntoNewWindow(windowId, settings);
    }
  } finally {
    isOrganizing = false;
  }
}

async function splitCrowdedDomainIntoNewWindow(windowId, settings) {
  const threshold = settings.domainSplitThreshold;
  if (threshold < 2) return;

  const allTabs = await chrome.tabs.query({});
  const eligibleTabs = allTabs.filter((tab) => !tab.pinned)
    .filter((tab) => isSortableUrl(tab.url))
    .filter((tab) => shouldProcessUrl(tab.url, settings));
  if (eligibleTabs.length === 0) return;

  const tabsByDomain = new Map();
  for (const tab of eligibleTabs) {
    const domain = getSortDomain(tab.url);
    if (!tabsByDomain.has(domain)) tabsByDomain.set(domain, []);
    tabsByDomain.get(domain).push(tab);
  }

  const crowded = [...tabsByDomain.entries()]
    .filter(([, domainTabs]) => domainTabs.length > threshold)
    .sort((a, b) => b[1].length - a[1].length)[0];
  if (!crowded) return;

  const [domain, domainTabs] = crowded;
  const sourceWindowIds = [...new Set(domainTabs.map((tab) => tab.windowId))];
  const existingDedicatedWindowId = await findDedicatedDomainWindowId(domain, settings, null);

  if (Number.isInteger(existingDedicatedWindowId)) {
    const tabsToMove = domainTabs
      .filter((tab) => tab.windowId !== existingDedicatedWindowId)
      .sort((a, b) => a.index - b.index);
    if (tabsToMove.length === 0) return;

    const activeTabFromCurrentWindow = tabsToMove.find((tab) => tab.windowId === windowId && tab.active);
    const moved = await chrome.tabs.move(tabsToMove.map((tab) => tab.id), {
      windowId: existingDedicatedWindowId,
      index: -1
    });
    const movedTabs = Array.isArray(moved) ? moved : [moved];
    if (activeTabFromCurrentWindow) {
      const activeMovedTab = movedTabs.find((tab) => tab.id === activeTabFromCurrentWindow.id);
      if (activeMovedTab?.id) {
        await chrome.tabs.update(activeMovedTab.id, { active: true });
        await chrome.windows.update(existingDedicatedWindowId, { focused: true });
      }
    }

    scheduleWindowOrganize(existingDedicatedWindowId);
    for (const sourceId of sourceWindowIds) {
      if (sourceId !== existingDedicatedWindowId) scheduleWindowOrganize(sourceId);
    }
    return;
  }

  const [firstTab, ...restTabs] = domainTabs.sort((a, b) => a.index - b.index);
  const newWindow = await chrome.windows.create({ tabId: firstTab.id, focused: false });
  if (!newWindow?.id) return;

  if (restTabs.length > 0) {
    await chrome.tabs.move(restTabs.map((tab) => tab.id), { windowId: newWindow.id, index: -1 });
  }

  scheduleWindowOrganize(newWindow.id);
  for (const sourceId of sourceWindowIds) {
    if (sourceId !== newWindow.id) scheduleWindowOrganize(sourceId);
  }
}

async function routeTabToDedicatedDomainWindow(tabId, settings) {
  const tab = await safeGetTab(tabId);
  if (!tab || tab.pinned || !isSortableUrl(tab.url)) return false;
  if (!shouldProcessUrl(tab.url, settings)) return false;
  const shouldFollowFocus = Boolean(tab.active);

  const domain = getSortDomain(tab.url);
  if (!domain) return false;

  const targetWindowId = await findDedicatedDomainWindowId(domain, settings, tab.windowId);
  if (!Number.isInteger(targetWindowId)) return false;

  const moved = await chrome.tabs.move(tab.id, { windowId: targetWindowId, index: -1 });
  const movedTab = Array.isArray(moved) ? moved[0] : moved;
  if (shouldFollowFocus && movedTab?.id && Number.isInteger(targetWindowId)) {
    await chrome.tabs.update(movedTab.id, { active: true });
    await chrome.windows.update(targetWindowId, { focused: true });
  }
  scheduleWindowOrganize(targetWindowId);
  scheduleWindowOrganize(tab.windowId);
  return true;
}

async function findDedicatedDomainWindowId(domain, settings, excludeWindowId) {
  const windows = await chrome.windows.getAll({ populate: true });
  for (const chromeWindow of windows) {
    if (!chromeWindow?.id || chromeWindow.id === excludeWindowId) continue;
    const tabs = Array.isArray(chromeWindow.tabs) ? chromeWindow.tabs : [];
    if (tabs.length === 0) continue;

    const eligible = tabs
      .filter((tab) => !tab.pinned)
      .filter((tab) => isSortableUrl(tab.url))
      .filter((tab) => shouldProcessUrl(tab.url, settings));
    if (eligible.length < settings.domainSplitThreshold) continue;

    const sameDomain = eligible.every((tab) => getSortDomain(tab.url) === domain);
    if (!sameDomain) continue;

    return chromeWindow.id;
  }
  return null;
}

async function queuePendingMerge(newTab, existingTab) {
  const pending = await getPendingMerges();
  const alreadyQueued = pending.some((entry) => entry.newTabId === newTab.id);
  if (alreadyQueued) return;

  pending.push({
    id: `${Date.now()}-${newTab.id}`,
    newTabId: newTab.id,
    existingTabId: existingTab.id,
    newTabUrl: newTab.url || "",
    existingTabUrl: existingTab.url || "",
    domain: getSortDomain(newTab.url),
    createdAt: Date.now()
  });
  await chrome.storage.local.set({ [PENDING_MERGES_KEY]: pending });
}

async function resolvePendingMerge(mergeId, action) {
  const pending = await getPendingMerges();
  const target = pending.find((entry) => entry.id === mergeId);
  const remaining = pending.filter((entry) => entry.id !== mergeId);
  await chrome.storage.local.set({ [PENDING_MERGES_KEY]: remaining });
  if (!target) return;

  if (action === "alwaysMerge" || action === "alwaysKeep") {
    const prefs = await getDomainMergePrefs();
    prefs[target.domain] = action === "alwaysMerge" ? "merge" : "keep";
    await chrome.storage.local.set({ [DOMAIN_MERGE_PREFS_KEY]: prefs });
  }

  if (action === "keep" || action === "alwaysKeep") return;
  if (action !== "merge" && action !== "alwaysMerge") return;

  const newTab = await safeGetTab(target.newTabId);
  const existingTab = await safeGetTab(target.existingTabId);
  if (!newTab || !existingTab) return;

  await activateAndMerge({
    removeTabId: newTab.id,
    keepTabId: existingTab.id,
    sourceWindowId: newTab.windowId,
    keepWindowId: existingTab.windowId,
    focusWindow: true
  });
}

async function activateAndMerge({ removeTabId, keepTabId, sourceWindowId, keepWindowId, focusWindow }) {
  if (Number.isInteger(keepTabId) && sourceWindowId === keepWindowId) {
    await chrome.tabs.update(keepTabId, { active: true });
  }
  if (focusWindow && Number.isInteger(keepWindowId)) {
    await chrome.windows.update(keepWindowId, { focused: true });
  }
  await chrome.tabs.remove(removeTabId);
}

async function getPendingMerges() {
  const stored = await chrome.storage.local.get(PENDING_MERGES_KEY);
  const rawList = Array.isArray(stored[PENDING_MERGES_KEY]) ? stored[PENDING_MERGES_KEY] : [];
  const cleanList = [];

  for (const item of rawList) {
    const newTab = await safeGetTab(item.newTabId);
    const existingTab = await safeGetTab(item.existingTabId);
    if (!newTab || !existingTab) continue;

    cleanList.push({
      ...item,
      newTabUrl: newTab.url || item.newTabUrl || "",
      existingTabUrl: existingTab.url || item.existingTabUrl || "",
      domain: getSortDomain(newTab.url) || item.domain || ""
    });
  }

  if (cleanList.length !== rawList.length) {
    await chrome.storage.local.set({ [PENDING_MERGES_KEY]: cleanList });
  }
  return cleanList;
}

async function getDomainMergePrefs() {
  const stored = await chrome.storage.local.get(DOMAIN_MERGE_PREFS_KEY);
  return typeof stored[DOMAIN_MERGE_PREFS_KEY] === "object" && stored[DOMAIN_MERGE_PREFS_KEY]
    ? stored[DOMAIN_MERGE_PREFS_KEY]
    : {};
}

async function cleanPendingMerges() {
  await getPendingMerges();
}

function compareDuplicatePriority(newTab) {
  return (a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.windowId === newTab.windowId && b.windowId !== newTab.windowId) return -1;
    if (b.windowId === newTab.windowId && a.windowId !== newTab.windowId) return 1;
    return a.index - b.index;
  };
}

function normalizeUrl(rawUrl, settings) {
  if (!isSortableUrl(rawUrl)) return null;

  try {
    const url = new URL(rawUrl);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    if (settings.ignoreHash) url.hash = "";
    if (settings.ignoreCommonTrackingParams) {
      for (const key of [...url.searchParams.keys()]) {
        if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
      }
    }

    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isSortableUrl(rawUrl) {
  return typeof rawUrl === "string" && /^https?:\/\//i.test(rawUrl);
}

function getSortDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shouldProcessUrl(rawUrl, settings) {
  if (!isSortableUrl(rawUrl)) return false;
  const domain = getSortDomain(rawUrl);
  if (isDomainPaused(domain)) return false;

  const mode = settings.domainFilterMode;
  const rules = parseFilterRules(settings.domainFilterList);
  if (mode === "all" || rules.length === 0) return true;

  const matched = rules.some((rule) => urlMatchesRule(rawUrl, rule));
  if (mode === "exclude") return !matched;
  if (mode === "include") return matched;
  return true;
}

async function ensurePausedDomainsCache() {
  if (pausedDomainsLoaded) {
    await pruneExpiredPausedDomains();
    return;
  }
  const stored = await chrome.storage.local.get(PAUSED_DOMAINS_KEY);
  pausedDomainsCache = normalizePausedDomains(stored[PAUSED_DOMAINS_KEY]);
  pausedDomainsLoaded = true;
  await pruneExpiredPausedDomains();
}

function normalizePausedDomains(rawValue) {
  if (!rawValue || typeof rawValue !== "object") return {};
  const normalized = {};
  for (const [domain, ts] of Object.entries(rawValue)) {
    const cleanDomain = String(domain || "").trim().toLowerCase();
    const expiresAt = Number(ts);
    if (!cleanDomain || !Number.isFinite(expiresAt)) continue;
    normalized[cleanDomain] = expiresAt;
  }
  return normalized;
}

function isDomainPaused(domain) {
  if (!domain) return false;
  const expiresAt = Number(pausedDomainsCache[domain]);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt > Date.now()) return true;

  delete pausedDomainsCache[domain];
  void chrome.storage.local.set({ [PAUSED_DOMAINS_KEY]: pausedDomainsCache });
  return false;
}

async function pruneExpiredPausedDomains() {
  let changed = false;
  const now = Date.now();
  for (const [domain, expiresAt] of Object.entries(pausedDomainsCache)) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      delete pausedDomainsCache[domain];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [PAUSED_DOMAINS_KEY]: pausedDomainsCache });
  }
}

async function getPausedDomains() {
  await ensurePausedDomainsCache();
  return { ...pausedDomainsCache };
}

async function setDomainPausedUntil(domain, expiresAt) {
  await ensurePausedDomainsCache();
  pausedDomainsCache[domain] = expiresAt;
  await chrome.storage.local.set({ [PAUSED_DOMAINS_KEY]: pausedDomainsCache });
}

async function clearPausedDomain(domain) {
  await ensurePausedDomainsCache();
  if (!Object.hasOwn(pausedDomainsCache, domain)) return;
  delete pausedDomainsCache[domain];
  await chrome.storage.local.set({ [PAUSED_DOMAINS_KEY]: pausedDomainsCache });
}

function parseFilterRules(input) {
  return String(input || "")
    .split(/[\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseSingleRule)
    .filter(Boolean);
}

function parseSingleRule(text) {
  if (text.startsWith("/") && text.endsWith("/") && text.length > 2) {
    try {
      return { type: "regex", regex: new RegExp(text.slice(1, -1)) };
    } catch {
      return null;
    }
  }

  const value = text.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const slashIndex = value.indexOf("/");
  const domainPart = slashIndex === -1 ? value : value.slice(0, slashIndex);
  const pathPart = slashIndex === -1 ? "" : value.slice(slashIndex);

  if (!domainPart) return null;
  if (pathPart) {
    return { type: "domain_path", domainRule: normalizeDomainRule(domainPart), pathRule: normalizePathRule(pathPart) };
  }
  return { type: "domain", domainRule: normalizeDomainRule(domainPart) };
}

function normalizeDomainRule(value) {
  if (value.startsWith("*.")) {
    return { wildcard: value.slice(2) };
  }
  if (value.includes("*")) {
    const escaped = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return { regex: new RegExp(`^${escaped}$`) };
  }
  return { exact: value };
}

function normalizePathRule(value) {
  if (value.includes("*")) {
    const escaped = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return { regex: new RegExp(`^${escaped}$`) };
  }
  return { exact: value };
}

function urlMatchesRule(rawUrl, rule) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = (url.pathname || "/").toLowerCase();
    const full = `${host}${path}${url.search}`.toLowerCase();

    if (rule.type === "regex") return rule.regex.test(rawUrl) || rule.regex.test(full);
    if (rule.type === "domain") return hostMatchesDomainRule(host, rule.domainRule);
    if (rule.type === "domain_path") {
      return hostMatchesDomainRule(host, rule.domainRule) && pathMatchesRule(path, rule.pathRule);
    }
  } catch {
    return false;
  }
  return false;
}

function hostMatchesDomainRule(host, rule) {
  if (rule.exact) return host === rule.exact || host.endsWith(`.${rule.exact}`);
  if (rule.wildcard) return host === rule.wildcard || host.endsWith(`.${rule.wildcard}`);
  if (rule.regex) return rule.regex.test(host);
  return false;
}

function pathMatchesRule(path, rule) {
  if (rule.exact) return path === rule.exact;
  if (rule.regex) return rule.regex.test(path);
  return false;
}

function normalizeTitle(tab) {
  return (tab.title || tab.url || "").trim().toLowerCase();
}

function isCooldownActive(key) {
  pruneCooldownMap();
  const ts = recentDedupeActions.get(key);
  return Number.isFinite(ts) && (Date.now() - ts) < DEDUPE_COOLDOWN_MS;
}

function setCooldown(key) {
  recentDedupeActions.set(key, Date.now());
  pruneCooldownMap();
}

function pruneCooldownMap() {
  const now = Date.now();
  for (const [key, ts] of recentDedupeActions.entries()) {
    if ((now - ts) > DEDUPE_COOLDOWN_MS * 3) {
      recentDedupeActions.delete(key);
    }
  }
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function isExpectedTabError(error) {
  return /No tab with id|Tabs cannot be edited right now|Invalid tab ID/i.test(error?.message || "");
}
