"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  connStatus: $("connStatus"),
  connText: $("connText"),
  statObs: $("statObs"),
  statSessions: $("statSessions"),
  statProjects: $("statProjects"),
  statResults: $("statResults"),
  searchInput: $("searchInput"),
  searchBtn: $("searchBtn"),
  tabMemories: $("tabMemories"),
  tabTrash: $("tabTrash"),
  trashCount: $("trashCount"),
  projectFilter: $("projectFilter"),
  typeFilter: $("typeFilter"),
  scopeFilter: $("scopeFilter"),
  limitFilter: $("limitFilter"),
  resultCount: $("resultCount"),
  activeFilter: $("activeFilter"),
  refreshBtn: $("refreshBtn"),
  list: $("list"),
  detailPane: $("detailPane"),
  emptyState: $("emptyState"),
  detailLoading: $("detailLoading"),
  editor: $("editor"),
  trashBanner: $("trashBanner"),
  trashDeletedAt: $("trashDeletedAt"),
  editId: $("editId"),
  editTypeBadge: $("editTypeBadge"),
  editScopeBadge: $("editScopeBadge"),
  editTitle: $("editTitle"),
  editProject: $("editProject"),
  editSession: $("editSession"),
  editUpdated: $("editUpdated"),
  editCreated: $("editCreated"),
  editRevision: $("editRevision"),
  editSync: $("editSync"),
  editType: $("editType"),
  editScope: $("editScope"),
  editTopicKey: $("editTopicKey"),
  editContent: $("editContent"),
  editError: $("editError"),
  restoreBtn: $("restoreBtn"),
  saveBtn: $("saveBtn"),
  deleteBtn: $("deleteBtn"),
  hardDeleteBtn: $("hardDeleteBtn"),
  copyIdBtn: $("copyIdBtn"),
  closeEditor: $("closeEditor"),
  backupBtn: $("backupBtn"),
  newBtn: $("newBtn"),
  quitBtn: $("quitBtn"),
  modal: $("modal"),
  modalClose: $("modalClose"),
  newForm: $("newForm"),
  newProject: $("newProject"),
  newType: $("newType"),
  newScope: $("newScope"),
  newTopicKey: $("newTopicKey"),
  newTitle: $("newTitle"),
  newContent: $("newContent"),
  newError: $("newError"),
  newSaveBtn: $("newSaveBtn"),
  newCancel: $("newCancel"),
  toast: $("toast"),
};

const STATIC_TYPES = [
  "note", "config", "decision", "bugfix", "feature", "refactor",
  "discovery", "pattern", "preference", "plan", "architecture",
  "learning", "session_summary",
];

const TYPE_LABELS = {
  note: "笔记",
  config: "配置",
  decision: "决策",
  bugfix: "修复",
  feature: "功能",
  refactor: "重构",
  discovery: "发现",
  pattern: "模式",
  preference: "偏好",
  plan: "计划",
  architecture: "架构",
  learning: "经验",
  session_summary: "会话摘要",
};

const SCOPE_LABELS = {
  project: "项目",
  global: "全局",
  personal: "个人",
};

const state = {
  projects: [],
  observations: [],
  types: new Set(STATIC_TYPES),
  selectedId: null,
  current: null,
  view: "memories",
  trashMode: false,
  search: "",
  filters: {
    project: "__all__",
    type: "",
    scope: "",
    limit: 50,
  },
  listToken: 0,
  detailToken: 0,
  searchTimer: null,
  toastTimer: null,
  lastConnError: "",
};

const PREFS_KEY = "engram-panel-filters-v1";
const NEW_CONTENT_TEMPLATE = "**What**: \n**Why**: \n**Where**: ";

function api(path, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined && opts.body !== null && !opts.headers["Content-Type"]) {
    opts.headers["Content-Type"] = "application/json; charset=utf-8";
  }
  return fetch("/api" + path, opts).then(async (res) => {
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = text;
      }
    }
    if (!res.ok) {
      const message = errorMessage(data, "请求失败 (HTTP " + res.status + ")");
      const err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    const backupName = res.headers.get("X-Engram-Panel-Backup");
    if (backupName && data && typeof data === "object" && !Array.isArray(data)) {
      data._backup = backupName;
    }
    return data;
  });
}

function errorMessage(data, fallback) {
  if (data && typeof data === "object") {
    if (data.error) return String(data.error);
    if (data.message) return String(data.message);
    try {
      return JSON.stringify(data);
    } catch (e) {
      return fallback;
    }
  }
  if (typeof data === "string" && data.trim()) return data.trim();
  return fallback;
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function typeClass(type) {
  let cls = String(type || "note").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  if (!cls || /^[0-9]/.test(cls)) cls = "t_" + cls;
  return "type-" + cls;
}

function typeLabel(type) {
  const raw = String(type || "note");
  return TYPE_LABELS[raw] || raw.replace(/_/g, " ");
}

function scopeLabel(scope) {
  return SCOPE_LABELS[scope] || scope || "项目";
}

function previewText(text, maxLength) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const limit = maxLength || 220;
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

function parseDate(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(" ", "T");
  s = s.replace(/(\.\d{3})\d+/, "$1");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value) {
  const d = parseDate(value);
  if (!d) return value || "—";
  return dateFormatter.format(d);
}

function showToast(message, isError) {
  if (state.toastTimer) clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle("error", Boolean(isError));
  els.toast.classList.add("show");
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove("show");
  }, 2800);
}

function setConnection(ok, text) {
  els.connStatus.classList.remove("conn-ok", "conn-bad", "conn-wait");
  els.connStatus.classList.add(ok ? "conn-ok" : "conn-bad");
  els.connText.textContent = text;
}

async function loadStatus() {
  try {
    const health = await api("/health");
    const version = health && health.version ? " · v" + health.version : "";
    setConnection(true, "Engram 已连接" + version);
    state.lastConnError = "";
  } catch (err) {
    const message = err && err.message ? err.message : "Engram 未连接";
    setConnection(false, "Engram 未连接");
    if (state.lastConnError !== message) {
      state.lastConnError = message;
      showToast("Engram 连接失败：" + message, true);
    }
  }
}

async function loadStats() {
  try {
    const stats = await api("/stats?all_projects=true");
    els.statObs.textContent = Number(stats.total_observations || 0).toLocaleString("zh-CN");
    els.statSessions.textContent = Number(stats.total_sessions || 0).toLocaleString("zh-CN");
    els.statProjects.textContent = Number((stats.projects || []).length).toLocaleString("zh-CN");
  } catch (err) {
    els.statObs.textContent = "—";
    els.statSessions.textContent = "—";
    els.statProjects.textContent = "—";
  }
}

async function loadTrashCount() {
  try {
    const data = await api("/panel/trash?limit=1");
    const count = Number(data && data.count ? data.count : 0);
    els.trashCount.textContent = count.toLocaleString("zh-CN");
    return count;
  } catch (err) {
    els.trashCount.textContent = "?";
    return 0;
  }
}

function setView(view) {
  if (view !== "memories" && view !== "trash") return;
  state.view = view;
  state.trashMode = view === "trash";
  const isTrash = state.trashMode;
  els.tabMemories.classList.toggle("active", !isTrash);
  els.tabTrash.classList.toggle("active", isTrash);
  els.tabMemories.setAttribute("aria-selected", isTrash ? "false" : "true");
  els.tabTrash.setAttribute("aria-selected", isTrash ? "true" : "false");
  els.searchInput.placeholder = isTrash ? "搜索回收站…" : "搜索标题或内容…";
  updateActiveFilter();
  clearSelection();
  loadTrashCount();
  loadList();
}

function renderTypeSelect(select, selected, includeAll) {
  const types = new Set(state.types);
  if (selected) types.add(selected);
  const sorted = Array.from(types).sort((a, b) => a.localeCompare(b));
  const options = sorted.map((type) =>
    '<option value="' + escapeHtml(type) + '">' + escapeHtml(typeLabel(type)) + '</option>'
  ).join("");
  select.innerHTML = (includeAll ? '<option value="">全部类型</option>' : "") + options;

  if (includeAll) {
    select.value = selected && types.has(selected) ? selected : "";
  } else {
    const fallback = types.has("note") ? "note" : (sorted[0] || "note");
    select.value = selected && types.has(selected) ? selected : fallback;
  }
}

function refreshTypeOptions() {
  renderTypeSelect(els.typeFilter, els.typeFilter.value || state.filters.type, true);
  renderTypeSelect(els.editType, els.editType.value, false);
  renderTypeSelect(els.newType, els.newType.value, false);
}

function ensureTypeOption(select, type) {
  if (!type) return;
  if (Array.from(select.options).some((option) => option.value === type)) return;
  const option = document.createElement("option");
  option.value = type;
  option.textContent = typeLabel(type);
  select.appendChild(option);
}

function rememberTypes(items) {
  let changed = false;
  for (const item of items || []) {
    if (item && item.type && !state.types.has(item.type)) {
      state.types.add(item.type);
      changed = true;
    }
  }
  if (changed) refreshTypeOptions();
}

async function loadProjects() {
  const data = await api("/projects");
  const projects = Array.isArray(data && data.projects) ? data.projects.slice() : [];
  projects.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
  state.projects = projects;

  const filterValue = state.filters.project;
  els.projectFilter.innerHTML = '<option value="__all__">全部项目</option>' + projects.map((project) => {
    const name = String(project.name || "");
    const count = Number(project.observation_count || 0);
    return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + " (" + count + ")</option>";
  }).join("");

  if (filterValue === "__all__" || projects.some((p) => p.name === filterValue)) {
    els.projectFilter.value = filterValue;
  } else {
    state.filters.project = "__all__";
    els.projectFilter.value = "__all__";
  }

  const preferred = state.filters.project !== "__all__" && projects.some((p) => p.name === state.filters.project)
    ? state.filters.project
    : (projects[0] ? projects[0].name : "");
  els.newProject.innerHTML = projects.length
    ? projects.map((project) => {
      const name = String(project.name || "");
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + "</option>";
    }).join("")
    : '<option value="">没有可用项目</option>';
  if (preferred) els.newProject.value = preferred;

  updateActiveFilter();
}

function updateActiveFilter() {
  const parts = [];
  if (state.trashMode) parts.push("回收站");
  if (state.search.trim()) parts.push("搜索“" + state.search.trim() + "”");
  if (state.filters.project !== "__all__") parts.push(state.filters.project);
  if (state.filters.type) parts.push(typeLabel(state.filters.type));
  if (state.filters.scope) parts.push(scopeLabel(state.filters.scope));
  els.activeFilter.textContent = parts.length ? "· " + parts.join(" · ") : "";
}

function renderList() {
  if (state.trashMode) {
    renderTrashList();
    return;
  }

  const items = state.observations;
  els.resultCount.textContent = items.length + " 条";
  els.statResults.textContent = items.length.toLocaleString("zh-CN");

  if (!items.length) {
    const searching = Boolean(state.search.trim());
    els.list.innerHTML = '<div class="list-empty"><strong>' +
      (searching ? "没有匹配的记忆" : "这个范围还没有记忆") +
      '</strong><span>' +
      (searching ? "试试更短的关键词，或切换项目、类型、范围。" : "点右上角“新建记忆”，或在 OpenCode / DSH 里让 agent 保存一条。") +
      '</span></div>';
    return;
  }

  els.list.innerHTML = items.map((obs) => {
    const id = Number(obs.id);
    const selected = state.selectedId === id ? " selected" : "";
    const project = obs.project || "未知项目";
    const time = formatDate(obs.updated_at || obs.created_at);
    return '<button type="button" class="card' + selected + '" data-id="' + id + '" role="listitem">' +
      '<div class="card-top">' +
        '<span class="badge ' + typeClass(obs.type) + '">' + escapeHtml(typeLabel(obs.type)) + '</span>' +
        '<span class="badge badge-scope">' + escapeHtml(scopeLabel(obs.scope)) + '</span>' +
        '<span class="card-time">' + escapeHtml(time) + '</span>' +
      '</div>' +
      '<h3 title="' + escapeHtml(obs.title || "") + '">' + escapeHtml(obs.title || "(无标题)") + '</h3>' +
      '<p>' + escapeHtml(previewText(obs.content, 220)) + '</p>' +
      '<div class="card-meta">' +
        '<span title="' + escapeHtml(project) + '">' + escapeHtml(project) + '</span>' +
        '<span class="id">#' + id + '</span>' +
      '</div>' +
    '</button>';
  }).join("");
}

function renderTrashList() {
  const items = state.observations;
  els.resultCount.textContent = items.length + " 条";
  els.statResults.textContent = items.length.toLocaleString("zh-CN");

  if (!items.length) {
    const searching = Boolean(state.search.trim());
    els.list.innerHTML = '<div class="list-empty"><strong>' +
      (searching ? "回收站里没有匹配的记忆" : "回收站是空的") +
      '</strong><span>' +
      (searching ? "试试更短的关键词，或切换项目、类型、范围。" : "普通“删除”的记忆会先进入这里；永久删除后才会真正消失。") +
      '</span></div>';
    return;
  }

  els.list.innerHTML = items.map((obs) => {
    const id = Number(obs.id);
    const selected = state.selectedId === id ? " selected" : "";
    const project = obs.project || "未知项目";
    return '<button type="button" class="card trash-card' + selected + '" data-id="' + id + '" role="listitem">' +
      '<div class="card-top">' +
        '<span class="badge ' + typeClass(obs.type) + '">' + escapeHtml(typeLabel(obs.type)) + '</span>' +
        '<span class="badge badge-trash">已删除</span>' +
        '<span class="card-time deleted-time">' + escapeHtml(formatDate(obs.deleted_at)) + '</span>' +
      '</div>' +
      '<h3 title="' + escapeHtml(obs.title || "") + '">' + escapeHtml(obs.title || "(无标题)") + '</h3>' +
      '<p>' + escapeHtml(previewText(obs.content, 220)) + '</p>' +
      '<div class="card-meta">' +
        '<span title="' + escapeHtml(project) + '">' + escapeHtml(project) + '</span>' +
        '<span class="id">#' + id + '</span>' +
      '</div>' +
    '</button>';
  }).join("");
}

function renderListError(message) {
  state.observations = [];
  els.resultCount.textContent = "0 条";
  els.statResults.textContent = "0";
  els.list.innerHTML = '<div class="list-empty"><strong>加载失败</strong><span>' +
    escapeHtml(message) + '</span></div>';
}

async function loadList() {
  const token = ++state.listToken;
  state.search = els.searchInput.value;
  updateActiveFilter();

  els.list.innerHTML = '<div class="loading">加载中…</div>';
  const params = new URLSearchParams();
  const limit = Number(state.filters.limit) || 50;

  if (state.trashMode) {
    const trashParams = new URLSearchParams();
    trashParams.set("limit", String(limit));
    if (state.search.trim()) trashParams.set("q", state.search.trim());
    if (state.filters.project !== "__all__") trashParams.set("project", state.filters.project);
    if (state.filters.type) trashParams.set("type", state.filters.type);
    if (state.filters.scope) trashParams.set("scope", state.filters.scope);
    try {
      const data = await api("/panel/trash?" + trashParams.toString());
      if (token !== state.listToken) return;
      const items = Array.isArray(data && data.items) ? data.items : [];
      state.observations = items;
      rememberTypes(items);
      renderList();
    } catch (err) {
      if (token !== state.listToken) return;
      renderListError(err && err.message ? err.message : "未知错误");
    }
    return;
  }

  const fetchLimit = (!state.search.trim() && state.filters.type) ? 200 : limit;
  params.set("limit", String(fetchLimit));

  if (state.search.trim()) {
    params.set("q", state.search.trim());
    params.set("match_mode", "any");
    if (state.filters.type) params.set("type", state.filters.type);
    if (state.filters.scope) params.set("scope", state.filters.scope);
    if (state.filters.project === "__all__") params.set("all_projects", "true");
    else params.set("project", state.filters.project);
  } else {
    if (state.filters.scope) params.set("scope", state.filters.scope);
    if (state.filters.project === "__all__") params.set("all_projects", "true");
    else params.set("project", state.filters.project);
  }

  try {
    const endpoint = state.search.trim() ? "/search?" : "/observations?";
    let items = await api(endpoint + params.toString());
    if (!Array.isArray(items)) items = [];
    if (!state.search.trim() && state.filters.type) {
      items = items.filter((item) => item.type === state.filters.type).slice(0, limit);
    }
    if (token !== state.listToken) return;
    state.observations = items;
    rememberTypes(items);
    renderList();
  } catch (err) {
    if (token !== state.listToken) return;
    renderListError(err && err.message ? err.message : "未知错误");
  }
}

async function loadDetail(id) {
  const token = ++state.detailToken;
  els.editor.classList.add("hidden");
  els.emptyState.classList.add("hidden");
  els.detailLoading.classList.remove("hidden");
  try {
    const obs = await api("/observations/" + encodeURIComponent(id));
    if (token !== state.detailToken) return;
    state.current = obs;
    state.selectedId = Number(obs.id);
    populateEditor(obs, false);
    els.detailLoading.classList.add("hidden");
    els.editor.classList.remove("hidden");
    els.detailPane.scrollTop = 0;
    renderList();
  } catch (err) {
    if (token !== state.detailToken) return;
    els.detailLoading.classList.add("hidden");
    els.emptyState.classList.remove("hidden");
    showToast("读取记忆失败：" + (err && err.message ? err.message : "未知错误"), true);
  }
}

async function loadTrashDetail(id) {
  const token = ++state.detailToken;
  els.editor.classList.add("hidden");
  els.emptyState.classList.add("hidden");
  els.detailLoading.classList.remove("hidden");
  try {
    const obs = await api("/panel/trash/" + encodeURIComponent(id));
    if (token !== state.detailToken) return;
    state.current = obs;
    state.selectedId = Number(obs.id);
    populateEditor(obs, true);
    els.detailLoading.classList.add("hidden");
    els.editor.classList.remove("hidden");
    els.detailPane.scrollTop = 0;
    renderList();
  } catch (err) {
    if (token !== state.detailToken) return;
    els.detailLoading.classList.add("hidden");
    els.emptyState.classList.remove("hidden");
    showToast("读取回收站记录失败：" + (err && err.message ? err.message : "未知错误"), true);
  }
}

function resetEditorChrome() {
  els.editor.classList.remove("trash");
  els.trashBanner.classList.add("hidden");
  els.restoreBtn.classList.add("hidden");
  els.saveBtn.classList.remove("hidden");
  els.hardDeleteBtn.classList.remove("hidden");
  els.deleteBtn.textContent = "删除";
  els.editTitle.readOnly = false;
  els.editType.disabled = false;
  els.editTopicKey.readOnly = false;
  els.editContent.readOnly = false;
  els.editScope.disabled = false;
  els.restoreBtn.disabled = false;
  els.saveBtn.disabled = false;
  els.deleteBtn.disabled = false;
  els.hardDeleteBtn.disabled = false;
}

function populateEditor(obs, trash) {
  state.trashMode = Boolean(trash);
  resetEditorChrome();

  els.editId.textContent = "#" + obs.id;
  els.editTypeBadge.textContent = typeLabel(obs.type);
  els.editTypeBadge.className = "badge " + typeClass(obs.type);
  els.editScopeBadge.textContent = scopeLabel(obs.scope);
  els.editTitle.value = obs.title || "";
  els.editProject.textContent = obs.project || "(无项目)";
  els.editSession.textContent = obs.session_id || "—";
  els.editUpdated.textContent = formatDate(obs.updated_at || obs.created_at);
  els.editCreated.textContent = formatDate(obs.created_at);
  els.editRevision.textContent = String(obs.revision_count == null ? 1 : obs.revision_count);
  els.editSync.textContent = obs.sync_id || "—";
  ensureTypeOption(els.editType, obs.type);
  els.editType.value = obs.type || "note";
  els.editScope.value = obs.scope || "project";
  els.editTopicKey.value = obs.topic_key || "";
  els.editContent.value = obs.content || "";
  els.editError.classList.add("hidden");
  els.editError.textContent = "";
  els.saveBtn.disabled = false;
  els.saveBtn.textContent = "保存修改";

  if (state.trashMode) {
    els.editor.classList.add("trash");
    els.trashBanner.classList.remove("hidden");
    els.trashDeletedAt.textContent = "删除于 " + formatDate(obs.deleted_at);
    els.restoreBtn.classList.remove("hidden");
    els.saveBtn.classList.add("hidden");
    els.hardDeleteBtn.classList.add("hidden");
    els.deleteBtn.textContent = "永久删除";
    els.editTitle.readOnly = true;
    els.editType.disabled = true;
    els.editTopicKey.readOnly = true;
    els.editContent.readOnly = true;
    els.editScope.disabled = true;
    document.title = "回收站 · " + (obs.title || "记忆") + " · Engram 面板";
  } else {
    document.title = (obs.title || "记忆") + " · Engram 面板";
  }
}

function clearSelection() {
  state.selectedId = null;
  state.current = null;
  els.detailToken++;
  els.editor.classList.add("hidden");
  els.detailLoading.classList.add("hidden");
  els.emptyState.classList.remove("hidden");
  els.detailPane.classList.remove("open");
  document.body.classList.remove("has-selection");
  resetEditorChrome();
  document.title = "Engram 面板";
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch (e) {
    // ignore
  }
  renderList();
}

function selectObservation(id) {
  const numeric = Number(id);
  if (!numeric) return;
  state.selectedId = numeric;
  els.detailPane.classList.add("open");
  document.body.classList.add("has-selection");
  renderList();
  try {
    history.replaceState(null, "", "#id=" + numeric);
  } catch (e) {
    // ignore
  }
  if (state.trashMode) {
    loadTrashDetail(numeric);
  } else {
    loadDetail(numeric);
  }
}

function collectPatch() {
  const current = state.current;
  if (!current) return null;

  const title = els.editTitle.value.trim();
  const content = els.editContent.value;
  const type = els.editType.value.trim() || "note";
  const scope = els.editScope.value || "project";
  const topicKey = els.editTopicKey.value.trim();

  if (!title) throw new Error("标题不能为空");
  if (!content.trim()) throw new Error("内容不能为空");

  const patch = {};
  if (title !== (current.title || "")) patch.title = title;
  if (content !== (current.content || "")) patch.content = content;
  if (type !== (current.type || "")) patch.type = type;
  if (scope !== (current.scope || "project")) patch.scope = scope;
  if (topicKey !== (current.topic_key || "")) patch.topic_key = topicKey;
  return Object.keys(patch).length ? patch : null;
}

async function saveEditor(event) {
  event.preventDefault();
  const current = state.current;
  if (!current || state.trashMode) return;
  if (!current.project) {
    showEditorError("这条记忆没有项目，无法安全更新。");
    return;
  }

  let patch;
  try {
    patch = collectPatch();
  } catch (err) {
    showEditorError(err.message);
    return;
  }
  if (!patch) {
    showToast("没有修改");
    return;
  }

  els.saveBtn.disabled = true;
  els.saveBtn.textContent = "保存中…";
  hideEditorError();
  try {
    const updated = await api(
      "/observations/" + current.id + "?expected_project=" + encodeURIComponent(current.project),
      { method: "PATCH", body: JSON.stringify(patch) }
    );
    state.current = updated;
    populateEditor(updated);
    await loadList();
    await loadStats();
    showToast("已保存 #" + updated.id);
  } catch (err) {
    showEditorError("保存失败：" + (err && err.message ? err.message : "未知错误"));
  } finally {
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = "保存修改";
  }
}

function showEditorError(message) {
  els.editError.textContent = message;
  els.editError.classList.remove("hidden");
}

function hideEditorError() {
  els.editError.classList.add("hidden");
  els.editError.textContent = "";
}

async function restoreCurrent() {
  const current = state.current;
  if (!current || !state.trashMode) return;
  if (!window.confirm("恢复 #" + current.id + "「" + (current.title || "") + "」？\n\n恢复会直接改 SQLite；如果备份已启用，会先自动备份整库。")) {
    return;
  }

  els.restoreBtn.disabled = true;
  els.deleteBtn.disabled = true;
  hideEditorError();
  let restored = false;
  try {
    const result = await api("/panel/trash/" + current.id + "/restore", {
      method: "POST",
      body: JSON.stringify({ expected_project: current.project || "" }),
    });
    restored = true;
    const backupName = result && result.backup && result.backup.name;
    const warning = result && result.restore && result.restore.cloud_warning;
    showToast("已恢复 #" + current.id + (backupName ? " · 备份 " + backupName : ""));
    clearSelection();
    await loadList();
    await loadStats();
    await loadProjects();
    await loadTrashCount();
    if (warning) {
      setTimeout(() => showToast(warning, true), 3200);
    }
  } catch (err) {
    showEditorError((restored ? "已恢复，但刷新列表失败：" : "恢复失败：") +
      (err && err.message ? err.message : "未知错误"));
  } finally {
    els.restoreBtn.disabled = false;
    els.deleteBtn.disabled = false;
  }
}

async function deleteCurrent(hard) {
  const current = state.current;
  if (!current) return;
  if (!current.project) {
    showEditorError("这条记忆没有项目，无法安全删除。");
    return;
  }

  const label = hard ? "永久删除" : "删除";
  const warning = hard
    ? "永久删除会从 Engram 数据库移除。删除前会自动生成整库备份。\n\n确定永久删除 #" + current.id + "？"
    : "删除后进入回收站，Engram 仍保留记录。\n\n确定删除 #" + current.id + "？";
  if (!window.confirm(warning)) return;
  if (hard && !window.confirm("最后确认：永久删除 #" + current.id + "「" + (current.title || "") + "」？")) return;

  els.deleteBtn.disabled = true;
  els.hardDeleteBtn.disabled = true;
  els.restoreBtn.disabled = true;
  hideEditorError();
  let deleted = false;
  try {
    let path = "/observations/" + current.id + "?expected_project=" + encodeURIComponent(current.project);
    if (hard) path += "&hard=true";
    const result = await api(path, { method: "DELETE" });
    deleted = true;
    const backupName = result && result._backup;
    showToast("已" + label + " #" + current.id + (backupName ? " · 备份 " + backupName : ""));
    clearSelection();
    await loadList();
    await loadStats();
    await loadProjects();
    await loadTrashCount();
  } catch (err) {
    showEditorError((deleted ? "已" + label + "，但刷新列表失败：" : label + "失败：") +
      (err && err.message ? err.message : "未知错误"));
  } finally {
    els.deleteBtn.disabled = false;
    els.hardDeleteBtn.disabled = false;
    els.restoreBtn.disabled = false;
  }
}

async function copyId() {
  if (!state.current) return;
  const text = String(state.current.id);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    showToast("已复制 ID #" + text);
  } catch (err) {
    showToast("复制失败，ID 是 #" + text, true);
  }
}

function openNewModal() {
  if (!state.projects.length) {
    showToast("还没有可用项目。先在 OpenCode / DSH 里保存一条记忆。", true);
    return;
  }
  els.newForm.reset();
  els.newType.value = "note";
  els.newScope.value = "project";
  els.newTopicKey.value = "";
  els.newContent.value = NEW_CONTENT_TEMPLATE;
  els.newError.classList.add("hidden");
  els.newError.textContent = "";
  const preferred = state.filters.project !== "__all__" && state.projects.some((p) => p.name === state.filters.project)
    ? state.filters.project
    : state.projects[0].name;
  els.newProject.value = preferred;
  els.modal.classList.remove("hidden");
  setTimeout(() => els.newTitle.focus(), 40);
}

function closeNewModal() {
  els.modal.classList.add("hidden");
  els.newError.classList.add("hidden");
  els.newError.textContent = "";
}

async function submitNew(event) {
  event.preventDefault();
  const project = els.newProject.value;
  const title = els.newTitle.value.trim();
  const content = els.newContent.value;
  const type = els.newType.value.trim() || "note";
  const scope = els.newScope.value || "project";
  const topicKey = els.newTopicKey.value.trim();

  if (!project) {
    showNewError("请选择项目");
    return;
  }
  if (!title) {
    showNewError("标题不能为空");
    return;
  }
  if (!content.trim()) {
    showNewError("内容不能为空");
    return;
  }

  els.newSaveBtn.disabled = true;
  els.newSaveBtn.textContent = "保存中…";
  els.newError.classList.add("hidden");

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  const sessionId = "engram-panel-" + stamp + "-" + rand;

  try {
    await api("/sessions", {
      method: "POST",
      body: JSON.stringify({ id: sessionId, project: project, directory: "" }),
    });
    const saved = await api("/observations", {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        project: project,
        type: type,
        title: title,
        content: content,
        scope: scope,
        topic_key: topicKey,
      }),
    });
    closeNewModal();
    if (state.trashMode) setView("memories");
    await loadProjects();
    await loadList();
    await loadStats();
    await loadTrashCount();
    if (saved && saved.id) {
      selectObservation(saved.id);
    }
    showToast("已新建记忆 #" + (saved && saved.id ? saved.id : ""));
  } catch (err) {
    showNewError("保存失败：" + (err && err.message ? err.message : "未知错误"));
  } finally {
    els.newSaveBtn.disabled = false;
    els.newSaveBtn.textContent = "保存";
  }
}

function showNewError(message) {
  els.newError.textContent = message;
  els.newError.classList.remove("hidden");
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.filters));
  } catch (e) {
    // ignore
  }
}

function restorePrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved === "object") {
      if (typeof saved.project === "string") state.filters.project = saved.project;
      if (typeof saved.type === "string") state.filters.type = saved.type;
      if (typeof saved.scope === "string") state.filters.scope = saved.scope;
      if (["25", "50", "100", "200"].indexOf(String(saved.limit)) >= 0) {
        state.filters.limit = Number(saved.limit);
      }
    }
  } catch (e) {
    // ignore
  }
}

function applyFiltersToControls() {
  els.scopeFilter.value = state.filters.scope;
  els.limitFilter.value = String(state.filters.limit);
  if (state.filters.type) els.typeFilter.value = state.filters.type;
}

function onFilterChanged() {
  state.filters.project = els.projectFilter.value || "__all__";
  state.filters.type = els.typeFilter.value || "";
  state.filters.scope = els.scopeFilter.value || "";
  state.filters.limit = Number(els.limitFilter.value) || 50;
  savePrefs();
  updateActiveFilter();
  loadList();
}

function debounceSearch() {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.search = els.searchInput.value;
    updateActiveFilter();
    loadList();
  }, 350);
}

function bindEvents() {
  els.searchInput.addEventListener("input", debounceSearch);
  els.searchInput.addEventListener("search", () => {
    state.search = els.searchInput.value;
    updateActiveFilter();
    loadList();
  });
  els.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.search = els.searchInput.value;
      updateActiveFilter();
      loadList();
    }
  });
  els.searchBtn.addEventListener("click", () => {
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.search = els.searchInput.value;
    updateActiveFilter();
    loadList();
  });

  els.tabMemories.addEventListener("click", () => setView("memories"));
  els.tabTrash.addEventListener("click", () => setView("trash"));

  els.projectFilter.addEventListener("change", onFilterChanged);
  els.typeFilter.addEventListener("change", onFilterChanged);
  els.scopeFilter.addEventListener("change", onFilterChanged);
  els.limitFilter.addEventListener("change", onFilterChanged);

  els.refreshBtn.addEventListener("click", async () => {
    await loadStatus();
    await loadProjects();
    await loadList();
    await loadStats();
    await loadTrashCount();
    showToast("已刷新");
  });

  els.list.addEventListener("click", (event) => {
    const card = event.target.closest(".card");
    if (!card) return;
    const id = Number(card.getAttribute("data-id"));
    if (id) selectObservation(id);
  });

  els.editor.addEventListener("submit", saveEditor);
  els.restoreBtn.addEventListener("click", restoreCurrent);
  els.deleteBtn.addEventListener("click", () => deleteCurrent(state.trashMode));
  els.hardDeleteBtn.addEventListener("click", () => deleteCurrent(true));
  els.copyIdBtn.addEventListener("click", copyId);
  els.closeEditor.addEventListener("click", clearSelection);

  els.backupBtn.addEventListener("click", async () => {
    els.backupBtn.disabled = true;
    const oldText = els.backupBtn.textContent;
    els.backupBtn.textContent = "备份中…";
    try {
      const result = await api("/panel/backup", { method: "POST" });
      const name = result && result.backup && result.backup.name;
      showToast(name ? "已备份：" + name : "已备份");
    } catch (err) {
      showToast("备份失败：" + (err && err.message ? err.message : "未知错误"), true);
    } finally {
      els.backupBtn.disabled = false;
      els.backupBtn.textContent = oldText;
    }
  });

  els.newBtn.addEventListener("click", openNewModal);
  els.modalClose.addEventListener("click", closeNewModal);
  els.newCancel.addEventListener("click", closeNewModal);
  els.newForm.addEventListener("submit", submitNew);
  els.modal.addEventListener("click", (event) => {
    if (event.target === els.modal) closeNewModal();
  });

  els.quitBtn.addEventListener("click", async () => {
    if (!window.confirm("关闭 Engram 面板服务？\n\n不会删除任何记忆。")) return;
    try {
      await fetch("/api/panel/shutdown", { method: "POST" });
      setConnection(false, "面板已关闭");
      showToast("面板服务已关闭，可以关闭此页面");
    } catch (err) {
      showToast("关闭失败，请关闭运行 server.py 的窗口。", true);
    }
  });

  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "k") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (event.key === "Escape") {
      if (!els.modal.classList.contains("hidden")) {
        closeNewModal();
        return;
      }
      if (window.matchMedia("(max-width: 860px)").matches && els.detailPane.classList.contains("open")) {
        clearSelection();
      }
    }
  });
}

function selectFromHash() {
  const match = /(?:^|[#&])id=(\d+)/.exec(location.hash || "");
  if (match) {
    const id = Number(match[1]);
    if (id) selectObservation(id);
  }
}

async function init() {
  restorePrefs();
  refreshTypeOptions();
  bindEvents();
  applyFiltersToControls();

  await loadStatus();
  try {
    await loadProjects();
  } catch (err) {
    renderListError("项目加载失败：" + (err && err.message ? err.message : "未知错误"));
  }
  await loadList();
  await loadStats();
  await loadTrashCount();
  selectFromHash();
  setInterval(loadStatus, 15000);
}

init();
