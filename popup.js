const booleanFields = [
  "globalEnabled",
  "dedupeEnabled",
  "confirmMergeOnDuplicate",
  "sortEnabled",
  "ignoreHash",
  "ignoreCommonTrackingParams",
  "domainSplitEnabled"
];

const linkedChildBooleanFields = [
  "dedupeEnabled",
  "confirmMergeOnDuplicate",
  "sortEnabled",
  "ignoreHash",
  "ignoreCommonTrackingParams",
  "domainSplitEnabled"
];

const valueFields = [
  "domainFilterMode",
  "domainFilterList",
  "domainSplitThreshold"
];

const LANGUAGE_KEY = "popupLanguage";
let currentLanguage = "zh";

const messages = {
  zh: {
    pageTitle: "Tab Organizer",
    languageButton: "EN",
    languageTitle: "切换到英文",
    openManager: "管理页",
    organizeNow: "整理",
    globalEnabledTitle: "全局开关",
    globalEnabledDesc: "关闭后暂停所有自动去重、排序和拆窗行为",
    dedupeEnabledTitle: "防重复标签页",
    dedupeEnabledDesc: "发现重复页面时触发合并流程",
    confirmMergeTitle: "合并前确认",
    confirmMergeDesc: "重复页面先进入待确认列表",
    sortEnabledTitle: "按域名排序",
    sortEnabledDesc: "把相同域名的标签页排在一起",
    ignoreHashTitle: "忽略锚点",
    ignoreHashDesc: "example.com#a 与 #b 视为同页",
    ignoreTrackingTitle: "忽略追踪参数",
    ignoreTrackingDesc: "忽略 utm、gclid、fbclid 等参数",
    domainFilterTitle: "域名过滤模式",
    domainFilterAll: "全部域名",
    domainFilterExclude: "排除以下域名",
    domainFilterInclude: "仅处理以下域名",
    splitEnabledTitle: "超阈值自动拆窗",
    splitEnabledDesc: "单域名标签页超过阈值后拆分到新窗口",
    splitThresholdTitle: "拆窗阈值",
    pendingTitle: "待确认合并",
    readSettingsFailed: "读取设置失败",
    organizing: "正在整理...",
    organized: "已整理当前浏览器窗口",
    organizeFailed: "整理失败",
    saveFailed: "保存失败",
    disabled: "全局开关已关闭",
    saved: "设置已保存",
    pendingReadFailed: "读取待合并列表失败",
    pendingEmpty: "当前没有待确认的重复页",
    pendingTitleText: "点击跳转到新开的重复标签页",
    viewNew: "看新页",
    viewExisting: "看已有",
    merge: "合并",
    keep: "保留",
    alwaysMerge: "总是合并",
    alwaysKeep: "总是保留",
    merged: "已合并重复页",
    kept: "已保留重复页",
    alwaysMergeSaved: "本域名后续默认合并",
    alwaysKeepSaved: "本域名后续默认保留",
    actionFailed: "处理失败",
    focusFailed: "跳转失败"
  },
  en: {
    pageTitle: "Tab Organizer",
    languageButton: "中",
    languageTitle: "Switch to Chinese",
    openManager: "Manager",
    organizeNow: "Organize",
    globalEnabledTitle: "Master Switch",
    globalEnabledDesc: "Pause all automatic dedupe, sorting, and window splitting.",
    dedupeEnabledTitle: "Prevent Duplicates",
    dedupeEnabledDesc: "Start a merge flow when a duplicate page appears.",
    confirmMergeTitle: "Confirm Before Merge",
    confirmMergeDesc: "Send duplicate pages to a review list first.",
    sortEnabledTitle: "Sort By Domain",
    sortEnabledDesc: "Keep tabs from the same domain together.",
    ignoreHashTitle: "Ignore Hash",
    ignoreHashDesc: "Treat example.com#a and #b as the same page.",
    ignoreTrackingTitle: "Ignore Tracking Params",
    ignoreTrackingDesc: "Ignore utm, gclid, fbclid, and similar parameters.",
    domainFilterTitle: "Domain Filter",
    domainFilterAll: "All domains",
    domainFilterExclude: "Exclude listed domains",
    domainFilterInclude: "Only listed domains",
    splitEnabledTitle: "Auto Split Window",
    splitEnabledDesc: "Move a domain into its own window when it exceeds the threshold.",
    splitThresholdTitle: "Split Threshold",
    pendingTitle: "Pending Merges",
    readSettingsFailed: "Failed to read settings",
    organizing: "Organizing...",
    organized: "Current browser window organized",
    organizeFailed: "Organize failed",
    saveFailed: "Save failed",
    disabled: "Master switch is off",
    saved: "Settings saved",
    pendingReadFailed: "Failed to read pending merges",
    pendingEmpty: "No duplicate pages need confirmation",
    pendingTitleText: "Click to jump to the new duplicate tab",
    viewNew: "New",
    viewExisting: "Existing",
    merge: "Merge",
    keep: "Keep",
    alwaysMerge: "Always merge",
    alwaysKeep: "Always keep",
    merged: "Duplicate tab merged",
    kept: "Duplicate tab kept",
    alwaysMergeSaved: "This domain will merge by default",
    alwaysKeepSaved: "This domain will keep by default",
    actionFailed: "Action failed",
    focusFailed: "Jump failed"
  }
};

const statusEl = document.querySelector("#status");
const organizeNowButton = document.querySelector("#organizeNow");
const openManagerButton = document.querySelector("#openManager");
const languageToggleButton = document.querySelector("#languageToggle");
const pendingMergeListEl = document.querySelector("#pendingMergeList");
const globalToggleEl = document.querySelector("#globalEnabled");

init();

async function init() {
  await loadLanguage();
  applyLanguage();

  const response = await sendMessage({ type: "getSettings" });
  if (!response.ok) {
    setStatus(response.error || t("readSettingsFailed"));
    return;
  }

  for (const field of booleanFields) {
    const input = document.querySelector(`#${field}`);
    input.checked = Boolean(response.settings[field]);
    if (field === "globalEnabled") {
      input.addEventListener("change", onGlobalToggleChange);
    } else {
      input.addEventListener("change", onChildToggleChange);
    }
  }

  for (const field of valueFields) {
    const input = document.querySelector(`#${field}`);
    input.value = response.settings[field] ?? "";
    input.addEventListener("change", persistSettings);
  }

  organizeNowButton.addEventListener("click", async () => {
    setStatus(t("organizing"));
    const result = await sendMessage({ type: "organizeNow" });
    setStatus(result.ok ? t("organized") : result.error || t("organizeFailed"));
    await refreshPendingMerges();
  });

  openManagerButton.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
  });

  languageToggleButton.addEventListener("click", toggleLanguage);

  syncGlobalFromChildren();
  await refreshPendingMerges();
}

async function loadLanguage() {
  const stored = await chrome.storage.local.get(LANGUAGE_KEY);
  currentLanguage = stored[LANGUAGE_KEY] === "en" ? "en" : "zh";
}

async function toggleLanguage() {
  currentLanguage = currentLanguage === "zh" ? "en" : "zh";
  await chrome.storage.local.set({ [LANGUAGE_KEY]: currentLanguage });
  applyLanguage();
  await refreshPendingMerges();
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage === "en" ? "en" : "zh-CN";
  document.title = t("pageTitle");
  languageToggleButton.textContent = t("languageButton");
  languageToggleButton.title = t("languageTitle");
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
}

function t(key) {
  return messages[currentLanguage]?.[key] || messages.zh[key] || key;
}

async function onGlobalToggleChange() {
  const checked = globalToggleEl.checked;
  for (const field of linkedChildBooleanFields) {
    const input = document.querySelector(`#${field}`);
    input.checked = checked;
  }
  await persistSettings();
}

async function onChildToggleChange() {
  syncGlobalFromChildren();
  await persistSettings();
}

function syncGlobalFromChildren() {
  const allChildrenEnabled = linkedChildBooleanFields.every((field) => {
    const input = document.querySelector(`#${field}`);
    return Boolean(input?.checked);
  });
  globalToggleEl.checked = allChildrenEnabled;
}

async function persistSettings() {
  const settings = {};

  for (const field of booleanFields) {
    settings[field] = document.querySelector(`#${field}`).checked;
  }

  for (const field of valueFields) {
    settings[field] = document.querySelector(`#${field}`).value;
  }

  const response = await sendMessage({ type: "saveSettings", settings });
  if (!response.ok) {
    setStatus(response.error || t("saveFailed"));
  } else if (!settings.globalEnabled) {
    setStatus(t("disabled"));
  } else {
    setStatus(t("saved"));
  }
  await refreshPendingMerges();
}

async function refreshPendingMerges() {
  const response = await sendMessage({ type: "getPendingMerges" });
  if (!response.ok) {
    pendingMergeListEl.innerHTML = `<p class="muted">${t("pendingReadFailed")}</p>`;
    return;
  }

  const pendingMerges = response.pendingMerges || [];
  if (pendingMerges.length === 0) {
    pendingMergeListEl.innerHTML = `<p class="muted">${t("pendingEmpty")}</p>`;
    return;
  }

  pendingMergeListEl.innerHTML = "";
  for (const item of pendingMerges) {
    const row = document.createElement("div");
    row.className = "pending-item";

    const text = document.createElement("p");
    text.className = "pending-text";
    text.textContent = `${item.domain || "unknown"}: ${shortenUrl(item.newTabUrl)}`;
    text.title = t("pendingTitleText");
    text.addEventListener("click", () => focusTab(item.newTabId));

    const actions = document.createElement("div");
    actions.className = "pending-actions";

    actions.append(
      makeFocusButton(t("viewNew"), item.newTabId),
      makeFocusButton(t("viewExisting"), item.existingTabId),
      makeActionButton(t("merge"), item.id, "merge"),
      makeActionButton(t("keep"), item.id, "keep"),
      makeActionButton(t("alwaysMerge"), item.id, "alwaysMerge"),
      makeActionButton(t("alwaysKeep"), item.id, "alwaysKeep")
    );

    row.append(text, actions);
    pendingMergeListEl.append(row);
  }
}

function makeActionButton(label, mergeId, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => resolvePendingMerge(mergeId, action));
  return button;
}

function makeFocusButton(label, tabId) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = "ghost";
  button.addEventListener("click", () => focusTab(tabId));
  return button;
}

async function resolvePendingMerge(mergeId, action) {
  const result = await sendMessage({ type: "resolvePendingMerge", mergeId, action });
  if (!result.ok) {
    setStatus(result.error || t("actionFailed"));
    return;
  }

  if (action === "merge") setStatus(t("merged"));
  else if (action === "keep") setStatus(t("kept"));
  else if (action === "alwaysMerge") setStatus(t("alwaysMergeSaved"));
  else if (action === "alwaysKeep") setStatus(t("alwaysKeepSaved"));

  await refreshPendingMerges();
}

async function focusTab(tabId) {
  const result = await sendMessage({ type: "focusTab", tabId });
  if (!result.ok) {
    setStatus(result.error || t("focusFailed"));
  }
}

function shortenUrl(url) {
  const text = String(url || "");
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function setStatus(text) {
  statusEl.textContent = text;
}
