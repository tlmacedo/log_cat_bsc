/* Log Viewer - visualizador offline de logcat.
 *
 * A tabela, as cores por nivel, o menu de contexto (mostrar/esconder/destacar
 * TAG e PID) e os filtros salvos seguem o LogcatOfflineView; o filtro ao vivo
 * com prefixos e condicoes negadas segue o LogRabbit. A aba lateral
 * "Dispositivo" e alimentada por /api/device_info.
 */

const LEVELS = ["V", "D", "I", "W", "E", "F"];
const PAGE_SIZES = [500, 2000, 5000, 10000, 20000];
const DEFAULT_PAGE_SIZE = 2000;

const state = {
  root: "",
  tabs: [],
  activeTab: null,
  savedFilters: [],
  selectedFilterId: null,
  editingFilterId: null,
  // Divisao da area de log, no estilo main/events/radio do LogcatOfflineView.
  paneCount: 1,
  panes: [null, null, null],
  focusedPane: 0,
  syncTime: true,
};

const el = (sel) => document.querySelector(sel);
const treeEl = el("#tree");
const tabsEl = el("#tabs");
const panelsEl = el("#panels");
const statusEl = el("#status");

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

function fmtNum(n) {
  return n == null ? "" : n.toLocaleString("pt-BR");
}

function setStatus(msg, isError) {
  statusEl.textContent = msg || "";
  statusEl.style.color = isError ? "var(--lvl-E)" : "var(--fg-dim)";
}

function store(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function persist(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* cota cheia ou modo privado: preferencias sao descartaveis */ }
}

function safeRegex(pattern, caseSensitive) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    // Padrao invalido como regex ainda serve como busca literal.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, caseSensitive ? "" : "i");
  }
}

async function copyToClipboard(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(okMsg || "Copiado.");
  } catch {
    setStatus("Nao foi possivel copiar (permissao do navegador).", true);
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

const THEME_KEY = "logviewer.theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  persist(THEME_KEY, theme);
}
applyTheme(store(THEME_KEY, "light"));

el("#themeBtn").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

// ---------------------------------------------------------------------------
// Abas da barra lateral
// ---------------------------------------------------------------------------

document.querySelectorAll(".side-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".side-tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".side-pane").forEach((p) =>
      p.classList.toggle("active", p.dataset.pane === btn.dataset.side));
  });
});

const sidebar = el("#sidebar");
el("#sidebarResize").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebar.getBoundingClientRect().width;
  const onMove = (ev) => {
    sidebar.style.width = Math.min(Math.max(startW + ev.clientX - startX, 180), window.innerWidth * 0.6) + "px";
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// ---------------------------------------------------------------------------
// Arvore de arquivos
// ---------------------------------------------------------------------------

el("#loadBtn").addEventListener("click", loadRoot);
el("#rootInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadRoot();
});

const ROOT_KEY = "logviewer.lastRoot";
const lastRoot = store(ROOT_KEY, "");
if (lastRoot) el("#rootInput").value = lastRoot;

async function loadRoot() {
  const root = el("#rootInput").value.trim();
  if (!root) return;
  state.root = root;
  persist(ROOT_KEY, root);
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
    setStatus(`${data.entries.length} itens` +
      (data.truncated ? ` (truncado em ${data.max_entries})` : ""));
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
  renderNode(root, treeEl);
}

function renderNode(node, container) {
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
        renderNode(dir, childContainer);
      }
    });
    container.appendChild(row);
    container.appendChild(childContainer);
  }

  for (const file of files) {
    const row = document.createElement("div");
    const isText = file.meta && file.meta.likely_text !== false;
    row.className = "entry file " + (isText ? "text" : "binary");
    row.innerHTML = `${escapeHtml(file.name)} <span class="size">${fmtSize(file.meta ? file.meta.size : null)}</span>`;
    row.addEventListener("click", () => openFile(file.path));
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Abas de arquivo
// ---------------------------------------------------------------------------

function newTab(path) {
  return {
    id: "t" + Date.now() + Math.random().toString(36).slice(2, 6),
    path,
    lines: [],
    mode: "range",
    offset: 0,
    limit: DEFAULT_PAGE_SIZE,
    size: null,
    totalLines: 0,
    format: null,
    encoding: null,
    binary: false,
    hasMore: false,
    error: null,
    // Filtros no estilo do menu de contexto do LogcatOfflineView.
    levels: new Set(),
    showTags: new Set(),
    hideTags: new Set(),
    showPids: new Set(),
    hidePids: new Set(),
    highlightTags: new Set(),
    highlightPids: new Set(),
    liveFilter: "",
    activeFilterId: null,
    wrapText: false,
    // Estado de interacao.
    selected: new Set(),
    lastClicked: null,
    bookmarks: new Set(),
    searchTerm: "",
    searchHits: [],
    searchIdx: -1,
    jumpLine: null,
  };
}

function openFile(path, jumpLine) {
  let tab = state.tabs.find((t) => t.path === path);
  if (!tab) {
    tab = newTab(path);
    state.tabs.push(tab);
    // O arquivo recem-aberto assume o painel em foco.
    state.panes[state.focusedPane] = tab.id;
    state.activeTab = tab.id;
    renderTabs();
    if (jumpLine) {
      jumpToLine(tab, jumpLine);
    } else {
      loadFileContent(tab, { offset: 0 });
    }
    return;
  }
  if (jumpLine) jumpToLine(tab, jumpLine);
  setActiveTab(tab.id);
}

function closeTab(id, evt) {
  evt.stopPropagation();
  state.tabs = state.tabs.filter((t) => t.id !== id);
  for (let i = 0; i < state.panes.length; i++) {
    if (state.panes[i] === id) state.panes[i] = null;
  }
  if (state.activeTab === id) {
    state.activeTab = state.tabs.length ? state.tabs[0].id : null;
  }
  renderTabs();
  renderPanels();
}

/** Coloca a aba no painel em foco e a torna a aba corrente. */
function setActiveTab(id) {
  state.activeTab = id;
  state.panes[state.focusedPane] = id;
  renderTabs();
  renderPanels();
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTab) || null;
}

function tabInPane(index) {
  return state.tabs.find((t) => t.id === state.panes[index]) || null;
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const tab of state.tabs) {
    const div = document.createElement("div");
    const inPane = state.panes.slice(0, state.paneCount).includes(tab.id);
    div.className = "tab" + (tab.id === state.activeTab ? " active" : "") + (inPane ? " shown" : "");
    div.title = tab.path;
    div.innerHTML = `<span>${escapeHtml(tab.path.split("/").pop())}</span><span class="close">&times;</span>`;
    div.addEventListener("click", () => setActiveTab(tab.id));
    div.querySelector(".close").addEventListener("click", (e) => closeTab(tab.id, e));
    tabsEl.appendChild(div);
  }
}

// ---- Divisao em paineis e sincronizacao por horario ----

el("#paneCount").addEventListener("change", (e) => {
  state.paneCount = Number(e.target.value);
  if (state.focusedPane >= state.paneCount) state.focusedPane = 0;
  renderTabs();
  renderPanels();
});
el("#syncTime").addEventListener("change", (e) => { state.syncTime = e.target.checked; });

const TIME_RE = /^(?:\d{4}-)?(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})[.,](\d+)$/;

/** Converte o timestamp do logcat em milissegundos comparaveis. O ano nao
 *  aparece na maioria dos formatos, entao a escala usa mes*31+dia: e monotonica
 *  dentro de uma captura, que e o alcance em que a sincronizacao faz sentido. */
function timeValue(t) {
  const m = TIME_RE.exec(t || "");
  if (!m) return null;
  const ms = Number((m[6] + "000").slice(0, 3));
  return ((((Number(m[1]) * 31 + Number(m[2])) * 24 + Number(m[3])) * 60
    + Number(m[4])) * 60 + Number(m[5])) * 1000 + ms;
}

/** Linha do painel cujo horario e o mais proximo do alvo, dentro da pagina carregada. */
function nearestLineByTime(tab, target) {
  let best = null;
  let bestDelta = Infinity;
  for (const line of tab.lines) {
    const value = timeValue(line.c && line.c.time);
    if (value === null) continue;
    const delta = Math.abs(value - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = line;
      if (delta === 0) break;
    }
  }
  return best ? { line: best, delta: bestDelta } : null;
}

/** Faz os demais paineis pularem para o horario da linha clicada. */
function syncPanesToTime(sourceTab, line) {
  if (!state.syncTime || state.paneCount < 2) return;
  const target = timeValue(line.c && line.c.time);
  if (target === null) return;
  let synced = 0;
  let noTimestamps = 0;
  let worstDelta = 0;
  for (let i = 0; i < state.paneCount; i++) {
    const tab = tabInPane(i);
    if (!tab || tab.id === sourceTab.id) continue;
    const near = nearestLineByTime(tab, target);
    if (!near) { noTimestamps++; continue; }
    tab.selected.clear();
    tab.selected.add(near.line.n);
    refreshPanel(tab);
    scrollLogToLine(tab, near.line.n, i);
    worstDelta = Math.max(worstDelta, near.delta);
    synced++;
  }
  if (!synced && noTimestamps) {
    setStatus("Os outros paineis nao tem linhas com horario nesta pagina.", true);
  } else if (synced && worstDelta > 5000) {
    // A busca so enxerga a pagina carregada; avisa quando o mais proximo esta longe.
    setStatus(`Sincronizado, mas o horario mais proximo carregado esta a ` +
      `${(worstDelta / 1000).toFixed(1)}s - navegue ate a faixa correspondente.`);
  }
}

async function loadFileContent(tab, { tail = false, offset = 0, limit = null, scrollToLine = null } = {}) {
  const effectiveLimit = limit || tab.limit;
  const params = new URLSearchParams({
    root: state.root,
    file: tab.path,
    limit: effectiveLimit,
  });
  if (tail) params.set("tail", "true");
  else params.set("offset", offset);

  setStatus("Carregando " + tab.path.split("/").pop() + "...");
  let data;
  try {
    const res = await fetch(`/api/file?${params}`);
    data = await res.json();
    if (!res.ok) {
      tab.error = data.error;
      renderPanels();
      setStatus(data.error, true);
      return;
    }
  } catch (err) {
    tab.error = "Falha na requisicao: " + err;
    renderPanels();
    return;
  }

  tab.error = null;
  tab.binary = data.binary;
  tab.size = data.size;
  tab.encoding = data.encoding;
  tab.totalLines = data.total_lines || 0;
  tab.format = data.format || null;
  tab.mode = data.mode || "range";
  tab.offset = data.offset || 0;
  tab.limit = effectiveLimit;
  tab.hasMore = !!data.has_more;
  const cols = data.columns || [];
  tab.lines = data.lines.map((text, i) => ({
    n: tab.offset + i + 1,
    text,
    c: cols[i] || null,
  }));
  tab.selected.clear();
  tab.lastClicked = null;
  recomputeSearch(tab);
  renderPanels();
  setStatus(`${tab.path.split("/").pop()}: linhas ${fmtNum(tab.offset + 1)}-` +
    `${fmtNum(tab.offset + tab.lines.length)} de ${fmtNum(tab.totalLines)}` +
    (tab.format ? ` | formato ${tab.format}` : ""));
  if (scrollToLine) scrollLogToLine(tab, scrollToLine);
}

async function jumpToLine(tab, lineNumber) {
  const offset = Math.max(0, lineNumber - Math.floor(tab.limit / 2) - 1);
  tab.jumpLine = lineNumber;
  await loadFileContent(tab, { offset, scrollToLine: lineNumber });
}

function scrollLogToLine(tab, lineNumber, paneIndex) {
  requestAnimationFrame(() => {
    const selector = paneIndex == null
      ? `[data-panel-id="${tab.id}"]`
      : `[data-panel-id="${tab.id}"][data-pane-index="${paneIndex}"]`;
    for (const panel of panelsEl.querySelectorAll(selector)) {
      const target = panel.querySelector(`tr[data-line="${lineNumber}"]`);
      if (!target) continue;
      // scrollIntoView rolaria a pagina inteira quando ha varios paineis;
      // ajustar o scrollTop do proprio container mantem os outros parados.
      const wrap = panel.querySelector(".log-wrap");
      if (wrap) {
        suppressScrollHide = true;
        wrap.scrollTop = target.offsetTop - wrap.clientHeight / 2 + target.offsetHeight / 2;
        setTimeout(() => { suppressScrollHide = false; }, 0);
      }
      target.classList.add("line-pulse");
      setTimeout(() => target.classList.remove("line-pulse"), 900);
    }
  });
}

// ---------------------------------------------------------------------------
// Filtro ao vivo: "pid:123 tag:Vold -text:debug erro"
// ---------------------------------------------------------------------------

const FIELD_PREFIXES = {
  "pid:": "pid", "tid:": "tid", "tag:": "tag", "uid:": "uid",
  "app:": "tag", "text:": "msg", "msg:": "msg",
  "level:": "level", "lvl:": "level",
};

function parseLiveFilter(query, caseSensitive) {
  const terms = [];
  for (let raw of (query || "").trim().split(/\s+/)) {
    if (!raw) continue;
    let negate = false;
    if (raw.startsWith("-") && raw.length > 1) {
      negate = true;
      raw = raw.slice(1);
    }
    let field = null;
    let value = raw;
    for (const [prefix, name] of Object.entries(FIELD_PREFIXES)) {
      if (raw.toLowerCase().startsWith(prefix)) {
        field = name;
        value = raw.slice(prefix.length);
        break;
      }
    }
    if (!value) continue;
    terms.push({ field, negate, re: safeRegex(value, caseSensitive) });
  }
  return terms;
}

function termMatches(term, line) {
  const c = line.c;
  let subject;
  if (!term.field) {
    subject = line.text;
  } else if (!c) {
    // Linha que nao e logcat nao tem campos; um termo por campo nao casa.
    subject = "";
  } else if (term.field === "level") {
    subject = c.level || "";
  } else {
    subject = c[term.field] || "";
  }
  return term.re.test(subject);
}

function savedFilterMatches(filter, line) {
  const c = line.c;
  const cs = !!filter.caseSensitive;
  if (filter.levels && filter.levels.length) {
    if (!c || !filter.levels.includes(c.level)) return false;
  }
  const fields = [
    ["tag", filter.tag], ["msg", filter.text],
    ["pid", filter.pid], ["tid", filter.tid],
  ];
  for (const [name, pattern] of fields) {
    if (!pattern) continue;
    const re = safeRegex(pattern, cs);
    const subject = name === "msg" && !c ? line.text : (c ? c[name] || "" : "");
    if (!re.test(subject)) return false;
  }
  return true;
}

function visibleLines(tab) {
  const terms = parseLiveFilter(tab.liveFilter, false);
  const filter = state.savedFilters.find((f) => f.id === tab.activeFilterId) || null;
  const out = [];
  for (const line of tab.lines) {
    const c = line.c;

    if (tab.levels.size) {
      if (!c || !tab.levels.has(c.level)) continue;
    }
    if (tab.showTags.size && (!c || !tab.showTags.has(c.tag))) continue;
    if (c && tab.hideTags.has(c.tag)) continue;
    if (tab.showPids.size && (!c || !tab.showPids.has(c.pid))) continue;
    if (c && tab.hidePids.has(c.pid)) continue;

    if (filter) {
      const hit = savedFilterMatches(filter, line);
      if (filter.negate ? hit : !hit) continue;
    }

    let ok = true;
    for (const term of terms) {
      const hit = termMatches(term, line);
      if (term.negate ? hit : !hit) { ok = false; break; }
    }
    if (!ok) continue;

    out.push(line);
  }
  return out;
}

function recomputeSearch(tab) {
  tab.searchHits = [];
  tab.searchIdx = -1;
  if (!tab.searchTerm) return;
  const re = safeRegex(tab.searchTerm, false);
  if (!re) return;
  for (const line of visibleLines(tab)) {
    if (re.test(line.text)) tab.searchHits.push(line.n);
  }
}

// ---------------------------------------------------------------------------
// Render dos paineis de log
// ---------------------------------------------------------------------------

function highlightHtml(text, term) {
  if (!term) return escapeHtml(text);
  let re;
  try {
    re = new RegExp(term, "gi");
  } catch {
    re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
  return escapeHtml(text).replace(re, (m) => `<mark>${m}</mark>`);
}

function isHighlighted(tab, line) {
  const c = line.c;
  if (!c) return false;
  return (c.tag && tab.highlightTags.has(c.tag)) || (c.pid && tab.highlightPids.has(c.pid));
}

function rowHtml(tab, line) {
  const c = line.c;
  const classes = ["lvl-" + (c && c.level ? c.level : "none")];
  if (tab.selected.has(line.n)) classes.push("selected");
  if (isHighlighted(tab, line)) classes.push("highlighted");
  if (tab.bookmarks.has(line.n)) classes.push("bookmarked");

  const term = tab.searchTerm;
  if (!c) {
    // Linha fora do formato logcat (cabecalho de bugreport, dumpsys, etc):
    // mostra o texto cru ocupando as colunas de conteudo.
    return `<tr class="${classes.join(" ")}" data-line="${line.n}">` +
      `<td class="c-n">${line.n}</td>` +
      `<td class="c-lvl"></td><td class="c-time"></td><td class="c-pid"></td>` +
      `<td class="c-tid"></td><td class="c-tag"></td>` +
      `<td class="c-text c-raw">${highlightHtml(line.text, term)}</td></tr>`;
  }
  return `<tr class="${classes.join(" ")}" data-line="${line.n}"` +
    ` data-tag="${escapeHtml(c.tag || "")}" data-pid="${escapeHtml(c.pid || "")}">` +
    `<td class="c-n">${line.n}</td>` +
    `<td class="c-lvl">${escapeHtml(c.level || "")}</td>` +
    `<td class="c-time">${escapeHtml(c.time || "")}</td>` +
    `<td class="c-pid">${escapeHtml(c.pid || "")}</td>` +
    `<td class="c-tid">${escapeHtml(c.tid || "")}</td>` +
    `<td class="c-tag">${escapeHtml(c.tag || "")}</td>` +
    `<td class="c-text">${highlightHtml(c.msg ?? line.text, term)}</td></tr>`;
}

function renderPanels() {
  panelsEl.innerHTML = "";
  if (!state.tabs.length) {
    panelsEl.innerHTML = '<div class="empty-state">Selecione uma pasta e clique em um arquivo de texto na arvore.</div>';
    return;
  }
  // Preenche paineis vazios com as abas abertas, sem repetir enquanto houver
  // aba disponivel para cada painel.
  for (let i = 0; i < state.paneCount; i++) {
    if (state.panes[i] && state.tabs.some((t) => t.id === state.panes[i])) continue;
    const taken = new Set(state.panes.slice(0, state.paneCount));
    const free = state.tabs.find((t) => !taken.has(t.id));
    state.panes[i] = (free || state.tabs[0]).id;
  }
  for (let i = 0; i < state.paneCount; i++) {
    const tab = tabInPane(i);
    if (!tab) continue;
    const pane = document.createElement("div");
    pane.className = "pane" + (i === state.focusedPane && state.paneCount > 1 ? " focused" : "");
    pane.dataset.paneIndex = i;
    pane.addEventListener("mousedown", () => {
      if (state.focusedPane === i) return;
      state.focusedPane = i;
      state.activeTab = tab.id;
      renderTabs();
      panelsEl.querySelectorAll(".pane").forEach((p) =>
        p.classList.toggle("focused", p.dataset.paneIndex === String(i) && state.paneCount > 1));
    });
    pane.appendChild(buildPanel(tab, i));
    panelsEl.appendChild(pane);
  }
}

function buildPanel(tab, paneIndex) {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.dataset.panelId = tab.id;
  panel.dataset.paneIndex = paneIndex;

  const shown = tab.binary ? [] : visibleLines(tab);

  // --- barra de ferramentas -------------------------------------------------
  const toolbar = document.createElement("div");
  toolbar.className = "panel-toolbar";
  const paneSelect = state.paneCount > 1
    ? `<select class="pane-file" title="Arquivo exibido neste painel">` +
      state.tabs.map((t) =>
        `<option value="${t.id}"${t.id === tab.id ? " selected" : ""}>` +
        `${escapeHtml(t.path.split("/").pop())}</option>`).join("") +
      `</select>`
    : "";
  toolbar.innerHTML = `
    ${paneSelect}
    <input class="live-filter" value="${escapeHtml(tab.liveFilter)}"
      placeholder="Filtrar: texto, regex, ou pid: tid: tag: app: text: level:  (prefixo - nega)"
      title="Aceita regex. Prefixos: pid: tid: tag: app: text: level:. Um '-' antes do termo esconde as linhas que casarem.">
    <div class="level-toggles">
      ${LEVELS.map((l) => `<button class="level-toggle${tab.levels.has(l) ? " on" : ""}" data-level="${l}" title="Nivel ${l}">${l}</button>`).join("")}
    </div>
    <span class="toolbar-sep"></span>
    <button data-act="start" title="Ir para o inicio do arquivo">&#8676; Inicio</button>
    <button data-act="prev" title="Pagina anterior" ${tab.offset === 0 ? "disabled" : ""}>&#8592;</button>
    <button data-act="next" title="Proxima pagina" ${tab.hasMore ? "" : "disabled"}>&#8594;</button>
    <button data-act="tail" title="Ir para o fim do arquivo">Fim &#8677;</button>
    <select data-act="pagesize" title="Linhas por pagina">
      ${PAGE_SIZES.map((n) => `<option value="${n}"${n === tab.limit ? " selected" : ""}>${fmtNum(n)} linhas</option>`).join("")}
    </select>
    <span class="toolbar-sep"></span>
    <button data-act="find" title="Buscar e destacar nesta pagina (Ctrl+F)">&#128269;</button>
    <button data-act="prevhit" title="Ocorrencia anterior (Ctrl+,)">&#8963;</button>
    <button data-act="nexthit" title="Proxima ocorrencia (Ctrl+.)">&#8964;</button>
    <button data-act="wrap" class="${tab.wrapText ? "on-toggle" : ""}" title="Quebrar linhas longas em vez de rolar na horizontal">&#8617;</button>
    <button data-act="export" title="Exportar as linhas visiveis (ou a selecao) para arquivo">Exportar</button>
    <button data-act="reset" title="Limpar todos os filtros e destaques">Limpar filtros</button>
    <span class="info"></span>
  `;
  panel.appendChild(toolbar);

  const info = toolbar.querySelector(".info");
  const hidden = tab.lines.length - shown.length;
  info.textContent =
    `${fmtNum(shown.length)} linha(s)` +
    (hidden > 0 ? ` (${fmtNum(hidden)} ocultada(s) por filtro)` : "") +
    ` | ${fmtNum(tab.offset + 1)}-${fmtNum(tab.offset + tab.lines.length)} de ${fmtNum(tab.totalLines)}` +
    (tab.size != null ? ` | ${fmtSize(tab.size)}` : "") +
    (tab.searchHits.length ? ` | ${tab.searchHits.length} ocorrencia(s)` : "");

  if (tab.error) {
    const err = document.createElement("div");
    err.className = "panel-toolbar err";
    err.textContent = tab.error;
    panel.appendChild(err);
  }

  // --- corpo ---------------------------------------------------------------
  const wrap = document.createElement("div");
  wrap.className = "log-wrap";
  if (tab.binary) {
    wrap.innerHTML = `<div class="empty-state">Arquivo binario (${fmtSize(tab.size)}) - visualizacao de texto nao disponivel.</div>`;
  } else if (!shown.length) {
    wrap.innerHTML = `<div class="empty-state">Nenhuma linha para exibir${tab.lines.length ? " com os filtros atuais" : ""}.</div>`;
  } else {
    wrap.innerHTML =
      `<table class="log-table${tab.wrapText ? " wrap" : ""}"><thead><tr>` +
      '<th class="c-n">Linha</th><th>L.</th><th>Hora</th><th>PID</th><th>TID</th><th>Tag</th><th>Texto</th>' +
      "</tr></thead><tbody>" +
      shown.map((l) => rowHtml(tab, l)).join("") +
      "</tbody></table>";
  }
  panel.appendChild(wrap);

  wirePanel(tab, panel, toolbar, wrap, shown, paneIndex);
  return panel;
}

function wirePanel(tab, panel, toolbar, wrap, shown, paneIndex) {
  const fileSelect = toolbar.querySelector(".pane-file");
  if (fileSelect) {
    fileSelect.addEventListener("change", (e) => {
      state.panes[paneIndex] = e.target.value;
      state.focusedPane = paneIndex;
      state.activeTab = e.target.value;
      renderTabs();
      renderPanels();
    });
  }

  const liveInput = toolbar.querySelector(".live-filter");
  let debounce;
  liveInput.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      tab.liveFilter = liveInput.value;
      recomputeSearch(tab);
      refreshPanel(tab);
    }, 180);
  });

  toolbar.querySelectorAll(".level-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lvl = btn.dataset.level;
      if (tab.levels.has(lvl)) tab.levels.delete(lvl);
      else tab.levels.add(lvl);
      recomputeSearch(tab);
      refreshPanel(tab);
    });
  });

  const act = (name) => toolbar.querySelector(`[data-act="${name}"]`);
  act("start").addEventListener("click", () => loadFileContent(tab, { offset: 0 }));
  act("tail").addEventListener("click", () => loadFileContent(tab, { tail: true }));
  act("prev").addEventListener("click", () =>
    loadFileContent(tab, { offset: Math.max(0, tab.offset - tab.limit) }));
  act("next").addEventListener("click", () =>
    loadFileContent(tab, { offset: tab.offset + tab.limit }));
  act("pagesize").addEventListener("change", (e) => {
    tab.limit = Number(e.target.value);
    loadFileContent(tab, { offset: tab.offset });
  });
  act("find").addEventListener("click", () => promptSearch(tab));
  act("prevhit").addEventListener("click", () => stepSearch(tab, -1));
  act("nexthit").addEventListener("click", () => stepSearch(tab, 1));
  act("wrap").addEventListener("click", () => {
    tab.wrapText = !tab.wrapText;
    refreshPanel(tab);
  });
  act("export").addEventListener("click", () => exportLines(tab, shown));
  act("reset").addEventListener("click", () => resetFilters(tab));

  const tbody = wrap.querySelector("tbody");
  if (!tbody) return;

  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-line]");
    if (!tr) return;
    const n = Number(tr.dataset.line);
    if (e.shiftKey && tab.lastClicked != null) {
      const [a, b] = [tab.lastClicked, n].sort((x, y) => x - y);
      for (const l of shown) if (l.n >= a && l.n <= b) tab.selected.add(l.n);
    } else if (e.ctrlKey || e.metaKey) {
      if (tab.selected.has(n)) tab.selected.delete(n);
      else tab.selected.add(n);
      tab.lastClicked = n;
    } else {
      tab.selected.clear();
      tab.selected.add(n);
      tab.lastClicked = n;
    }
    refreshPanel(tab);
    const line = tab.lines.find((l) => l.n === n);
    if (line) syncPanesToTime(tab, line);
  });

  tbody.addEventListener("dblclick", (e) => {
    const tr = e.target.closest("tr[data-line]");
    if (!tr) return;
    const line = tab.lines.find((l) => l.n === Number(tr.dataset.line));
    if (line) showMessageDialog(tab, line);
  });

  tbody.addEventListener("contextmenu", (e) => {
    const tr = e.target.closest("tr[data-line]");
    if (!tr) return;
    e.preventDefault();
    const n = Number(tr.dataset.line);
    if (!tab.selected.has(n)) {
      tab.selected.clear();
      tab.selected.add(n);
      tab.lastClicked = n;
      refreshPanel(tab);
    }
    showContextMenu(e.clientX, e.clientY, tab);
  });
}

/** Redesenha os paineis que mostram esta aba, preservando a rolagem. */
function refreshPanel(tab) {
  const targets = [...panelsEl.querySelectorAll(`[data-panel-id="${tab.id}"]`)];
  if (!targets.length) {
    renderPanels();
    return;
  }
  const activeIsFilter = document.activeElement?.classList?.contains("live-filter");
  const caret = activeIsFilter ? document.activeElement.selectionStart : null;
  const focusedPanel = activeIsFilter ? document.activeElement.closest(".panel") : null;

  for (const old of targets) {
    const paneIndex = Number(old.dataset.paneIndex);
    const scrollTop = old.querySelector(".log-wrap")?.scrollTop ?? 0;
    const wasFocused = old === focusedPanel;

    const fresh = buildPanel(tab, paneIndex);
    old.replaceWith(fresh);

    const wrap = fresh.querySelector(".log-wrap");
    if (wrap && scrollTop) {
      // Restaurar a rolagem dispara um evento de scroll; sem essa trava ele
      // fecharia o menu de contexto que acabou de ser aberto sobre a linha.
      suppressScrollHide = true;
      wrap.scrollTop = scrollTop;
      setTimeout(() => { suppressScrollHide = false; }, 0);
    }
    if (wasFocused) {
      const input = fresh.querySelector(".live-filter");
      if (input) {
        input.focus();
        if (caret != null) input.setSelectionRange(caret, caret);
      }
    }
  }
}

function resetFilters(tab) {
  tab.levels.clear();
  tab.showTags.clear();
  tab.hideTags.clear();
  tab.showPids.clear();
  tab.hidePids.clear();
  tab.highlightTags.clear();
  tab.highlightPids.clear();
  tab.liveFilter = "";
  tab.activeFilterId = null;
  tab.searchTerm = "";
  recomputeSearch(tab);
  state.selectedFilterId = null;
  renderFilterList();
  refreshPanel(tab);
  setStatus("Filtros e destaques limpos.");
}

function exportLines(tab, shown) {
  const source = tab.selected.size
    ? tab.lines.filter((l) => tab.selected.has(l.n))
    : shown;
  if (!source.length) {
    setStatus("Nada para exportar.", true);
    return;
  }
  const body = source.map((l) => l.text).join("\n");
  const base = tab.path.split("/").pop().replace(/\.[^.]+$/, "");
  downloadText(`${base}-selecao.txt`, body + "\n");
  setStatus(`${source.length} linha(s) exportada(s).`);
}

function promptSearch(tab) {
  const term = window.prompt("Buscar e destacar nesta pagina (aceita regex):", tab.searchTerm || "");
  if (term === null) return;
  tab.searchTerm = term.trim();
  recomputeSearch(tab);
  refreshPanel(tab);
  if (tab.searchHits.length) {
    tab.searchIdx = 0;
    scrollLogToLine(tab, tab.searchHits[0]);
    setStatus(`${tab.searchHits.length} ocorrencia(s) nesta pagina.`);
  } else if (tab.searchTerm) {
    setStatus("Nenhuma ocorrencia nesta pagina.", true);
  }
}

function stepSearch(tab, delta) {
  if (!tab.searchHits.length) {
    setStatus("Nenhuma busca ativa nesta pagina.", true);
    return;
  }
  tab.searchIdx = (tab.searchIdx + delta + tab.searchHits.length) % tab.searchHits.length;
  const n = tab.searchHits[tab.searchIdx];
  tab.selected.clear();
  tab.selected.add(n);
  refreshPanel(tab);
  scrollLogToLine(tab, n);
  setStatus(`Ocorrencia ${tab.searchIdx + 1} de ${tab.searchHits.length} (linha ${fmtNum(n)}).`);
}

// ---------------------------------------------------------------------------
// Menu de contexto da tabela
// ---------------------------------------------------------------------------

const ctxMenu = el("#ctxMenu");

function selectedFieldValues(tab, field) {
  const values = new Set();
  for (const line of tab.lines) {
    if (tab.selected.has(line.n) && line.c && line.c[field]) values.add(line.c[field]);
  }
  return values;
}

function showContextMenu(x, y, tab) {
  const tags = selectedFieldValues(tab, "tag");
  const pids = selectedFieldValues(tab, "pid");
  const tagLabel = tags.size ? ` (${[...tags].slice(0, 2).join(", ")}${tags.size > 2 ? "..." : ""})` : "";
  const pidLabel = pids.size ? ` (${[...pids].slice(0, 3).join(", ")}${pids.size > 3 ? "..." : ""})` : "";

  const items = [
    { label: "Copiar linha(s)", act: () => copySelection(tab) },
    { label: "Exportar selecao...", act: () => exportLines(tab, []) },
    { label: "Marcar/desmarcar (bookmark)", act: () => toggleBookmarks(tab) },
    { sep: true },
    { label: "Mostrar so a(s) TAG(s)" + tagLabel, disabled: !tags.size,
      act: () => { tags.forEach((t) => tab.showTags.add(t)); } },
    { label: "Esconder a(s) TAG(s)" + tagLabel, disabled: !tags.size,
      act: () => { tags.forEach((t) => tab.hideTags.add(t)); } },
    { label: "Destacar a(s) TAG(s)" + tagLabel, disabled: !tags.size,
      act: () => { tags.forEach((t) => tab.highlightTags.add(t)); } },
    { label: "Limpar filtro de TAG", act: () => { tab.showTags.clear(); tab.hideTags.clear(); } },
    { sep: true },
    { label: "Mostrar so o(s) PID(s)" + pidLabel, disabled: !pids.size,
      act: () => { pids.forEach((p) => tab.showPids.add(p)); } },
    { label: "Esconder o(s) PID(s)" + pidLabel, disabled: !pids.size,
      act: () => { pids.forEach((p) => tab.hidePids.add(p)); } },
    { label: "Destacar o(s) PID(s)" + pidLabel, disabled: !pids.size,
      act: () => { pids.forEach((p) => tab.highlightPids.add(p)); } },
    { label: "Limpar filtro de PID", act: () => { tab.showPids.clear(); tab.hidePids.clear(); } },
    { sep: true },
    { label: "Limpar destaques", act: () => { tab.highlightTags.clear(); tab.highlightPids.clear(); } },
    { label: "Limpar todos os filtros", act: () => resetFilters(tab) },
  ];

  ctxMenu.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    if (item.sep) {
      li.className = "sep";
    } else {
      li.textContent = item.label;
      if (item.disabled) {
        li.className = "disabled";
      } else {
        li.addEventListener("click", () => {
          hideContextMenu();
          item.act();
          recomputeSearch(tab);
          refreshPanel(tab);
        });
      }
    }
    ctxMenu.appendChild(li);
  }

  ctxMenu.hidden = false;
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 6) + "px";
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 6) + "px";
}

let suppressScrollHide = false;

function hideContextMenu() {
  ctxMenu.hidden = true;
}
document.addEventListener("click", hideContextMenu);
document.addEventListener("scroll", () => {
  if (!suppressScrollHide) hideContextMenu();
}, true);
window.addEventListener("blur", hideContextMenu);

function copySelection(tab) {
  const text = tab.lines.filter((l) => tab.selected.has(l.n)).map((l) => l.text).join("\n");
  if (text) copyToClipboard(text, `${tab.selected.size} linha(s) copiada(s).`);
}

function toggleBookmarks(tab) {
  for (const n of tab.selected) {
    if (tab.bookmarks.has(n)) tab.bookmarks.delete(n);
    else tab.bookmarks.add(n);
  }
}

// ---------------------------------------------------------------------------
// Visualizador de mensagem (duplo clique), com formatacao de JSON
// ---------------------------------------------------------------------------

const msgDialog = el("#msgDialog");
const msgBody = el("#msgBody");
const msgMeta = el("#msgMeta");

function showMessageDialog(tab, line) {
  const c = line.c;
  msgMeta.textContent = c
    ? `linha ${line.n} | ${c.time || "-"} | nivel ${c.level || "-"} | PID ${c.pid || "-"}` +
      ` | TID ${c.tid || "-"} | UID ${c.uid || "-"} | TAG ${c.tag || "-"}`
    : `linha ${line.n} | fora do formato logcat`;
  msgBody.textContent = c ? (c.msg ?? line.text) : line.text;
  msgDialog.hidden = false;
}

el("#msgClose").addEventListener("click", () => { msgDialog.hidden = true; });
msgDialog.addEventListener("click", (e) => {
  if (e.target === msgDialog) msgDialog.hidden = true;
});
el("#msgCopy").addEventListener("click", () => copyToClipboard(msgBody.textContent, "Mensagem copiada."));
el("#msgFormatJson").addEventListener("click", () => {
  const text = msgBody.textContent;
  const start = text.search(/[{[]/);
  if (start < 0) {
    setStatus("Nenhum JSON encontrado nesta mensagem.", true);
    return;
  }
  // Aceita mensagens em que o JSON vem depois de um prefixo de log.
  for (let end = text.length; end > start; end--) {
    try {
      msgBody.textContent = JSON.stringify(JSON.parse(text.slice(start, end)), null, 2);
      return;
    } catch { /* tenta um recorte menor */ }
  }
  setStatus("O trecho nao e um JSON valido.", true);
});

// ---------------------------------------------------------------------------
// Aba lateral: Dispositivo (hardware e software extraidos do log)
// ---------------------------------------------------------------------------

const deviceInfoEl = el("#deviceInfo");
let deviceReport = null;

function scopeParams(scope) {
  const params = new URLSearchParams({ root: state.root });
  if (scope === "current") {
    const tab = activeTab();
    if (!tab) return null;
    params.set("scope", "explicit");
    params.set("files", tab.path);
  } else if (scope === "open") {
    if (!state.tabs.length) return null;
    params.set("scope", "open");
    params.set("open_files", state.tabs.map((t) => t.path).join(","));
  } else {
    params.set("scope", "folder");
  }
  return params;
}

el("#deviceScanBtn").addEventListener("click", scanDevice);
el("#deviceCopyBtn").addEventListener("click", () => {
  if (!deviceReport) return;
  const text = deviceReport.categories
    .map((cat) => `== ${cat.label} ==\n` +
      cat.items.map((i) => `${i.label}: ${i.value}`).join("\n"))
    .join("\n\n");
  copyToClipboard(text, "Informacoes do dispositivo copiadas.");
});
el("#deviceSearch").addEventListener("input", () => renderDeviceInfo());

async function scanDevice() {
  if (!state.root) {
    deviceInfoEl.innerHTML = '<p class="side-hint">Carregue uma pasta primeiro.</p>';
    return;
  }
  const scope = el("#deviceScope").value;
  const params = scopeParams(scope);
  if (!params) {
    deviceInfoEl.innerHTML = '<p class="side-hint">Abra um arquivo de log primeiro.</p>';
    return;
  }
  const btn = el("#deviceScanBtn");
  btn.disabled = true;
  deviceInfoEl.innerHTML = '<p class="side-hint">Analisando o log...</p>';
  try {
    const res = await fetch(`/api/device_info?${params}`);
    const data = await res.json();
    if (!res.ok) {
      deviceInfoEl.innerHTML = `<p class="side-hint">${escapeHtml(data.error || "Erro na analise.")}</p>`;
      return;
    }
    deviceReport = data;
    renderDeviceInfo();
    setStatus(`Dispositivo analisado: ${data.categories.length} categoria(s) em ` +
      `${fmtNum(data.lines_total)} linha(s)` + (data.truncated ? " (analise truncada)" : ""));
  } catch (err) {
    deviceInfoEl.innerHTML = `<p class="side-hint">Falha na requisicao: ${escapeHtml(err)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function renderDeviceInfo() {
  if (!deviceReport) return;
  const q = el("#deviceSearch").value.trim().toLowerCase();
  const parts = [];

  for (const cat of deviceReport.categories) {
    const items = q
      ? cat.items.filter((i) =>
          i.label.toLowerCase().includes(q) || String(i.value).toLowerCase().includes(q))
      : cat.items;
    if (!items.length) continue;
    parts.push(
      `<details class="dev-cat" ${q || cat.id === "identificacao" ? "open" : ""}>` +
      `<summary>${cat.icon} ${escapeHtml(cat.label)}<span class="count">${items.length}</span></summary>` +
      items.map((i) =>
        `<div class="dev-item" title="fonte: ${escapeHtml(i.source)}">` +
        `<span class="k">${escapeHtml(i.label)}</span>` +
        `<span class="v">${escapeHtml(i.value)}</span></div>`).join("") +
      `</details>`
    );
  }

  if (deviceReport.top_tags && deviceReport.top_tags.length) {
    const tags = q
      ? deviceReport.top_tags.filter((t) => t.tag.toLowerCase().includes(q))
      : deviceReport.top_tags;
    if (tags.length) {
      parts.push(
        `<details class="dev-cat"><summary>\u{1F3F7} TAGs mais frequentes<span class="count">${tags.length}</span></summary>` +
        tags.map((t) =>
          `<div class="dev-item" data-tag="${escapeHtml(t.tag)}" title="Clique para filtrar por esta TAG">` +
          `<span class="k">${fmtNum(t.count)} ocorrencia(s)</span>` +
          `<span class="v">${escapeHtml(t.tag)}</span></div>`).join("") +
        `</details>`
      );
    }
  }

  if (deviceReport.sections && deviceReport.sections.length) {
    const secs = q
      ? deviceReport.sections.filter((s) => s.toLowerCase().includes(q))
      : deviceReport.sections;
    if (secs.length) {
      parts.push(
        `<details class="dev-cat"><summary>\u{1F5C2} Secoes do bugreport<span class="count">${secs.length}</span></summary>` +
        secs.map((s) => `<div class="dev-item"><span class="v">${escapeHtml(s)}</span></div>`).join("") +
        `</details>`
      );
    }
  }

  deviceInfoEl.innerHTML = parts.length
    ? parts.join("")
    : '<p class="dev-empty">Nada encontrado para esse filtro.</p>';

  // Clicar numa TAG frequente aplica o filtro na aba ativa.
  deviceInfoEl.querySelectorAll(".dev-item[data-tag]").forEach((node) => {
    node.style.cursor = "pointer";
    node.addEventListener("click", () => {
      const tab = activeTab();
      if (!tab) return;
      tab.liveFilter = `tag:${node.dataset.tag}`;
      recomputeSearch(tab);
      refreshPanel(tab);
      setStatus(`Filtrando por tag:${node.dataset.tag}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Aba lateral: Filtros salvos
// ---------------------------------------------------------------------------

const FILTERS_KEY = "logviewer.savedFilters";
state.savedFilters = store(FILTERS_KEY, []);

const filterListEl = el("#filterList");
const filterDialog = el("#filterDialog");

function saveFilters() {
  persist(FILTERS_KEY, state.savedFilters);
  renderFilterList();
}

function renderFilterList() {
  filterListEl.innerHTML = "";
  if (!state.savedFilters.length) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="filter-meta">Nenhum filtro salvo ainda.</span>';
    filterListEl.appendChild(li);
    return;
  }
  for (const f of state.savedFilters) {
    const li = document.createElement("li");
    li.className = state.selectedFilterId === f.id ? "selected" : "";
    const bits = [];
    if (f.levels && f.levels.length) bits.push(f.levels.join(""));
    if (f.tag) bits.push("tag:" + f.tag);
    if (f.text) bits.push("txt:" + f.text);
    if (f.pid) bits.push("pid:" + f.pid);
    if (f.tid) bits.push("tid:" + f.tid);
    li.innerHTML =
      `<span class="filter-name">${f.negate ? '<span class="neg">!</span> ' : ""}${escapeHtml(f.name)}</span>` +
      `<span class="filter-meta">${escapeHtml(bits.join(" ").slice(0, 40))}</span>`;
    li.addEventListener("click", () => applySavedFilter(f.id));
    li.addEventListener("dblclick", () => openFilterDialog(f.id));
    filterListEl.appendChild(li);
  }
}

function applySavedFilter(id) {
  const tab = activeTab();
  // Clicar de novo no filtro ja ativo desliga-o.
  const turningOff = state.selectedFilterId === id;
  state.selectedFilterId = turningOff ? null : id;
  if (tab) {
    tab.activeFilterId = state.selectedFilterId;
    recomputeSearch(tab);
    refreshPanel(tab);
  }
  renderFilterList();
  const f = state.savedFilters.find((x) => x.id === id);
  setStatus(turningOff ? "Filtro desativado." : `Filtro "${f ? f.name : id}" aplicado.`);
}

function openFilterDialog(id) {
  state.editingFilterId = id || null;
  const f = state.savedFilters.find((x) => x.id === id) || {};
  el("#filterDialogTitle").textContent = id ? "Editar filtro" : "Novo filtro";
  el("#fdName").value = f.name || "";
  el("#fdTag").value = f.tag || "";
  el("#fdText").value = f.text || "";
  el("#fdPid").value = f.pid || "";
  el("#fdTid").value = f.tid || "";
  el("#fdNegate").checked = !!f.negate;
  el("#fdCase").checked = !!f.caseSensitive;
  const levels = new Set(f.levels || []);
  el("#fdLevels").innerHTML = LEVELS.map((l) =>
    `<button type="button" class="level-toggle${levels.has(l) ? " on" : ""}" data-level="${l}">${l}</button>`).join("");
  el("#fdLevels").querySelectorAll(".level-toggle").forEach((btn) => {
    btn.addEventListener("click", () => btn.classList.toggle("on"));
  });
  filterDialog.hidden = false;
  el("#fdName").focus();
}

el("#filterAddBtn").addEventListener("click", () => openFilterDialog(null));
el("#filterEditBtn").addEventListener("click", () => {
  if (!state.selectedFilterId) {
    setStatus("Selecione um filtro na lista primeiro.", true);
    return;
  }
  openFilterDialog(state.selectedFilterId);
});
el("#filterDelBtn").addEventListener("click", () => {
  if (!state.selectedFilterId) {
    setStatus("Selecione um filtro na lista primeiro.", true);
    return;
  }
  const f = state.savedFilters.find((x) => x.id === state.selectedFilterId);
  if (!window.confirm(`Excluir o filtro "${f ? f.name : ""}"?`)) return;
  state.savedFilters = state.savedFilters.filter((x) => x.id !== state.selectedFilterId);
  for (const tab of state.tabs) {
    if (tab.activeFilterId === state.selectedFilterId) tab.activeFilterId = null;
  }
  state.selectedFilterId = null;
  saveFilters();
  const tab = activeTab();
  if (tab) refreshPanel(tab);
});

el("#filterExportBtn").addEventListener("click", () => {
  if (!state.savedFilters.length) {
    setStatus("Nenhum filtro para exportar.", true);
    return;
  }
  downloadText("logviewer-filtros.json", JSON.stringify(state.savedFilters, null, 2));
});
el("#filterImportBtn").addEventListener("click", () => el("#filterImportFile").click());
el("#filterImportFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported)) throw new Error("formato invalido");
    let added = 0;
    for (const f of imported) {
      if (!f || typeof f.name !== "string") continue;
      state.savedFilters.push({
        id: "f" + Date.now() + Math.random().toString(36).slice(2, 6),
        name: f.name,
        tag: f.tag || "", text: f.text || "", pid: f.pid || "", tid: f.tid || "",
        levels: Array.isArray(f.levels) ? f.levels : [],
        negate: !!f.negate, caseSensitive: !!f.caseSensitive,
      });
      added++;
    }
    saveFilters();
    setStatus(`${added} filtro(s) importado(s).`);
  } catch (err) {
    setStatus("Arquivo de filtros invalido: " + err, true);
  } finally {
    e.target.value = "";
  }
});

el("#fdSave").addEventListener("click", () => {
  const name = el("#fdName").value.trim();
  if (!name) {
    setStatus("Da um nome ao filtro.", true);
    el("#fdName").focus();
    return;
  }
  const data = {
    name,
    tag: el("#fdTag").value.trim(),
    text: el("#fdText").value.trim(),
    pid: el("#fdPid").value.trim(),
    tid: el("#fdTid").value.trim(),
    levels: [...el("#fdLevels").querySelectorAll(".level-toggle.on")].map((b) => b.dataset.level),
    negate: el("#fdNegate").checked,
    caseSensitive: el("#fdCase").checked,
  };
  const existing = state.savedFilters.find((x) => x.id === state.editingFilterId);
  if (existing) Object.assign(existing, data);
  else state.savedFilters.push({ id: "f" + Date.now() + Math.random().toString(36).slice(2, 6), ...data });
  filterDialog.hidden = true;
  saveFilters();
  const tab = activeTab();
  if (tab && tab.activeFilterId) refreshPanel(tab);
});

const closeFilterDialog = () => { filterDialog.hidden = true; };
el("#fdCancel").addEventListener("click", closeFilterDialog);
el("#filterDialogClose").addEventListener("click", closeFilterDialog);
filterDialog.addEventListener("click", (e) => {
  if (e.target === filterDialog) closeFilterDialog();
});

renderFilterList();

// ---------------------------------------------------------------------------
// Atalhos globais
// ---------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === "Escape") {
    if (!msgDialog.hidden) { msgDialog.hidden = true; return; }
    if (!filterDialog.hidden) { filterDialog.hidden = true; return; }
    if (!ctxMenu.hidden) { hideContextMenu(); return; }
    if (!findPanel.hidden) { closeFindPanel(); return; }
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openFindPanel();
    return;
  }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    const tab = activeTab();
    if (tab) promptSearch(tab);
    return;
  }
  if (mod && (e.key === "," || e.key === ".")) {
    const tab = activeTab();
    if (tab) {
      e.preventDefault();
      stepSearch(tab, e.key === "." ? 1 : -1);
    }
    return;
  }
  if (mod && e.key.toLowerCase() === "c" && !typing) {
    const tab = activeTab();
    if (tab && tab.selected.size) {
      e.preventDefault();
      copySelection(tab);
    }
  }
});

// ---------------------------------------------------------------------------
// Busca em varios arquivos (painel inferior)
// ---------------------------------------------------------------------------

const HISTORY_KEY = "logviewer.searchHistory";
const HISTORY_MAX = 20;

function loadHistory() {
  return store(HISTORY_KEY, []);
}

function saveToHistory(pattern) {
  if (!pattern || !pattern.trim()) return;
  const trimmed = pattern.trim();
  let hist = loadHistory().filter((p) => p !== trimmed);
  hist.unshift(trimmed);
  persist(HISTORY_KEY, hist.slice(0, HISTORY_MAX));
  renderHistoryDatalist();
}

function renderHistoryDatalist() {
  let dl = document.getElementById("searchHistoryList");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "searchHistoryList";
    document.body.appendChild(dl);
  }
  dl.innerHTML = loadHistory().map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");
}
renderHistoryDatalist();

const findPanel = el("#findPanel");
const findPattern = el("#findPattern");
const findResultsEl = el("#findResults");
const findSummaryEl = el("#findSummary");
const findFolderOptions = el("#findFolderOptions");

el("#findInFilesBtn").addEventListener("click", toggleFindPanel);
el("#findCloseBtn").addEventListener("click", closeFindPanel);
el("#findCollapseBtn").addEventListener("click", () => findPanel.classList.toggle("collapsed"));

document.querySelectorAll('input[name="findScope"]').forEach((r) =>
  r.addEventListener("change", () => {
    findFolderOptions.hidden =
      document.querySelector('input[name="findScope"]:checked').value !== "folder";
  })
);
el("#findSearchBtn").addEventListener("click", () => runFindSearch());
findPattern.addEventListener("keydown", (e) => { if (e.key === "Enter") runFindSearch(); });
el("#findTag").addEventListener("keydown", (e) => { if (e.key === "Enter") runFindSearch(); });
el("#findPid").addEventListener("keydown", (e) => { if (e.key === "Enter") runFindSearch(); });
el("#findUid").addEventListener("keydown", (e) => { if (e.key === "Enter") runFindSearch(); });
el("#findRefreshFieldsBtn").addEventListener("click", refreshLogFields);

function currentFindScopeParams() {
  const scope = document.querySelector('input[name="findScope"]:checked').value;
  const params = scopeParams(scope);
  if (params && scope === "folder") {
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
    infoEl.textContent = `${data.lines_parsed} de ${data.lines_scanned} linha(s) reconhecidas como ` +
      `logcat em ${data.files_used} arquivo(s) - ${data.tags.length} tags, ${data.uids.length} uids`;
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

el("#findResizeHandle").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = findPanel.getBoundingClientRect().height;
  const onMove = (ev) => {
    const newHeight = Math.min(Math.max(startHeight + startY - ev.clientY, 140), window.innerHeight * 0.85);
    findPanel.style.height = newHeight + "px";
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
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
  if (!pattern && !(levels.length || tag || pid || uid)) return;
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
    findResultsEl.innerHTML = '<div class="find-empty">Nenhum resultado.</div>';
    return;
  }

  for (const fileResult of filesWithMatches) {
    const group = document.createElement("div");
    group.className = "find-file-group";

    const header = document.createElement("div");
    header.className = "find-file-header";
    header.innerHTML = `${escapeHtml(fileResult.path)} <span class="count">(${fileResult.matches.length}` +
      `${fileResult.truncated ? "+" : ""} ocorrencia(s))</span>`;
    const body = document.createElement("div");
    header.addEventListener("click", () => {
      body.style.display = body.style.display === "none" ? "block" : "none";
    });
    group.appendChild(header);

    for (const m of fileResult.matches) {
      const line = document.createElement("div");
      line.className = "line";
      const badge = m.level ? `<span class="badge badge-${m.level}">${m.level}</span>` : "";
      line.innerHTML = `<span class="ln">${m.line_number}</span>` +
        `<span class="txt">${badge}${highlightFind(m.line, pattern, caseSensitive)}</span>`;
      line.addEventListener("click", () => openFile(fileResult.path, m.line_number));
      body.appendChild(line);
    }
    group.appendChild(body);
    findResultsEl.appendChild(group);
  }
}

function highlightFind(text, pattern, caseSensitive) {
  if (!pattern) return escapeHtml(text);
  try {
    const re = new RegExp(pattern, caseSensitive ? "g" : "gi");
    return escapeHtml(text).replace(re, (m) => `<mark>${m}</mark>`);
  } catch {
    return escapeHtml(text);
  }
}
