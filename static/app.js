const state = {
  root: "",
  tabs: [],      // {id, path, lines, mode, offset, limit, size, binary, hasMore, filtered}
  activeTab: null,
};

const el = (sel) => document.querySelector(sel);
const treeEl = el("#tree");
const tabsEl = el("#tabs");
const panelsEl = el("#panels");
const statusEl = el("#status");

el("#loadBtn").addEventListener("click", loadRoot);
el("#rootInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadRoot();
});

// ---- Historico de busca (estilo Notepad++: combo com os ultimos padroes usados) ----
const HISTORY_KEY = "logviewer.searchHistory";
const HISTORY_MAX = 20;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveToHistory(pattern) {
  if (!pattern || !pattern.trim()) return;
  const trimmed = pattern.trim();
  let hist = loadHistory().filter((p) => p !== trimmed);
  hist.unshift(trimmed);
  hist = hist.slice(0, HISTORY_MAX);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  renderHistoryDatalist();
}

function renderHistoryDatalist() {
  let dl = document.getElementById("searchHistoryList");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "searchHistoryList";
    document.body.appendChild(dl);
  }
  dl.innerHTML = loadHistory()
    .map((p) => `<option value="${escapeHtml(p)}"></option>`)
    .join("");
}
renderHistoryDatalist();

function setStatus(msg, isError) {
  statusEl.textContent = msg || "";
  statusEl.style.color = isError ? "#ff8080" : "#ccc";
}

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

async function loadRoot() {
  const root = el("#rootInput").value.trim();
  if (!root) return;
  state.root = root;
  setStatus("Carregando arvore...");
  treeEl.innerHTML = "";
  try {
    const res = await fetch(`/api/tree?root=${encodeURIComponent(root)}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Erro ao carregar pasta", true);
      return;
    }
    renderTree(data.entries);
    setStatus(
      `${data.entries.length} itens` +
        (data.truncated ? ` (truncado em ${data.max_entries})` : "")
    );
  } catch (err) {
    setStatus("Falha na requisicao: " + err, true);
  }
}

function renderTree(entries) {
  const root = { children: new Map(), is_dir: true, path: "" };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const key = parts[i];
      if (!node.children.has(key)) {
        node.children.set(key, {
          name: key,
          path: parts.slice(0, i + 1).join("/"),
          is_dir: last ? entry.is_dir : true,
          children: new Map(),
          meta: last ? entry : null,
        });
      }
      node = node.children.get(key);
    }
  }
  treeEl.innerHTML = "";
  renderNode(root, treeEl, true);
}

function renderNode(node, container, isRoot) {
  const dirs = [];
  const files = [];
  for (const child of node.children.values()) {
    (child.is_dir ? dirs : files).push(child);
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of dirs) {
    const row = document.createElement("div");
    row.className = "entry dir";
    row.textContent = "▸ " + dir.name;
    const childContainer = document.createElement("div");
    childContainer.style.display = "none";
    childContainer.style.paddingLeft = "14px";
    row.addEventListener("click", () => {
      const open = childContainer.style.display !== "none";
      childContainer.style.display = open ? "none" : "block";
      row.textContent = (open ? "▸ " : "▾ ") + dir.name;
      if (!open && childContainer.childElementCount === 0) {
        renderNode(dir, childContainer, false);
      }
    });
    container.appendChild(row);
    container.appendChild(childContainer);
  }

  for (const file of files) {
    const row = document.createElement("div");
    const isText = file.meta && file.meta.likely_text !== false;
    row.className = "entry file " + (isText ? "text" : "binary");
    row.innerHTML = `${file.name} <span class="size">${fmtSize(file.meta ? file.meta.size : null)}</span>`;
    row.addEventListener("click", () => openFile(file.path));
    container.appendChild(row);
  }
}

function openFile(path, jumpLine) {
  let tab = state.tabs.find((t) => t.path === path);
  if (!tab) {
    tab = {
      id: "t" + Date.now() + Math.random().toString(36).slice(2, 6),
      path,
      lines: [],
      mode: "tail",
      offset: 0,
      limit: 500,
      size: null,
      binary: false,
      hasMore: false,
      selectedLine: null,
    };
    state.tabs.push(tab);
    renderTabs();
    if (jumpLine) {
      jumpToLine(tab, jumpLine);
    } else {
      loadFileContent(tab, { tail: true });
    }
  } else if (jumpLine) {
    jumpToLine(tab, jumpLine);
  }
  setActiveTab(tab.id);
}

function closeTab(id, evt) {
  evt.stopPropagation();
  state.tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeTab === id) {
    state.activeTab = state.tabs.length ? state.tabs[0].id : null;
  }
  renderTabs();
  renderPanels();
}

function setActiveTab(id) {
  state.activeTab = id;
  renderTabs();
  renderPanels();
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const tab of state.tabs) {
    const div = document.createElement("div");
    div.className = "tab" + (tab.id === state.activeTab ? " active" : "");
    div.innerHTML = `<span>${tab.path.split("/").pop()}</span><span class="close">x</span>`;
    div.addEventListener("click", () => setActiveTab(tab.id));
    div.querySelector(".close").addEventListener("click", (e) => closeTab(tab.id, e));
    tabsEl.appendChild(div);
  }
}

async function loadFileContent(tab, { tail = false, offset = 0, limit = null, scrollToLine = null } = {}) {
  const effectiveLimit = limit || tab.limit;
  const params = new URLSearchParams({
    root: state.root,
    file: tab.path,
    limit: effectiveLimit,
  });
  if (tail) {
    params.set("tail", "true");
  } else {
    params.set("offset", offset);
  }
  const res = await fetch(`/api/file?${params}`);
  const data = await res.json();
  if (!res.ok) {
    tab.error = data.error;
    renderPanels();
    return;
  }
  tab.error = null;
  tab.binary = data.binary;
  tab.size = data.size;
  tab.encoding = data.encoding;
  tab.mode = data.mode || "tail";
  tab.offset = tail ? null : offset;
  tab.hasMore = data.has_more;
  tab.lines = data.lines.map((text, i) => ({
    n: tail ? null : offset + i + 1,
    text,
  }));
  renderPanels();
  if (scrollToLine) {
    scrollLogToLine(tab, scrollToLine);
  }
}

async function jumpToLine(tab, lineNumber) {
  tab.selectedLine = lineNumber;
  const contextSpan = Math.floor(tab.limit / 2);
  const offset = Math.max(0, lineNumber - contextSpan - 1);
  await loadFileContent(tab, { offset, limit: tab.limit, scrollToLine: lineNumber });
}

function scrollLogToLine(tab, lineNumber) {
  requestAnimationFrame(() => {
    const panel = panelsEl.querySelector(`[data-panel-id="${tab.id}"]`);
    if (!panel) return;
    const target = panel.querySelector(`.log-area [data-line="${lineNumber}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("line-pulse");
    setTimeout(() => target.classList.remove("line-pulse"), 900);
  });
}

function highlight(text, pattern, caseSensitive) {
  if (!pattern) return escapeHtml(text);
  try {
    const re = new RegExp(pattern, caseSensitive ? "g" : "gi");
    return escapeHtml(text).replace(re, (m) => `<mark>${escapeHtml(m)}</mark>`);
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function renderPanels() {
  panelsEl.innerHTML = "";
  if (!state.tabs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Selecione uma pasta e clique em um arquivo de texto na arvore.";
    panelsEl.appendChild(empty);
    return;
  }
  for (const tab of state.tabs) {
    const panel = document.createElement("div");
    panel.className = "panel" + (tab.id === state.activeTab ? " active" : "");
    panel.dataset.panelId = tab.id;

    const toolbar = document.createElement("div");
    toolbar.className = "panel-toolbar";
    toolbar.innerHTML = `
      <button data-act="tail">Tail</button>
      <button data-act="start">Inicio</button>
      <button data-act="more">Mais</button>
      <span class="info">${tab.path} ${tab.size != null ? "(" + fmtSize(tab.size) + ")" : ""}</span>
    `;
    panel.appendChild(toolbar);

    if (tab.error) {
      const err = document.createElement("div");
      err.className = "panel-toolbar err";
      err.textContent = tab.error;
      panel.appendChild(err);
    }

    const body = document.createElement("div");
    body.className = "panel-body";

    if (tab.binary) {
      body.innerHTML = `<div style="padding:12px;color:#999">Arquivo binario (${fmtSize(tab.size)}) - visualizacao de texto nao disponivel.</div>`;
    } else {
      const logArea = document.createElement("div");
      logArea.className = "log-area";
      const frag = document.createDocumentFragment();
      for (const l of tab.lines) {
        const line = document.createElement("div");
        line.className = "line" + (l.n != null && l.n === tab.selectedLine ? " line-selected" : "");
        if (l.n != null) line.dataset.line = l.n;
        line.innerHTML = `<span class="ln">${l.n ?? ""}</span><span class="txt">${escapeHtml(l.text)}</span>`;
        frag.appendChild(line);
      }
      logArea.appendChild(frag);
      body.appendChild(logArea);
    }

    panel.appendChild(body);
    panelsEl.appendChild(panel);

    toolbar.querySelector('[data-act="tail"]').addEventListener("click", () => {
      tab.selectedLine = null;
      loadFileContent(tab, { tail: true });
    });
    toolbar.querySelector('[data-act="start"]').addEventListener("click", () => {
      tab.selectedLine = null;
      loadFileContent(tab, { offset: 0 });
    });
    toolbar.querySelector('[data-act="more"]').addEventListener("click", () => {
      const nextOffset = (tab.offset || 0) + tab.limit;
      loadFileContent(tab, { offset: nextOffset });
    });
  }
}

// ---- Painel de busca unico (Ctrl+F): arquivo atual, arquivos abertos ou pasta inteira ----
const findPanel = el("#findPanel");
const findPattern = el("#findPattern");
const findResultsEl = el("#findResults");
const findSummaryEl = el("#findSummary");
const findFolderOptions = el("#findFolderOptions");

el("#findInFilesBtn").addEventListener("click", toggleFindPanel);
el("#findCloseBtn").addEventListener("click", closeFindPanel);
el("#findCollapseBtn").addEventListener("click", toggleFindCollapse);

function toggleFindCollapse() {
  findPanel.classList.toggle("collapsed");
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openFindPanel();
  } else if (e.key === "Escape" && !findPanel.hidden) {
    closeFindPanel();
  }
});
document.querySelectorAll('input[name="findScope"]').forEach((r) =>
  r.addEventListener("change", () => {
    findFolderOptions.hidden = document.querySelector('input[name="findScope"]:checked').value !== "folder";
  })
);
el("#findSearchBtn").addEventListener("click", runFindSearch);
findPattern.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runFindSearch();
});
el("#findTag").addEventListener("keydown", (e) => { if (e.key === "Enter") runFindSearch(); });
el("#findPid").addEventListener("keydown", (e) => { if (e.key === "Enter") runFindSearch(); });
el("#findUid").addEventListener("keydown", (e) => { if (e.key === "Enter") runFindSearch(); });
el("#findRefreshFieldsBtn").addEventListener("click", refreshLogFields);

function currentFindScopeParams() {
  const scope = document.querySelector('input[name="findScope"]:checked').value;
  const params = new URLSearchParams({ root: state.root });
  if (scope === "current") {
    const tab = state.tabs.find((t) => t.id === state.activeTab);
    if (!tab) return null;
    params.set("scope", "explicit");
    params.set("files", tab.path);
  } else if (scope === "open") {
    if (!state.tabs.length) return null;
    params.set("scope", "open");
    params.set("open_files", state.tabs.map((t) => t.path).join(","));
  } else {
    params.set("scope", "folder");
    const glob = el("#findGlob").value.trim();
    if (glob) params.set("glob", glob);
  }
  return params;
}

async function refreshLogFields() {
  const params = currentFindScopeParams();
  const infoEl = el("#findFieldsInfo");
  if (!state.root || !params) {
    infoEl.textContent = "Abra um arquivo ou selecione um escopo valido primeiro.";
    return;
  }
  el("#findRefreshFieldsBtn").disabled = true;
  infoEl.textContent = "Escaneando...";
  try {
    const res = await fetch(`/api/log_fields?${params}`);
    const data = await res.json();
    if (!res.ok) {
      infoEl.textContent = data.error || "Erro ao escanear campos.";
      return;
    }
    el("#findTagList").innerHTML = data.tags.map((t) => `<option value="${escapeHtml(t)}">`).join("");
    el("#findPidList").innerHTML = data.pids.map((p) => `<option value="${escapeHtml(p)}">`).join("");
    el("#findUidList").innerHTML = data.uids.map((u) => `<option value="${escapeHtml(u)}">`).join("");
    infoEl.textContent = `${data.lines_parsed} de ${data.lines_scanned} linha(s) reconhecidas como logcat em ${data.files_used} arquivo(s) - ${data.tags.length} tags, ${data.uids.length} uids`;
  } catch (err) {
    infoEl.textContent = "Falha na requisicao: " + err;
  } finally {
    el("#findRefreshFieldsBtn").disabled = false;
  }
}

function toggleFindPanel() {
  if (findPanel.hidden) openFindPanel();
  else closeFindPanel();
}
function openFindPanel() {
  findPanel.hidden = false;
  findPanel.classList.remove("collapsed");
  const currentRadio = document.querySelector('input[name="findScope"][value="current"]');
  if (currentRadio && !state.activeTab) {
    document.querySelector('input[name="findScope"][value="open"]').checked = true;
    findFolderOptions.hidden = true;
  }
  findPattern.focus();
  findPattern.select();
}
function closeFindPanel() {
  findPanel.hidden = true;
}

// Redimensionar arrastando o topo do painel, como o dock de resultados do Notepad++
const findResizeHandle = el("#findResizeHandle");
findResizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = findPanel.getBoundingClientRect().height;
  function onMove(ev) {
    const delta = startY - ev.clientY;
    const newHeight = Math.min(Math.max(startHeight + delta, 140), window.innerHeight * 0.85);
    findPanel.style.height = newHeight + "px";
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

function selectedLevels() {
  return Array.from(document.querySelectorAll("#findLevelChips input:checked")).map((c) => c.value);
}

const FIND_DEFAULT_CAP = 5000;
const FIND_LOAD_ALL_CAP = 200000;

async function runFindSearch(resultCap = FIND_DEFAULT_CAP) {
  const pattern = findPattern.value.trim();
  const levels = selectedLevels();
  const tag = el("#findTag").value.trim();
  const pid = el("#findPid").value.trim();
  const uid = el("#findUid").value.trim();
  const hasAdvanced = levels.length || tag || pid || uid;
  if (!pattern && !hasAdvanced) return;
  if (!state.root) {
    findSummaryEl.textContent = "Carregue uma pasta primeiro.";
    findSummaryEl.className = "find-summary err";
    return;
  }
  if (pattern) saveToHistory(pattern);

  const caseSensitive = el("#findCaseSensitive").checked;
  const params = currentFindScopeParams();
  if (!params) {
    const scope = document.querySelector('input[name="findScope"]:checked').value;
    findSummaryEl.textContent =
      scope === "current" ? "Nenhum arquivo aberto no momento." : "Nenhum arquivo aberto.";
    findSummaryEl.className = "find-summary err";
    return;
  }
  if (pattern) params.set("pattern", pattern);
  params.set("max_results", resultCap);
  params.set("total_max_results", resultCap);
  if (!caseSensitive) params.set("flags", "i");
  if (params.get("scope") === "folder") params.set("max_files", 300);
  if (levels.length) params.set("levels", levels.join(","));
  if (tag) params.set("tags", tag);
  if (pid) params.set("pids", pid);
  if (uid) params.set("uids", uid);

  findSummaryEl.textContent = resultCap > FIND_DEFAULT_CAP ? "Buscando tudo (pode demorar)..." : "Buscando...";
  findSummaryEl.className = "find-summary";
  findResultsEl.innerHTML = "";
  el("#findSearchBtn").disabled = true;

  try {
    const res = await fetch(`/api/search?${params}`);
    const data = await res.json();
    if (!res.ok) {
      findSummaryEl.textContent = data.error || "Erro na busca.";
      findSummaryEl.className = "find-summary err";
      return;
    }
    renderFindResults(data, pattern, caseSensitive, resultCap);
  } catch (err) {
    findSummaryEl.textContent = "Falha na requisicao: " + err;
    findSummaryEl.className = "find-summary err";
  } finally {
    el("#findSearchBtn").disabled = false;
  }
}

function renderFindResults(data, pattern, caseSensitive, resultCap) {
  const filesWithMatches = data.results.filter((r) => r.matches && r.matches.length);
  const anyTruncated = data.results.some((r) => r.truncated) || data.files_truncated;
  findSummaryEl.className = "find-summary";
  findSummaryEl.textContent =
    `${data.total_matches} ocorrencia(s) em ${filesWithMatches.length} de ${data.files_searched} arquivo(s)` +
    (data.files_truncated ? " (lista de arquivos truncada)" : "");

  const oldLoadAllBtn = el("#findLoadAllBtn");
  if (oldLoadAllBtn) oldLoadAllBtn.remove();
  if (anyTruncated && resultCap < FIND_LOAD_ALL_CAP) {
    const btn = document.createElement("button");
    btn.id = "findLoadAllBtn";
    btn.className = "find-load-all";
    btn.textContent = "Resultado incompleto (limite atingido) - carregar tudo";
    btn.addEventListener("click", () => runFindSearch(FIND_LOAD_ALL_CAP));
    findSummaryEl.after(btn);
  }

  findResultsEl.innerHTML = "";
  if (!filesWithMatches.length) {
    const empty = document.createElement("div");
    empty.className = "find-empty";
    empty.textContent = "Nenhum resultado.";
    findResultsEl.appendChild(empty);
    return;
  }

  for (const fileResult of filesWithMatches) {
    const group = document.createElement("div");
    group.className = "find-file-group";

    const header = document.createElement("div");
    header.className = "find-file-header";
    header.innerHTML = `${escapeHtml(fileResult.path)} <span class="count">(${fileResult.matches.length}${fileResult.truncated ? "+" : ""} ocorrencia(s))</span>`;
    const body = document.createElement("div");
    header.addEventListener("click", () => {
      body.style.display = body.style.display === "none" ? "block" : "none";
    });
    group.appendChild(header);

    for (const m of fileResult.matches) {
      const line = document.createElement("div");
      line.className = "line";
      const badge = m.level ? `<span class="badge badge-${m.level}">${m.level}</span>` : "";
      line.innerHTML = `<span class="ln">${m.line_number}</span><span class="txt">${badge}${highlight(m.line, pattern, caseSensitive)}</span>`;
      line.addEventListener("click", () => {
        openFile(fileResult.path, m.line_number);
      });
      body.appendChild(line);
    }
    group.appendChild(body);
    findResultsEl.appendChild(group);
  }
}
