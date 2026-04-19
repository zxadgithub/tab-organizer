let allTabs = [];
let selectedTabIds = new Set();
let currentManagerTabId = null;
let undoToken = null;
let undoTimer = null;
let draggingTabId = null;
let draggingWindowId = null;
let pinnedDomains = new Set();
let collapsedDomains = new Set();
let pausedDomainsByDomain = {};
let refreshTimer = null;
let currentLanguage = "zh";
let lastRenderedDomains = [];
let lastFilteredTabIds = [];
let lastSelectedTabId = null;
let lastTabSnapshotSignature = "";
let lastPausedSnapshotSignature = "";

const PINNED_DOMAINS_KEY = "managerPinnedDomains";
const COLLAPSED_DOMAINS_KEY = "managerCollapsedDomains";
const LANGUAGE_KEY = "popupLanguage";
const TRANSLATIONS = {
  zh: {
    languageButton: "EN",
    languageTitle: "切换到英文",
    managerTitle: "Tab Manager",
    managerSub: "按域名分组，拖拽即可调整标签顺序",
    refresh: "刷新",
    collapseAll: "全部折叠",
    expandAll: "全部展开",
    closeSelected: "关闭选中",
    closeSelectedWithCount: "关闭选中 ({count})",
    searchLabel: "筛选",
    searchPlaceholder: "按域名、标题、URL 搜索",
    undo: "撤销",
    statTabs: "Tabs",
    statWindows: "Windows",
    statDomains: "Domains",
    statSelected: "Selected",
    activeCount: "Active: {count}",
    noMatchedTabs: "没有匹配的标签页。",
    groupMeta: "{tabs} tabs / {windows} windows",
    pinnedDomainSuffix: " · 已置顶域名",
    pausedUntilSuffix: " · 暂停至 {time}",
    pinDomain: "置顶域名",
    unpinDomain: "取消置顶域名",
    pauseDomain: "暂停处理",
    resumeDomain: "恢复处理",
    pausePrompt: "暂停该域名自动处理多少分钟？",
    pauseInvalidMinutes: "请输入 1-1440 的分钟数",
    selectAll: "全选",
    clearSelect: "撤销全选",
    closeGroup: "关闭本组",
    untitled: "(未命名)",
    tabMeta: "窗口 {windowId} · 位置 {index}{pinned}{active}",
    tabPinnedSuffix: " · 已置顶",
    tabActiveSuffix: " · 当前",
    rowTitle: "点击跳转到该标签页，或拖拽调整顺序",
    pinTab: "置顶",
    unpinTab: "取消置顶",
    close: "关闭",
    undoClosed: "已关闭 {count} 个标签页",
    otherDomain: "other"
  },
  en: {
    languageButton: "中",
    languageTitle: "Switch to Chinese",
    managerTitle: "Tab Manager",
    managerSub: "Group tabs by domain and drag to reorder.",
    refresh: "Refresh",
    collapseAll: "Collapse All",
    expandAll: "Expand All",
    closeSelected: "Close Selected",
    closeSelectedWithCount: "Close Selected ({count})",
    searchLabel: "Filter",
    searchPlaceholder: "Search by domain, title, or URL",
    undo: "Undo",
    statTabs: "Tabs",
    statWindows: "Windows",
    statDomains: "Domains",
    statSelected: "Selected",
    activeCount: "Active: {count}",
    noMatchedTabs: "No matching tabs.",
    groupMeta: "{tabs} tabs / {windows} windows",
    pinnedDomainSuffix: " · Pinned domain",
    pausedUntilSuffix: " · Paused until {time}",
    pinDomain: "Pin Domain",
    unpinDomain: "Unpin Domain",
    pauseDomain: "Pause Domain",
    resumeDomain: "Resume Domain",
    pausePrompt: "Pause this domain for how many minutes?",
    pauseInvalidMinutes: "Please enter 1-1440 minutes",
    selectAll: "Select All",
    clearSelect: "Clear Selection",
    closeGroup: "Close Group",
    untitled: "(Untitled)",
    tabMeta: "Window {windowId} · Index {index}{pinned}{active}",
    tabPinnedSuffix: " · Pinned",
    tabActiveSuffix: " · Active",
    rowTitle: "Click to focus this tab, or drag to reorder",
    pinTab: "Pin",
    unpinTab: "Unpin",
    close: "Close",
    undoClosed: "Closed {count} tabs",
    otherDomain: "other"
  }
};

const summaryEl = document.querySelector("#summary");
const groupsEl = document.querySelector("#groups");
const searchInputEl = document.querySelector("#searchInput");
const refreshButtonEl = document.querySelector("#refreshButton");
const collapseAllButtonEl = document.querySelector("#collapseAllButton");
const closeSelectedButtonEl = document.querySelector("#closeSelectedButton");
const languageToggleButton = document.querySelector("#languageToggle");
const groupTemplateEl = document.querySelector("#groupTemplate");
const tabTemplateEl = document.querySelector("#tabTemplate");
const undoBarEl = document.querySelector("#undoBar");
const undoTextEl = document.querySelector("#undoText");
const undoButtonEl = document.querySelector("#undoButton");

init();

async function init() {
  const current = await chrome.tabs.getCurrent();
  currentManagerTabId = current?.id ?? null;
  currentLanguage = await loadLanguage();
  applyLanguage();

  searchInputEl.addEventListener("input", render);
  refreshButtonEl.addEventListener("click", refreshData);
  collapseAllButtonEl.addEventListener("click", toggleCollapseAll);
  closeSelectedButtonEl.addEventListener("click", closeSelectedTabs);
  languageToggleButton.addEventListener("click", toggleLanguage);
  undoButtonEl.addEventListener("click", undoCloseTabs);
  document.addEventListener("keydown", handleKeydown);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleRefresh();
  });
  window.addEventListener("focus", scheduleRefresh);
  chrome.tabs.onCreated.addListener(scheduleRefresh);
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener(scheduleRefresh);
  chrome.tabs.onMoved.addListener(scheduleRefresh);
  chrome.tabs.onAttached.addListener(scheduleRefresh);
  chrome.tabs.onDetached.addListener(scheduleRefresh);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes[LANGUAGE_KEY]) return;
    const next = changes[LANGUAGE_KEY].newValue === "en" ? "en" : "zh";
    if (next === currentLanguage) return;
    currentLanguage = next;
    applyLanguage();
  });

  await loadPinnedDomains();
  await loadCollapsedDomains();
  await refreshData();
}

async function loadLanguage() {
  const stored = await chrome.storage.local.get(LANGUAGE_KEY);
  return stored[LANGUAGE_KEY] === "en" ? "en" : "zh";
}

async function toggleLanguage() {
  currentLanguage = currentLanguage === "en" ? "zh" : "en";
  await chrome.storage.local.set({ [LANGUAGE_KEY]: currentLanguage });
  applyLanguage();
}

function t(key, values = {}) {
  const dict = TRANSLATIONS[currentLanguage] || TRANSLATIONS.zh;
  const fallback = TRANSLATIONS.zh[key] ?? key;
  const template = dict[key] ?? fallback;
  return template.replace(/\{(\w+)\}/g, (_, token) => String(values[token] ?? ""));
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage === "en" ? "en" : "zh-CN";
  document.body.classList.toggle("lang-zh", currentLanguage !== "en");
  document.body.classList.toggle("lang-en", currentLanguage === "en");
  languageToggleButton.textContent = t("languageButton");
  languageToggleButton.title = t("languageTitle");
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  updateCollapseAllButtonLabel();
  render();
}

async function loadPinnedDomains() {
  const stored = await chrome.storage.local.get(PINNED_DOMAINS_KEY);
  const domains = Array.isArray(stored[PINNED_DOMAINS_KEY]) ? stored[PINNED_DOMAINS_KEY] : [];
  pinnedDomains = new Set(domains.filter((domain) => typeof domain === "string" && domain));
}

async function savePinnedDomains() {
  await chrome.storage.local.set({ [PINNED_DOMAINS_KEY]: [...pinnedDomains] });
}

async function loadCollapsedDomains() {
  const stored = await chrome.storage.local.get(COLLAPSED_DOMAINS_KEY);
  const domains = Array.isArray(stored[COLLAPSED_DOMAINS_KEY]) ? stored[COLLAPSED_DOMAINS_KEY] : [];
  collapsedDomains = new Set(domains.filter((domain) => typeof domain === "string" && domain));
}

async function saveCollapsedDomains() {
  await chrome.storage.local.set({ [COLLAPSED_DOMAINS_KEY]: [...collapsedDomains] });
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshData, 120);
}

async function refreshData() {
  const tabs = await chrome.tabs.query({});
  allTabs = Number.isInteger(currentManagerTabId)
    ? tabs.filter((tab) => tab.id !== currentManagerTabId)
    : tabs;

  const pauseResponse = await sendMessage({ type: "getPausedDomains" });
  pausedDomainsByDomain = pauseResponse.ok ? (pauseResponse.pausedDomains || {}) : {};

  selectedTabIds = new Set([...selectedTabIds].filter((id) => allTabs.some((tab) => tab.id === id)));
  if (!selectedTabIds.has(lastSelectedTabId)) lastSelectedTabId = null;

  const tabSignature = buildTabsSnapshotSignature(allTabs);
  const pausedSignature = buildPausedSnapshotSignature(pausedDomainsByDomain);
  if (tabSignature === lastTabSnapshotSignature && pausedSignature === lastPausedSnapshotSignature) return;

  lastTabSnapshotSignature = tabSignature;
  lastPausedSnapshotSignature = pausedSignature;
  render();
}

function buildTabsSnapshotSignature(tabs) {
  return tabs
    .map((tab) => `${tab.id}:${tab.windowId}:${tab.index}:${tab.pinned ? 1 : 0}:${tab.active ? 1 : 0}:${tab.url || ""}:${tab.title || ""}`)
    .join("||");
}

function buildPausedSnapshotSignature(pausedDomains) {
  return Object.entries(pausedDomains)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, expiresAt]) => `${domain}:${expiresAt}`)
    .join("|");
}

function render() {
  const keyword = searchInputEl.value.trim().toLowerCase();
  const filteredTabs = allTabs.filter((tab) => {
    if (!keyword) return true;
    const target = `${tab.title || ""} ${tab.url || ""} ${domainOf(tab.url)}`.toLowerCase();
    return target.includes(keyword);
  });

  const groups = groupTabsByDomain(filteredTabs);
  lastRenderedDomains = groups.map((group) => group.domain);
  lastFilteredTabIds = groups.flatMap((group) => group.tabs.map((tab) => tab.id));
  updateCollapseAllButtonLabel();
  renderSummary(filteredTabs, groups);
  renderGroups(groups);
}

function updateCollapseAllButtonLabel() {
  const domains = lastRenderedDomains;
  if (!domains.length) {
    collapseAllButtonEl.textContent = t("collapseAll");
    return;
  }
  const allCollapsed = domains.every((domain) => collapsedDomains.has(domain));
  collapseAllButtonEl.textContent = allCollapsed ? t("expandAll") : t("collapseAll");
}

function renderSummary(tabs, groups) {
  const windowCount = new Set(tabs.map((tab) => tab.windowId)).size;
  const selectedCount = selectedTabIds.size;
  const activeCount = tabs.filter((tab) => tab.active).length;
  closeSelectedButtonEl.textContent = selectedCount > 0
    ? t("closeSelectedWithCount", { count: selectedCount })
    : t("closeSelected");

  summaryEl.innerHTML = `
    <article class="stat-card"><h3>${t("statTabs")}</h3><p>${tabs.length}</p></article>
    <article class="stat-card"><h3>${t("statWindows")}</h3><p>${windowCount}</p></article>
    <article class="stat-card"><h3>${t("statDomains")}</h3><p>${groups.length}</p></article>
    <article class="stat-card"><h3>${t("statSelected")}</h3><p>${selectedCount}</p><small>${t("activeCount", { count: activeCount })}</small></article>
  `;
}

function renderGroups(groups) {
  if (groups.length === 0) {
    groupsEl.innerHTML = `<p>${t("noMatchedTabs")}</p>`;
    return;
  }

  const existingNodes = new Map(
    [...groupsEl.querySelectorAll(".group-card[data-domain]")]
      .map((node) => [node.dataset.domain, node])
  );
  const fragment = document.createDocumentFragment();

  for (const group of groups) {
    const domainPinned = pinnedDomains.has(group.domain);
    const domainCollapsed = collapsedDomains.has(group.domain);
    const pausedUntil = getPausedUntil(group.domain);
    const signature = buildGroupSignature(group, domainPinned, domainCollapsed, pausedUntil);

    const existing = existingNodes.get(group.domain);
    if (existing && existing.dataset.signature === signature) {
      fragment.append(existing);
      existingNodes.delete(group.domain);
      continue;
    }

    const node = buildGroupNode(group, { domainPinned, domainCollapsed, pausedUntil, signature });
    fragment.append(node);
    existingNodes.delete(group.domain);
  }

  groupsEl.replaceChildren(fragment);
}

function buildGroupSignature(group, domainPinned, domainCollapsed, pausedUntil) {
  const tabData = group.tabs
    .map((tab) => `${tab.id}:${tab.windowId}:${tab.index}:${tab.pinned ? 1 : 0}:${tab.active ? 1 : 0}:${selectedTabIds.has(tab.id) ? 1 : 0}:${tab.title || ""}:${tab.url || ""}`)
    .join(";");
  return [
    currentLanguage,
    group.domain,
    domainPinned ? 1 : 0,
    domainCollapsed ? 1 : 0,
    pausedUntil || 0,
    tabData
  ].join("|");
}

function buildGroupNode(group, ctx) {
  const node = groupTemplateEl.content.firstElementChild.cloneNode(true);
  node.dataset.domain = group.domain;
  node.dataset.signature = ctx.signature;
  node.classList.toggle("is-domain-pinned", ctx.domainPinned);
  node.classList.toggle("is-collapsed", ctx.domainCollapsed);

  const headerEl = node.querySelector(".group-header");
  headerEl.addEventListener("click", async () => {
    await toggleCollapsedDomain(group.domain);
  });

  const title = ctx.domainCollapsed ? `${group.domain} (${group.tabs.length})` : group.domain;
  node.querySelector(".group-title").textContent = title;

  const windowCount = new Set(group.tabs.map((tab) => tab.windowId)).size;
  let meta = t("groupMeta", { tabs: group.tabs.length, windows: windowCount });
  if (ctx.domainPinned) meta += t("pinnedDomainSuffix");
  if (ctx.pausedUntil) meta += t("pausedUntilSuffix", { time: formatTime(ctx.pausedUntil) });
  node.querySelector(".group-meta").textContent = meta;

  const pauseButton = node.querySelector('[data-action="pause-domain"]');
  const isPaused = Boolean(ctx.pausedUntil);
  pauseButton.textContent = isPaused ? t("resumeDomain") : t("pauseDomain");
  pauseButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (isPaused) {
      const response = await sendMessage({ type: "unpauseDomain", domain: group.domain });
      if (response.ok) pausedDomainsByDomain = response.pausedDomains || {};
      render();
      return;
    }

    const entered = window.prompt(t("pausePrompt"), "30");
    if (entered == null) return;
    const minutes = Number.parseInt(entered, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      window.alert(t("pauseInvalidMinutes"));
      return;
    }
    const response = await sendMessage({ type: "pauseDomain", domain: group.domain, minutes });
    if (response.ok) pausedDomainsByDomain = response.pausedDomains || {};
    render();
  });

  const pinDomainButton = node.querySelector('[data-action="pin-domain"]');
  pinDomainButton.textContent = ctx.domainPinned ? t("unpinDomain") : t("pinDomain");
  pinDomainButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    await togglePinnedDomain(group.domain);
  });

  const selectGroupButton = node.querySelector('[data-action="select-group"]');
  const allSelected = group.tabs.every((tab) => selectedTabIds.has(tab.id));
  selectGroupButton.textContent = allSelected ? t("clearSelect") : t("selectAll");
  selectGroupButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const shouldSelect = !group.tabs.every((tab) => selectedTabIds.has(tab.id));
    for (const tab of group.tabs) {
      if (shouldSelect) selectedTabIds.add(tab.id);
      else selectedTabIds.delete(tab.id);
    }
    render();
  });

  const closeGroupButton = node.querySelector('[data-action="close-group"]');
  closeGroupButton.textContent = t("closeGroup");
  closeGroupButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    await closeTabs(group.tabs.map((tab) => tab.id));
  });

  const listEl = node.querySelector(".tab-list");
  for (const tab of group.tabs) {
    listEl.append(buildTabNode(tab));
  }

  return node;
}

function buildTabNode(tab) {
  const tabNode = tabTemplateEl.content.firstElementChild.cloneNode(true);
  const checkbox = tabNode.querySelector('[data-role="select-tab"]');
  checkbox.checked = selectedTabIds.has(tab.id);
  checkbox.addEventListener("change", (event) => {
    handleCheckboxChange(tab.id, checkbox.checked, event.shiftKey);
  });
  checkbox.addEventListener("click", (event) => event.stopPropagation());

  const favicon = tabNode.querySelector(".tab-favicon");
  favicon.src = tab.favIconUrl || "";
  favicon.hidden = !tab.favIconUrl;

  tabNode.querySelector(".tab-title").textContent = tab.title || t("untitled");
  tabNode.querySelector(".tab-url").textContent = tab.url || "";
  tabNode.querySelector(".tab-meta").textContent = t("tabMeta", {
    windowId: tab.windowId,
    index: tab.index,
    pinned: tab.pinned ? t("tabPinnedSuffix") : "",
    active: tab.active ? t("tabActiveSuffix") : ""
  });
  tabNode.setAttribute("draggable", "true");
  tabNode.dataset.tabId = String(tab.id);
  tabNode.dataset.windowId = String(tab.windowId);
  tabNode.classList.toggle("is-pinned", Boolean(tab.pinned));
  tabNode.title = t("rowTitle");

  attachDragEvents(tabNode, tab);

  const pinButton = tabNode.querySelector('[data-action="pin"]');
  pinButton.textContent = tab.pinned ? t("unpinTab") : t("pinTab");
  pinButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    await togglePinTab(tab);
  });

  tabNode.querySelector('[data-action="close"]').textContent = t("close");
  tabNode.querySelector('[data-action="close"]').addEventListener("click", (event) => {
    event.stopPropagation();
    closeTabs([tab.id]);
  });

  tabNode.addEventListener("click", () => focusTab(tab));
  return tabNode;
}

function handleCheckboxChange(tabId, checked, isShiftPressed) {
  if (isShiftPressed && Number.isInteger(lastSelectedTabId)) {
    applyRangeSelection(lastSelectedTabId, tabId, checked);
  } else if (checked) {
    selectedTabIds.add(tabId);
  } else {
    selectedTabIds.delete(tabId);
  }

  lastSelectedTabId = tabId;
  render();
}

function applyRangeSelection(anchorTabId, targetTabId, checked) {
  const anchorIndex = lastFilteredTabIds.indexOf(anchorTabId);
  const targetIndex = lastFilteredTabIds.indexOf(targetTabId);
  if (anchorIndex === -1 || targetIndex === -1) {
    if (checked) selectedTabIds.add(targetTabId);
    else selectedTabIds.delete(targetTabId);
    return;
  }

  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  for (let i = from; i <= to; i += 1) {
    const id = lastFilteredTabIds[i];
    if (checked) selectedTabIds.add(id);
    else selectedTabIds.delete(id);
  }
}

function handleKeydown(event) {
  const isSelectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a";
  if (!isSelectAll) return;

  const target = event.target;
  const typingTarget = target instanceof HTMLElement
    && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (typingTarget) return;

  event.preventDefault();
  for (const id of lastFilteredTabIds) {
    selectedTabIds.add(id);
  }
  render();
}

function groupTabsByDomain(tabs) {
  const map = new Map();
  for (const tab of tabs) {
    const domain = domainOf(tab.url);
    if (!map.has(domain)) map.set(domain, []);
    map.get(domain).push(tab);
  }

  const grouped = [...map.entries()].map(([domain, items]) => ({
    domain,
    tabs: [...items].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return a.index - b.index;
    })
  }));

  grouped.sort((a, b) => {
    const aPinned = pinnedDomains.has(a.domain);
    const bPinned = pinnedDomains.has(b.domain);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (a.domain === t("otherDomain")) return 1;
    if (b.domain === t("otherDomain")) return -1;
    if (a.tabs.length !== b.tabs.length) return b.tabs.length - a.tabs.length;
    return a.domain.localeCompare(b.domain);
  });
  return grouped;
}

function domainOf(rawUrl) {
  if (!rawUrl) return t("otherDomain");
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/i.test(url.protocol)) return t("otherDomain");
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return t("otherDomain");
  }
}

function getPausedUntil(domain) {
  const expiresAt = Number(pausedDomainsByDomain[domain]);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() ? expiresAt : null;
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString(currentLanguage === "en" ? "en-US" : "zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function togglePinTab(tab) {
  await chrome.tabs.update(tab.id, { pinned: !tab.pinned });
  await refreshData();
}

async function togglePinnedDomain(domain) {
  if (pinnedDomains.has(domain)) pinnedDomains.delete(domain);
  else pinnedDomains.add(domain);
  await savePinnedDomains();
  render();
}

async function toggleCollapsedDomain(domain) {
  if (collapsedDomains.has(domain)) collapsedDomains.delete(domain);
  else collapsedDomains.add(domain);
  await saveCollapsedDomains();
  render();
}

async function toggleCollapseAll() {
  if (!lastRenderedDomains.length) return;
  const allCollapsed = lastRenderedDomains.every((domain) => collapsedDomains.has(domain));
  if (allCollapsed) {
    for (const domain of lastRenderedDomains) collapsedDomains.delete(domain);
  } else {
    for (const domain of lastRenderedDomains) collapsedDomains.add(domain);
  }
  await saveCollapsedDomains();
  render();
}

function attachDragEvents(rowEl, tab) {
  rowEl.addEventListener("dragstart", (event) => {
    draggingTabId = tab.id;
    draggingWindowId = tab.windowId;
    rowEl.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(tab.id));
  });

  rowEl.addEventListener("dragend", () => {
    draggingTabId = null;
    draggingWindowId = null;
    rowEl.classList.remove("dragging");
    for (const el of document.querySelectorAll(".drop-target")) {
      el.classList.remove("drop-target");
    }
  });

  rowEl.addEventListener("dragover", (event) => {
    if (!canDropOn(rowEl)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    rowEl.classList.add("drop-target");
  });

  rowEl.addEventListener("dragleave", () => {
    rowEl.classList.remove("drop-target");
  });

  rowEl.addEventListener("drop", async (event) => {
    if (!canDropOn(rowEl)) return;
    event.preventDefault();
    rowEl.classList.remove("drop-target");

    const targetTabId = Number.parseInt(rowEl.dataset.tabId || "", 10);
    if (!Number.isInteger(draggingTabId) || !Number.isInteger(targetTabId)) return;
    if (draggingTabId === targetTabId) return;

    const targetTab = allTabs.find((item) => item.id === targetTabId);
    if (!targetTab || targetTab.windowId !== draggingWindowId) return;

    await chrome.tabs.move(draggingTabId, { windowId: targetTab.windowId, index: targetTab.index });
    await refreshData();
  });
}

function canDropOn(rowEl) {
  if (!Number.isInteger(draggingTabId) || !Number.isInteger(draggingWindowId)) return false;
  const rowWindowId = Number.parseInt(rowEl.dataset.windowId || "", 10);
  if (!Number.isInteger(rowWindowId)) return false;
  return rowWindowId === draggingWindowId;
}

async function closeSelectedTabs() {
  await closeTabs([...selectedTabIds]);
}

async function closeTabs(tabIds) {
  const validIds = tabIds.filter((id) => Number.isInteger(id));
  if (!validIds.length) return;

  await chrome.tabs.remove(validIds);
  for (const id of validIds) selectedTabIds.delete(id);
  if (validIds.includes(lastSelectedTabId)) lastSelectedTabId = null;
  openUndo(validIds.length);
  await refreshData();
}

function openUndo(closedCount) {
  undoToken = { count: closedCount, expiresAt: Date.now() + 9000 };
  undoTextEl.textContent = t("undoClosed", { count: closedCount });
  undoBarEl.classList.remove("hidden");

  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoToken = null;
    undoBarEl.classList.add("hidden");
  }, 9000);
}

async function undoCloseTabs() {
  if (!undoToken) return;
  const { count } = undoToken;
  undoToken = null;
  undoBarEl.classList.add("hidden");
  clearTimeout(undoTimer);

  for (let i = 0; i < count; i += 1) {
    try {
      await chrome.sessions.restore();
    } catch {
      break;
    }
  }

  await refreshData();
}

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error?.message || "Message failed." };
  }
}
