let allTabs = [];
let selectedTabIds = new Set();
let currentManagerTabId = null;
let undoToken = null;
let undoTimer = null;
let draggingTabId = null;
let draggingWindowId = null;
let pinnedDomains = new Set();
let refreshTimer = null;

const PINNED_DOMAINS_KEY = "managerPinnedDomains";

const summaryEl = document.querySelector("#summary");
const groupsEl = document.querySelector("#groups");
const searchInputEl = document.querySelector("#searchInput");
const refreshButtonEl = document.querySelector("#refreshButton");
const closeSelectedButtonEl = document.querySelector("#closeSelectedButton");
const groupTemplateEl = document.querySelector("#groupTemplate");
const tabTemplateEl = document.querySelector("#tabTemplate");
const undoBarEl = document.querySelector("#undoBar");
const undoTextEl = document.querySelector("#undoText");
const undoButtonEl = document.querySelector("#undoButton");

init();

async function init() {
  const current = await chrome.tabs.getCurrent();
  currentManagerTabId = current?.id ?? null;

  searchInputEl.addEventListener("input", render);
  refreshButtonEl.addEventListener("click", refreshData);
  closeSelectedButtonEl.addEventListener("click", closeSelectedTabs);
  undoButtonEl.addEventListener("click", undoCloseTabs);
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

  await loadPinnedDomains();
  await refreshData();
}

async function loadPinnedDomains() {
  const stored = await chrome.storage.local.get(PINNED_DOMAINS_KEY);
  const domains = Array.isArray(stored[PINNED_DOMAINS_KEY]) ? stored[PINNED_DOMAINS_KEY] : [];
  pinnedDomains = new Set(domains.filter((domain) => typeof domain === "string" && domain));
}

async function savePinnedDomains() {
  await chrome.storage.local.set({ [PINNED_DOMAINS_KEY]: [...pinnedDomains] });
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshData, 120);
}

async function refreshData() {
  allTabs = await chrome.tabs.query({});
  if (Number.isInteger(currentManagerTabId)) {
    allTabs = allTabs.filter((tab) => tab.id !== currentManagerTabId);
  }

  selectedTabIds = new Set([...selectedTabIds].filter((id) => allTabs.some((tab) => tab.id === id)));
  render();
}

function render() {
  const keyword = searchInputEl.value.trim().toLowerCase();
  const filteredTabs = allTabs.filter((tab) => {
    if (!keyword) return true;
    const target = `${tab.title || ""} ${tab.url || ""} ${domainOf(tab.url)}`.toLowerCase();
    return target.includes(keyword);
  });

  const groups = groupTabsByDomain(filteredTabs);
  renderSummary(filteredTabs, groups);
  renderGroups(groups);
}

function renderSummary(tabs, groups) {
  const windowCount = new Set(tabs.map((tab) => tab.windowId)).size;
  const domains = groups.length;
  const selectedCount = selectedTabIds.size;
  const activeCount = tabs.filter((tab) => tab.active).length;
  closeSelectedButtonEl.textContent = selectedCount > 0 ? `关闭选中 (${selectedCount})` : "关闭选中";
  summaryEl.innerHTML = `
    <article class="stat-card"><h3>Tabs</h3><p>${tabs.length}</p></article>
    <article class="stat-card"><h3>Windows</h3><p>${windowCount}</p></article>
    <article class="stat-card"><h3>Domains</h3><p>${domains}</p></article>
    <article class="stat-card"><h3>Selected</h3><p>${selectedCount}</p><small>Active: ${activeCount}</small></article>
  `;
}

function renderGroups(groups) {
  groupsEl.innerHTML = "";
  if (groups.length === 0) {
    groupsEl.innerHTML = "<p>没有匹配的标签页。</p>";
    return;
  }

  for (const group of groups) {
    const node = groupTemplateEl.content.firstElementChild.cloneNode(true);
    const domainPinned = pinnedDomains.has(group.domain);
    node.classList.toggle("is-domain-pinned", domainPinned);
    node.querySelector(".group-title").textContent = group.domain;
    node.querySelector(".group-meta").textContent = `${group.tabs.length} tabs / ${new Set(group.tabs.map((tab) => tab.windowId)).size} windows${domainPinned ? " · Pinned domain" : ""}`;
    const pinDomainButton = node.querySelector('[data-action="pin-domain"]');
    pinDomainButton.textContent = domainPinned ? "取消置顶域名" : "置顶域名";
    pinDomainButton.addEventListener("click", async () => {
      await togglePinnedDomain(group.domain);
    });

    const selectGroupButton = node.querySelector('[data-action="select-group"]');
    const allSelected = group.tabs.every((tab) => selectedTabIds.has(tab.id));
    selectGroupButton.textContent = allSelected ? "撤销全选" : "全选";
    selectGroupButton.addEventListener("click", () => {
      const nowAllSelected = group.tabs.every((tab) => selectedTabIds.has(tab.id));
      if (nowAllSelected) {
        for (const tab of group.tabs) selectedTabIds.delete(tab.id);
      } else {
        for (const tab of group.tabs) selectedTabIds.add(tab.id);
      }
      render();
    });

    node.querySelector('[data-action="close-group"]').addEventListener("click", async () => {
      await closeTabs(group.tabs.map((tab) => tab.id));
    });

    const listEl = node.querySelector(".tab-list");
    for (const tab of group.tabs) {
      const tabNode = tabTemplateEl.content.firstElementChild.cloneNode(true);
      const checkbox = tabNode.querySelector('[data-role="select-tab"]');
      checkbox.checked = selectedTabIds.has(tab.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedTabIds.add(tab.id);
        else selectedTabIds.delete(tab.id);
        renderSummary(allTabs, groupTabsByDomain(allTabs));
      });
      checkbox.addEventListener("click", (event) => event.stopPropagation());

      const favicon = tabNode.querySelector(".tab-favicon");
      favicon.src = tab.favIconUrl || "";
      favicon.hidden = !tab.favIconUrl;

      tabNode.querySelector(".tab-title").textContent = tab.title || "(Untitled)";
      tabNode.querySelector(".tab-url").textContent = tab.url || "";
      tabNode.querySelector(".tab-meta").textContent = `Window ${tab.windowId} · Index ${tab.index}${tab.pinned ? " · Pinned" : ""}${tab.active ? " · Active" : ""}`;
      tabNode.setAttribute("draggable", "true");
      tabNode.dataset.tabId = String(tab.id);
      tabNode.dataset.windowId = String(tab.windowId);
      tabNode.classList.toggle("is-pinned", Boolean(tab.pinned));
      tabNode.title = "点击跳转到该标签页，或拖拽调整顺序";

      attachDragEvents(tabNode, tab);

      const pinButton = tabNode.querySelector('[data-action="pin"]');
      pinButton.textContent = tab.pinned ? "取消置顶" : "置顶";
      pinButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        await togglePinTab(tab);
      });
      tabNode.querySelector('[data-action="close"]').addEventListener("click", (event) => {
        event.stopPropagation();
        closeTabs([tab.id]);
      });

      tabNode.addEventListener("click", () => focusTab(tab));

      listEl.append(tabNode);
    }

    groupsEl.append(node);
  }
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
    if (a.domain === "other") return 1;
    if (b.domain === "other") return -1;
    if (a.tabs.length !== b.tabs.length) return b.tabs.length - a.tabs.length;
    return a.domain.localeCompare(b.domain);
  });
  return grouped;
}

function domainOf(rawUrl) {
  if (!rawUrl) return "other";
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/i.test(url.protocol)) return "other";
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "other";
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
  if (pinnedDomains.has(domain)) {
    pinnedDomains.delete(domain);
  } else {
    pinnedDomains.add(domain);
  }
  await savePinnedDomains();
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
  if (validIds.length === 0) return;

  await chrome.tabs.remove(validIds);
  for (const id of validIds) selectedTabIds.delete(id);
  openUndo(validIds.length);
  await refreshData();
}

function openUndo(closedCount) {
  undoToken = { count: closedCount, expiresAt: Date.now() + 9000 };
  undoTextEl.textContent = `已关闭 ${closedCount} 个标签页`;
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
