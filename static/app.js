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
    hlIdx: null,
    jumpLine: null,
    // Analises do arquivo inteiro, carregadas sob demanda.
    timeline: null,
    timelineLoading: false,
    procMap: null,
    procUids: null,
    procAmbiguous: null,
    procLoading: false,
    // Filtro no servidor: quando ligado, a pagina exibida ja vem filtrada.
    serverFilter: false,
    serverMatched: 0,
    serverTruncated: false,
    // Intervalo de tempo marcado a partir de duas linhas selecionadas.
    timeRange: null,
    // Blocos de stack trace abertos (por padrao ficam dobrados).
    openTraces: new Set(),
    // Linha do tempo: fechada ate ser pedida.
    timelineOpen: false,
    // Janela de resultados da busca no arquivo inteiro.
    findOpen: false,
    findLoading: false,
    findResults: null,
    findQuery: "",
    findError: null,
    findHeight: null,
    // Cores atribuidas a cada palavra do filtro.
    filterTerms: [],
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
  // Ao pular para uma linha (resultado de busca, evento da linha do tempo,
  // "ir para linha"), ela precisa ficar selecionada: so rolar ate ela deixa o
  // usuario sem saber qual das linhas visiveis era o alvo.
  if (scrollToLine) {
    tab.selected.add(scrollToLine);
    tab.lastClicked = scrollToLine;
  } else {
    tab.lastClicked = null;
  }
  tab.hlIdx = null;  // a pagina mudou: a navegacao de destaques recomeca
  recomputeSearch(tab);
  renderPanels();
  renderHighlightList();
  // O nome do processo por PID e util em toda linha; busca uma vez por arquivo.
  loadProcessMap(tab);
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

/** Cada palavra buscada ganha uma cor propria, inclusive as alternativas de um
 *  "a|b|c". Assim da para ver, numa linha so, qual dos termos casou. */
function filterTerms(tab) {
  const out = [];
  let color = 0;
  for (const term of parseLiveFilter(tab.liveFilter, false)) {
    if (term.negate) continue;   // termo negado esconde linhas, nao marca nada
    const src = term.re.source;
    // Um "a|b|c" simples vira uma cor por alternativa; com parenteses ou
    // colchetes o "|" pode ser interno ao regex, entao fica uma cor so.
    const parts = /[()[\]\\]/.test(src) ? [src] : src.split("|").filter(Boolean);
    for (const part of parts) {
      out.push({ pattern: part, color: color % HL_COLORS });
      color++;
    }
  }
  return out;
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
  const range = tab.timeRange;
  const out = [];
  for (const line of tab.lines) {
    const c = line.c;

    if (range) {
      const v = timeValue(c && c.time);
      if (v === null || v < range.from || v > range.to) continue;
    }
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

/** Regex global e tolerante: um padrao invalido vira busca literal. */
function globalRegex(pattern, caseSensitive) {
  const flags = caseSensitive ? "g" : "gi";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}

const MAX_MARKS_PER_LINE = 200;

function collectRanges(text, re, cls, out) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }  // evita laco infinito
    out.push({ start: m.index, end: m.index + m[0].length, cls });
    if (out.length >= MAX_MARKS_PER_LINE) break;
  }
}

/** Escapa o texto e envolve em <mark> tudo que casa com a busca ativa e com os
 *  destaques ligados. Quando duas marcacoes se sobrepoem, a primeira vence. */
function decorateText(text, tab) {
  if (!text) return "";
  const terms = tab.filterTerms || [];
  if (!tab.searchTerm && !terms.length
      && !state.highlights.some((h) => h.enabled && h.pattern)) {
    return escapeHtml(text);  // caminho rapido: nada a marcar
  }
  const ranges = [];
  if (tab.searchTerm) {
    collectRanges(text, globalRegex(tab.searchTerm, false), "hit", ranges);
  }
  for (const term of terms) {
    collectRanges(text, globalRegex(term.pattern, false), "hl-" + term.color, ranges);
  }
  for (const hl of state.highlights) {
    if (!hl.enabled || !hl.pattern) continue;
    collectRanges(text, globalRegex(hl.pattern, hl.caseSensitive), "hl-" + hl.color, ranges);
  }
  if (!ranges.length) return escapeHtml(text);

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  let html = "";
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos) continue;
    html += escapeHtml(text.slice(pos, r.start));
    html += `<mark class="${r.cls}">${escapeHtml(text.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  return html + escapeHtml(text.slice(pos));
}

// ---------------------------------------------------------------------------
// Agrupamento de stack traces
// ---------------------------------------------------------------------------

const TRACE_START = /FATAL EXCEPTION|\*\*\* \*\*\* \*\*\*|Fatal signal /;
// Continuacoes tipicas de um stack trace Java ou de um tombstone nativo.
const TRACE_CONT = /^\s*(?:at\s|Caused by:|Suppressed:|\.\.\.\s*\d+\s*more|#\d{2}\s+pc\s|backtrace:|[a-zA-Z_$][\w$.]*(?:Exception|Error)(?::|$)|\w+ \d+ \(|Process:|java\.|android\.|kotlin\.|com\.|org\.|libc |signal \d+)/;
const TRACE_TAGS = new Set(["AndroidRuntime", "DEBUG", "System.err", "art", "libc", "CRASH"]);

/** Marca cada linha visivel com o grupo de stack trace a que pertence.
 *  Devolve Map<linha, {id, head, size}> — head e a primeira linha do bloco. */
function groupTraces(lines) {
  const groups = new Map();
  let current = null;
  for (const line of lines) {
    const c = line.c;
    const body = c ? (c.msg || "") : line.text;
    const isHead = c ? TRACE_START.test(body) : TRACE_START.test(line.text);

    if (isHead) {
      current = { id: "g" + line.n, headLine: line.n, pid: c && c.pid, tid: c && c.tid, size: 1 };
      groups.set(line.n, { group: current, head: true });
      continue;
    }
    if (!current) continue;

    // Continua o bloco enquanto for da mesma thread e parecer parte da pilha.
    const sameThread = !c || !current.pid || (c.pid === current.pid && c.tid === current.tid);
    const looksLikeFrame = TRACE_CONT.test(body) || (c && TRACE_TAGS.has(c.tag));
    if (sameThread && looksLikeFrame) {
      current.size++;
      groups.set(line.n, { group: current, head: false });
    } else {
      current = null;
    }
  }
  // Um "bloco" de uma linha so nao vale colapsar.
  for (const [n, info] of groups) {
    if (info.group.size < 2) groups.delete(n);
  }
  return groups;
}

function isHighlighted(tab, line) {
  const c = line.c;
  if (!c) return false;
  return (c.tag && tab.highlightTags.has(c.tag)) || (c.pid && tab.highlightPids.has(c.pid));
}

function rowHtml(tab, line, groups) {
  const c = line.c;
  const classes = ["lvl-" + (c && c.level ? c.level : "none")];
  if (tab.selected.has(line.n)) classes.push("selected");
  if (isHighlighted(tab, line)) classes.push("highlighted");
  if (tab.bookmarks.has(line.n)) classes.push("bookmarked");

  // Bloco de stack trace: a primeira linha vira cabecalho dobravel e as demais
  // ficam escondidas enquanto o bloco estiver fechado.
  let groupAttrs = "";
  let toggle = "";
  const g = groups && groups.get(line.n);
  if (g) {
    const collapsed = !tab.openTraces.has(g.group.id);
    groupAttrs = ` data-group="${g.group.id}"`;
    if (g.head) {
      classes.push("trace-head");
      toggle = `<span class="trace-toggle" data-group="${g.group.id}">` +
        `${collapsed ? "▸" : "▾"} ${g.group.size}</span>`;
    } else {
      classes.push("trace-member");
      if (collapsed) classes.push("trace-hidden");
    }
  }

  if (!c) {
    // Linha fora do formato logcat (cabecalho de bugreport, dumpsys, etc):
    // mostra o texto cru ocupando as colunas de conteudo.
    return `<tr class="${classes.join(" ")}" data-line="${line.n}"${groupAttrs}>` +
      `<td class="c-n">${line.n}</td>` +
      `<td class="c-lvl"></td><td class="c-time"></td><td class="c-pid"></td>` +
      `<td class="c-tid"></td><td class="c-tag"></td>` +
      `<td class="c-text c-raw">${toggle}${decorateText(line.text, tab)}</td></tr>`;
  }

  // Nome do processo ao lado do PID: "3154" sozinho nao diz nada.
  const proc = processName(tab, c.pid);
  const pidCell = decorateText(c.pid || "", tab) +
    (proc ? ` <span class="proc-name">${escapeHtml(shortProc(proc))}</span>` : "");
  const pidTitle = proc
    ? ` title="PID ${c.pid} - ${escapeHtml(proc)}${tab.procAmbiguous && tab.procAmbiguous.has(c.pid) ? " (PID reutilizado na captura)" : ""}"`
    : "";

  // A TAG ganha a explicacao da sigla quando e um servico conhecido do sistema.
  const tagInfo = glossaryTagTitle(c.tag);

  // Os destaques valem para qualquer coluna textual: quem destaca uma TAG ou um
  // PID espera ver a marcacao onde o valor aparece, nao so na mensagem.
  return `<tr class="${classes.join(" ")}" data-line="${line.n}"${groupAttrs}` +
    ` data-tag="${escapeHtml(c.tag || "")}" data-pid="${escapeHtml(c.pid || "")}">` +
    `<td class="c-n">${line.n}</td>` +
    `<td class="c-lvl"${levelTitle(c.level)}>${escapeHtml(c.level || "")}</td>` +
    `<td class="c-time">${decorateText(c.time || "", tab)}</td>` +
    `<td class="c-pid"${pidTitle}>${pidCell}</td>` +
    `<td class="c-tid">${decorateText(c.tid || "", tab)}</td>` +
    `<td class="c-tag"${tagInfo}>${decorateText(c.tag || "", tab)}</td>` +
    `<td class="c-text">${toggle}${decorateText(c.msg ?? line.text, tab)}</td></tr>`;
}

/** "com.google.android.gms" ocupa muito espaco na coluna; mostra o essencial. */
function shortProc(name) {
  if (name.length <= 24) return name;
  const parts = name.split(".");
  return parts.length > 2 ? "…" + parts.slice(-2).join(".") : name.slice(0, 24) + "…";
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

  // As cores dos termos sao recalculadas a cada render: o filtro pode ter
  // mudado, e a marcacao precisa acompanhar.
  tab.filterTerms = filterTerms(tab);
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
    <input class="live-filter" list="filterHistoryList" value="${escapeHtml(tab.liveFilter)}"
      placeholder="Buscar no arquivo todo (Enter). Ex: sales_code|imei|serialno"
      title="Enter busca no ARQUIVO INTEIRO e abre a janela de resultados.&#10;&#10;a|b|c  = qualquer uma das palavras (cada uma ganha uma cor)&#10;a b    = a linha precisa ter as duas&#10;-a     = esconde as linhas com 'a' (so na pagina)&#10;Prefixos: tag: pid: tid: app: text: level:&#10;Aceita regex.">
    <button data-act="filesearch" class="primary" title="Buscar no arquivo inteiro (Enter)">Buscar tudo</button>
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
    <input data-act="goto" class="goto-line" placeholder="linha" title="Ir para a linha (Enter)">
    <button data-act="timeline" class="${tab.timelineOpen ? "on-toggle" : ""}" title="Mostrar/ocultar a linha do tempo do arquivo">&#9776;</button>
    <span class="toolbar-sep"></span>
    <button data-act="find" title="Buscar e destacar nesta pagina (Ctrl+F)">&#128269;</button>
    <button data-act="prevhit" title="Ocorrencia anterior (Ctrl+,)">&#8963;</button>
    <button data-act="nexthit" title="Proxima ocorrencia (Ctrl+.)">&#8964;</button>
    <label class="toolbar-check" title="Quebrar linhas longas no espaco horizontal disponivel, em vez de rolar na horizontal">
      <input type="checkbox" data-act="wrap"${tab.wrapText ? " checked" : ""}> Quebrar linha
    </label>
    <button data-act="export" title="Exportar as linhas visiveis (ou a selecao) para arquivo">Exportar</button>
    <label class="toolbar-check" title="Aplicar o filtro ao arquivo inteiro no servidor, em vez de so a pagina carregada">
      <input type="checkbox" data-act="server"${tab.serverFilter ? " checked" : ""}> Arquivo todo
    </label>
    <button data-act="reset" title="Limpar todos os filtros e destaques">Limpar filtros</button>
    <span class="info"></span>
  `;
  panel.appendChild(toolbar);
  const timeline = buildTimeline(tab);
  if (timeline) panel.appendChild(timeline);

  const info = toolbar.querySelector(".info");
  const hidden = tab.lines.length - shown.length;
  info.textContent =
    `${fmtNum(shown.length)} linha(s)` +
    (hidden > 0 ? ` (${fmtNum(hidden)} ocultada(s) por filtro)` : "") +
    (tab.serverFilter
      ? ` | ${fmtNum(tab.serverMatched)} no arquivo todo${tab.serverTruncated ? "+" : ""}` +
        ` | pagina ${fmtNum(tab.offset + 1)}-${fmtNum(tab.offset + tab.lines.length)}`
      : ` | ${fmtNum(tab.offset + 1)}-${fmtNum(tab.offset + tab.lines.length)} de ${fmtNum(tab.totalLines)}`) +
    (tab.size != null ? ` | ${fmtSize(tab.size)}` : "") +
    (tab.searchHits.length ? ` | ${tab.searchHits.length} ocorrencia(s)` : "");

  // Filtro sem resultado na pagina: o arquivo tem milhoes de linhas e a busca
  // util quase sempre e a do arquivo inteiro, entao oferece o caminho.
  if (!tab.binary && tab.lines.length && !shown.length && tab.liveFilter.trim() && !tab.findOpen) {
    const hint = document.createElement("div");
    hint.className = "range-bar";
    hint.innerHTML = `<span>Nenhuma linha nesta pagina (${fmtNum(tab.offset + 1)}-` +
      `${fmtNum(tab.offset + tab.lines.length)} de ${fmtNum(tab.totalLines)}). ` +
      `O termo pode estar em outra parte do arquivo.</span>` +
      `<button data-act="hint-search">Buscar no arquivo inteiro</button>`;
    hint.querySelector("[data-act=hint-search]")
      .addEventListener("click", () => searchWholeFile(tab, 0));
    panel.appendChild(hint);
  }

  // Barra de intervalo: aparece com duas ou mais linhas selecionadas.
  const rangeBar = buildRangeBar(tab);
  if (rangeBar) panel.appendChild(rangeBar);

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
    const groups = groupTraces(shown);
    const th = (label, sigla) => {
      const e = glossaryEntry(sigla);
      return `<th${e ? ` title="${escapeHtml(`${e.sigla} - ${e.nome}: ${e.desc}`)}"` : ""}>${label}</th>`;
    };
    wrap.innerHTML =
      `<table class="log-table${tab.wrapText ? " wrap" : ""}"><thead><tr>` +
      '<th class="c-n">Linha</th>' + th("L.", "L.") + th("Hora", "Hora") +
      th("PID", "PID") + th("TID", "TID") + th("Tag", "Tag") + "<th>Texto</th>" +
      "</tr></thead><tbody>" +
      shown.map((l) => rowHtml(tab, l, groups)).join("") +
      "</tbody></table>";
  }
  panel.appendChild(wrap);
  const dock = buildFindDock(tab);
  if (dock) panel.appendChild(dock);

  wirePanel(tab, panel, toolbar, wrap, shown, paneIndex);
  return panel;
}

/** Mostra o intervalo entre a primeira e a ultima linha selecionada, com o
 *  delta em tempo — a pergunta mais comum e "o que rolou nos 2s antes disso". */
function buildRangeBar(tab) {
  if (tab.timeRange) {
    const bar = document.createElement("div");
    bar.className = "range-bar active";
    bar.innerHTML = `<span>Intervalo ativo: ${escapeHtml(tab.timeRange.fromLabel)} ate ` +
      `${escapeHtml(tab.timeRange.toLabel)} (${fmtDelta(tab.timeRange.to - tab.timeRange.from)})</span>` +
      `<button data-act="clear-range">Remover intervalo</button>`;
    bar.querySelector("[data-act=clear-range]").addEventListener("click", () => {
      tab.timeRange = null;
      recomputeSearch(tab);
      refreshPanel(tab);
    });
    return bar;
  }

  if (tab.selected.size < 2) return null;
  const stamps = tab.lines
    .filter((l) => tab.selected.has(l.n) && l.c && l.c.time)
    .map((l) => ({ v: timeValue(l.c.time), label: l.c.time, n: l.n }))
    .filter((s) => s.v !== null)
    .sort((a, b) => a.v - b.v);
  if (stamps.length < 2) return null;

  const first = stamps[0];
  const last = stamps[stamps.length - 1];
  const bar = document.createElement("div");
  bar.className = "range-bar";
  bar.innerHTML =
    `<span>${fmtNum(tab.selected.size)} linhas selecionadas | ` +
    `L${fmtNum(first.n)} ${escapeHtml(first.label)} &rarr; L${fmtNum(last.n)} ${escapeHtml(last.label)} | ` +
    `<strong>${fmtDelta(last.v - first.v)}</strong></span>` +
    `<button data-act="apply-range">Filtrar so este intervalo</button>`;
  bar.querySelector("[data-act=apply-range]").addEventListener("click", () => {
    tab.timeRange = {
      from: first.v, to: last.v,
      fromLabel: first.label, toLabel: last.label,
    };
    recomputeSearch(tab);
    refreshPanel(tab);
    setStatus(`Intervalo de ${fmtDelta(last.v - first.v)} aplicado.`);
  });
  return bar;
}

function fmtDelta(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(3)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}min ${((ms % 60000) / 1000).toFixed(1)}s`;
}

/** Traduz o filtro ao vivo e os toggles em parametros para /api/filtered. */
function serverFilterParams(tab) {
  const params = new URLSearchParams({ root: state.root, file: tab.path });
  const terms = parseLiveFilter(tab.liveFilter, false);
  const byField = { tag: [], msg: [], pid: [], tid: [], uid: [] };
  let negate = false;
  for (const term of terms) {
    if (term.negate) { negate = true; continue; }
    const field = term.field || "msg";
    if (byField[field]) byField[field].push(term.re.source);
  }
  const join = (arr) => (arr.length ? arr.map((s) => `(?:${s})`).join(".*") : "");
  if (byField.tag.length) params.set("tag", join(byField.tag));
  if (byField.msg.length) params.set("text", join(byField.msg));
  if (byField.pid.length) params.set("pid", join(byField.pid));
  if (byField.tid.length) params.set("tid", join(byField.tid));
  if (byField.uid.length) params.set("uid", join(byField.uid));
  if (tab.levels.size) params.set("levels", [...tab.levels].join(","));

  const filter = state.savedFilters.find((f) => f.id === tab.activeFilterId);
  if (filter) {
    if (filter.tag) params.set("tag", filter.tag);
    if (filter.text) params.set("text", filter.text);
    if (filter.pid) params.set("pid", filter.pid);
    if (filter.tid) params.set("tid", filter.tid);
    if (filter.levels && filter.levels.length) params.set("levels", filter.levels.join(","));
    if (filter.negate) params.set("negate", "true");
    if (filter.caseSensitive) params.set("case", "true");
  }
  return { params, hasCriteria: [...params.keys()].length > 2, negateIgnored: negate && !filter };
}

// ---------------------------------------------------------------------------
// Busca no arquivo inteiro, com os resultados numa janela propria
// ---------------------------------------------------------------------------

const FIND_PAGE = 500;

/** Monta os parametros de /api/filtered a partir do que esta na caixa de
 *  filtro. Termos sem prefixo viram `raw`: casam com a linha inteira, que e o
 *  que a maioria das linhas de um bugreport exige — elas nem sao logcat. */
function fileSearchParams(tab) {
  const params = new URLSearchParams({ root: state.root, file: tab.path });
  const terms = parseLiveFilter(tab.liveFilter, false);
  const bare = [];
  const byField = { tag: [], msg: [], pid: [], tid: [], uid: [] };
  let negated = 0;
  for (const term of terms) {
    if (term.negate) { negated++; continue; }
    if (!term.field) bare.push(term.re.source);
    else byField[term.field].push(term.re.source);
  }
  // Varios termos no mesmo campo sao E: a linha precisa conter todos.
  const all = (arr) => arr.map((s) => `(?=.*(?:${s}))`).join("") + ".*";
  if (bare.length) params.set("raw", bare.length === 1 ? bare[0] : all(bare));
  if (byField.tag.length) params.set("tag", byField.tag.join("|"));
  if (byField.msg.length) params.set("text", byField.msg.join("|"));
  if (byField.pid.length) params.set("pid", byField.pid.join("|"));
  if (byField.tid.length) params.set("tid", byField.tid.join("|"));
  if (byField.uid.length) params.set("uid", byField.uid.join("|"));
  if (tab.levels.size) params.set("levels", [...tab.levels].join(","));

  const filter = state.savedFilters.find((f) => f.id === tab.activeFilterId);
  if (filter) {
    if (filter.tag) params.set("tag", filter.tag);
    if (filter.text) params.set("text", filter.text);
    if (filter.pid) params.set("pid", filter.pid);
    if (filter.tid) params.set("tid", filter.tid);
    if (filter.levels && filter.levels.length) params.set("levels", filter.levels.join(","));
    if (filter.negate) params.set("negate", "true");
    if (filter.caseSensitive) params.set("case", "true");
  }
  return { params, hasCriteria: [...params.keys()].length > 2, negated };
}

/** Roda a busca no arquivo todo e abre a janela de resultados. */
async function searchWholeFile(tab, offset = 0) {
  const { params, hasCriteria, negated } = fileSearchParams(tab);
  if (!hasCriteria) {
    setStatus("Digite algo na caixa de filtro para buscar no arquivo inteiro.", true);
    return;
  }
  params.set("offset", offset);
  params.set("limit", FIND_PAGE);

  saveToHistory(tab.liveFilter);
  tab.findOpen = true;
  tab.findLoading = true;
  tab.findQuery = tab.liveFilter;
  refreshPanel(tab);

  try {
    const res = await fetch(`/api/filtered?${params}`);
    const data = await res.json();
    if (!res.ok) {
      tab.findError = data.error || "Erro na busca.";
      tab.findResults = null;
      return;
    }
    tab.findError = null;
    tab.findResults = {
      lines: data.lines,
      numbers: data.line_numbers,
      columns: data.columns || [],
      matched: data.matched,
      offset: data.offset,
      hasMore: data.has_more,
      truncated: data.truncated,
      negated,
    };
    setStatus(`${fmtNum(data.matched)} linha(s) encontradas no arquivo inteiro.`);
  } catch (err) {
    tab.findError = "Falha na requisicao: " + err;
    tab.findResults = null;
  } finally {
    tab.findLoading = false;
    refreshPanel(tab);
  }
}

/** Janela inferior com as linhas encontradas; clicar leva o log ate a linha. */
function buildFindDock(tab) {
  if (!tab.findOpen) return null;
  const dock = document.createElement("div");
  dock.className = "find-dock";

  const terms = tab.filterTerms || [];
  const legend = terms.map((t) =>
    `<span class="fd-term hl-${t.color}">${escapeHtml(t.pattern)}</span>`).join("");

  const r = tab.findResults;
  const head = tab.findLoading
    ? "Buscando no arquivo inteiro..."
    : tab.findError
      ? tab.findError
      : r
        ? `${fmtNum(r.matched)} linha(s)${r.truncated ? "+" : ""} para ` +
          `"${escapeHtml(tab.findQuery)}"` +
          (r.matched > r.lines.length
            ? ` | mostrando ${fmtNum(r.offset + 1)}-${fmtNum(r.offset + r.lines.length)}`
            : "")
        : "";

  dock.innerHTML =
    `<div class="fd-resize" title="Arraste para redimensionar"></div>` +
    `<div class="fd-head">` +
      `<strong class="${tab.findError ? "fd-err" : ""}">${head}</strong>` +
      `<span class="fd-legend">${legend}</span>` +
      `<span class="fd-spacer"></span>` +
      `<button data-fd="prev" ${!r || r.offset === 0 ? "disabled" : ""} title="Resultados anteriores">&#8592;</button>` +
      `<button data-fd="next" ${!r || !r.hasMore ? "disabled" : ""} title="Proximos resultados">&#8594;</button>` +
      `<button data-fd="export" ${!r ? "disabled" : ""} title="Exportar todos os resultados">Exportar</button>` +
      `<button data-fd="close" class="icon-btn" title="Fechar a janela de resultados">&times;</button>` +
    `</div>` +
    `<div class="fd-list"></div>`;

  const list = dock.querySelector(".fd-list");
  if (r && r.lines.length) {
    list.innerHTML = r.lines.map((text, i) => {
      const c = r.columns[i];
      const badge = c && c.level ? `<span class="badge badge-${c.level}">${c.level}</span>` : "";
      const tag = c && c.tag ? `<span class="fd-tag">${escapeHtml(c.tag)}</span>` : "";
      return `<div class="fd-row" data-line="${r.numbers[i]}">` +
        `<span class="fd-n">${fmtNum(r.numbers[i])}</span>` +
        `<span class="fd-txt">${badge}${tag}${decorateText(text, tab)}</span></div>`;
    }).join("");
  } else if (r) {
    list.innerHTML = '<div class="fd-empty">Nenhuma linha encontrada no arquivo inteiro.</div>';
  }

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".fd-row");
    if (!row) return;
    list.querySelectorAll(".fd-row.on").forEach((n) => n.classList.remove("on"));
    row.classList.add("on");
    // Leva a tabela principal ate a linha correspondente do log completo.
    jumpToLine(tab, Number(row.dataset.line));
  });

  const fd = (name) => dock.querySelector(`[data-fd="${name}"]`);
  fd("close").addEventListener("click", () => {
    tab.findOpen = false;
    refreshPanel(tab);
  });
  fd("prev").addEventListener("click", () =>
    searchWholeFile(tab, Math.max(0, tab.findResults.offset - FIND_PAGE)));
  fd("next").addEventListener("click", () =>
    searchWholeFile(tab, tab.findResults.offset + FIND_PAGE));
  fd("export").addEventListener("click", () => exportFindResults(tab));

  dock.querySelector(".fd-resize").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = dock.getBoundingClientRect().height;
    const onMove = (ev) => {
      tab.findHeight = Math.min(Math.max(startH + startY - ev.clientY, 90), window.innerHeight * 0.8);
      dock.style.height = tab.findHeight + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  if (tab.findHeight) dock.style.height = tab.findHeight + "px";
  return dock;
}

/** Baixa todas as linhas encontradas, nao so a pagina exibida no dock. */
async function exportFindResults(tab) {
  const { params } = fileSearchParams(tab);
  params.set("offset", 0);
  params.set("limit", 20000);
  setStatus("Montando o arquivo de resultados...");
  try {
    const res = await fetch(`/api/filtered?${params}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Erro exportando.", true);
      return;
    }
    const body = data.lines.map((l, i) => `${data.line_numbers[i]}: ${l}`).join("\n");
    const base = tab.path.split("/").pop().replace(/\.[^.]+$/, "");
    downloadText(`${base}-busca.txt`, body + "\n");
    setStatus(`${data.lines.length} linha(s) exportada(s)` +
      (data.matched > data.lines.length ? ` de ${fmtNum(data.matched)} encontradas` : "") + ".");
  } catch (err) {
    setStatus("Falha na requisicao: " + err, true);
  }
}

async function loadServerFiltered(tab, offset = 0) {
  const { params, hasCriteria, negateIgnored } = serverFilterParams(tab);
  if (!hasCriteria) {
    setStatus("Defina um filtro (nivel, tag:, text:, pid:...) para buscar no arquivo todo.", true);
    tab.serverFilter = false;
    refreshPanel(tab);
    return;
  }
  params.set("offset", offset);
  params.set("limit", tab.limit);

  setStatus("Filtrando o arquivo inteiro...");
  try {
    const res = await fetch(`/api/filtered?${params}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Erro no filtro.", true);
      tab.serverFilter = false;
      refreshPanel(tab);
      return;
    }
    tab.lines = data.lines.map((text, i) => ({
      n: data.line_numbers[i],
      text,
      c: (data.columns || [])[i] || null,
    }));
    tab.offset = data.offset;
    tab.hasMore = data.has_more;
    tab.serverMatched = data.matched;
    tab.serverTruncated = data.truncated;
    tab.totalLines = data.total_lines || tab.totalLines;
    tab.selected.clear();
    tab.hlIdx = null;
    recomputeSearch(tab);
    refreshPanel(tab);
    renderHighlightList();
    setStatus(`${fmtNum(data.matched)} linha(s) casam no arquivo inteiro` +
      (data.truncated ? " (limite de varredura atingido)" : "") +
      (negateIgnored ? " | termos negados ('-') so valem na pagina carregada" : ""));
  } catch (err) {
    setStatus("Falha na requisicao: " + err, true);
  }
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
      if (tab.serverFilter) {
        loadServerFiltered(tab, 0);
        return;
      }
      recomputeSearch(tab);
      refreshPanel(tab);
    }, 250);
  });
  // Enter procura no arquivo inteiro: e o gesto natural, e sem ele a busca
  // ficaria presa na pagina carregada.
  liveInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(debounce);
    tab.liveFilter = liveInput.value;
    searchWholeFile(tab, 0);
  });

  toolbar.querySelectorAll(".level-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lvl = btn.dataset.level;
      if (tab.levels.has(lvl)) tab.levels.delete(lvl);
      else tab.levels.add(lvl);
      if (tab.serverFilter) {
        loadServerFiltered(tab, 0);
        return;
      }
      recomputeSearch(tab);
      refreshPanel(tab);
    });
  });

  const act = (name) => toolbar.querySelector(`[data-act="${name}"]`);
  // No modo "arquivo todo" a paginacao percorre o resultado filtrado.
  const goTo = (offset) => tab.serverFilter
    ? loadServerFiltered(tab, offset)
    : loadFileContent(tab, { offset });
  act("start").addEventListener("click", () => goTo(0));
  act("tail").addEventListener("click", () => tab.serverFilter
    ? goTo(Math.max(0, tab.serverMatched - tab.limit))
    : loadFileContent(tab, { tail: true }));
  act("prev").addEventListener("click", () => goTo(Math.max(0, tab.offset - tab.limit)));
  act("next").addEventListener("click", () => goTo(tab.offset + tab.limit));
  act("pagesize").addEventListener("change", (e) => {
    tab.limit = Number(e.target.value);
    goTo(tab.offset);
  });
  act("server").addEventListener("change", (e) => {
    tab.serverFilter = e.target.checked;
    if (tab.serverFilter) loadServerFiltered(tab, 0);
    else loadFileContent(tab, { offset: 0 });
  });
  act("find").addEventListener("click", () => promptSearch(tab));
  act("prevhit").addEventListener("click", () => stepSearch(tab, -1));
  act("nexthit").addEventListener("click", () => stepSearch(tab, 1));
  act("filesearch").addEventListener("click", () => searchWholeFile(tab, 0));
  act("timeline").addEventListener("click", () => {
    tab.timelineOpen = !tab.timelineOpen;
    refreshPanel(tab);
  });
  const gotoInput = act("goto");
  gotoInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const n = parseInt(gotoInput.value.replace(/\D/g, ""), 10);
    if (!n || n < 1) return;
    jumpToLine(tab, Math.min(n, tab.totalLines || n));
  });
  act("wrap").addEventListener("change", (e) => {
    tab.wrapText = e.target.checked;
    refreshPanel(tab);
  });
  act("export").addEventListener("click", () => exportLines(tab, shown));
  act("reset").addEventListener("click", () => resetFilters(tab));

  const tbody = wrap.querySelector("tbody");
  if (!tbody) return;

  tbody.addEventListener("click", (e) => {
    // Abrir/fechar um bloco de stack trace nao mexe na selecao.
    const toggle = e.target.closest(".trace-toggle");
    if (toggle) {
      const id = toggle.dataset.group;
      if (tab.openTraces.has(id)) tab.openTraces.delete(id);
      else tab.openTraces.add(id);
      refreshPanel(tab);
      return;
    }
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
    // Le a selecao de texto antes de qualquer redesenho, que a destruiria.
    const picked = String(window.getSelection()).trim();
    const n = Number(tr.dataset.line);
    if (!tab.selected.has(n)) {
      tab.selected.clear();
      tab.selected.add(n);
      tab.lastClicked = n;
      refreshPanel(tab);
    }
    showContextMenu(e.clientX, e.clientY, tab, picked);
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

function showContextMenu(x, y, tab, picked) {
  const tags = selectedFieldValues(tab, "tag");
  const pids = selectedFieldValues(tab, "pid");
  const tagLabel = tags.size ? ` (${[...tags].slice(0, 2).join(", ")}${tags.size > 2 ? "..." : ""})` : "";
  const pidLabel = pids.size ? ` (${[...pids].slice(0, 3).join(", ")}${pids.size > 3 ? "..." : ""})` : "";

  picked = picked || "";
  const items = [
    { label: picked ? `Destacar "${picked.slice(0, 24)}${picked.length > 24 ? "..." : ""}"` : "Destacar texto selecionado",
      disabled: !picked, act: () => addHighlight(picked, false) },
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
// Glossario de siglas (PID, TID, UID, niveis, AMS/WMS/PMS, ANR, OOM...)
// ---------------------------------------------------------------------------

let glossaryData = null;

async function ensureGlossary() {
  if (glossaryData) return glossaryData;
  try {
    const res = await fetch("/api/glossary");
    if (res.ok) glossaryData = await res.json();
  } catch { /* sem glossario a tabela continua funcionando */ }
  return glossaryData;
}
ensureGlossary().then(() => {
  const tab = activeTab();
  if (tab) refreshPanel(tab);
});

function glossaryEntry(sigla) {
  if (!glossaryData) return null;
  return glossaryData.entries.find((e) => e.sigla === sigla) || null;
}

function levelTitle(level) {
  const e = level && glossaryEntry(level);
  return e ? ` title="${escapeHtml(`${e.sigla} - ${e.nome}: ${e.desc}`)}"` : "";
}

/** Dica da coluna Tag quando a TAG e um servico conhecido (AMS, WMS, PMS...). */
function glossaryTagTitle(tag) {
  if (!tag || !glossaryData) return "";
  const sigla = glossaryData.tag_index[tag];
  if (!sigla) return "";
  const e = glossaryEntry(sigla);
  return e ? ` title="${escapeHtml(`${e.sigla} (${e.nome}): ${e.desc}`)}"` : "";
}

const glossaryDialog = el("#glossaryDialog");

async function openGlossary() {
  await ensureGlossary();
  glossaryDialog.hidden = false;
  renderGlossary();
  el("#glossarySearch").focus();
}

function renderGlossary() {
  const body = el("#glossaryBody");
  if (!glossaryData) {
    body.textContent = "Glossario indisponivel.";
    return;
  }
  const q = el("#glossarySearch").value.trim().toLowerCase();
  const parts = [];
  for (const [gid, label] of Object.entries(glossaryData.groups)) {
    const rows = glossaryData.entries.filter((e) =>
      e.group === gid &&
      (!q || e.sigla.toLowerCase().includes(q) || e.nome.toLowerCase().includes(q) ||
        e.desc.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q))));
    if (!rows.length) continue;
    parts.push(`<h3 class="gl-group">${escapeHtml(label)}</h3>` +
      rows.map((e) =>
        `<div class="gl-item"><div class="gl-head"><code>${escapeHtml(e.sigla)}</code>` +
        `<strong>${escapeHtml(e.nome)}</strong></div>` +
        `<p>${escapeHtml(e.desc)}</p>` +
        (e.tags.length
          ? `<p class="gl-tags">TAGs no log: ${e.tags.map((t) =>
              `<code>${escapeHtml(t)}</code>`).join(" ")}</p>`
          : "") +
        `</div>`).join(""));
  }
  body.innerHTML = parts.length ? parts.join("") : '<p class="gl-empty">Nada encontrado.</p>';
}

el("#glossaryBtn").addEventListener("click", openGlossary);
el("#glossaryClose").addEventListener("click", () => { glossaryDialog.hidden = true; });
el("#glossarySearch").addEventListener("input", renderGlossary);
glossaryDialog.addEventListener("click", (e) => {
  if (e.target === glossaryDialog) glossaryDialog.hidden = true;
});

// ---------------------------------------------------------------------------
// Linha do tempo: mapa de calor do arquivo inteiro
// ---------------------------------------------------------------------------

const EVENT_STYLE = {
  crash: { label: "Crash Java", color: "#dc2626" },
  anr: { label: "ANR", color: "#b91c1c" },
  native: { label: "Crash nativo", color: "#7f1d1d" },
  watchdog: { label: "Watchdog", color: "#a21caf" },
  oom: { label: "Falta de memoria", color: "#c2410c" },
  boot: { label: "Boot", color: "#2563eb" },
};

async function loadTimeline(tab) {
  if (tab.timeline || tab.timelineLoading) return;
  tab.timelineLoading = true;
  refreshPanel(tab);
  try {
    const params = new URLSearchParams({ root: state.root, file: tab.path, buckets: 600 });
    const res = await fetch(`/api/timeline?${params}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Erro montando a linha do tempo.", true);
      return;
    }
    tab.timeline = data;
    const total = data.events.length;
    setStatus(total
      ? `Linha do tempo pronta: ${total} evento(s) notavel(is) no arquivo.`
      : "Linha do tempo pronta: nenhum crash, ANR ou watchdog encontrado.");
  } catch (err) {
    setStatus("Falha na requisicao: " + err, true);
  } finally {
    tab.timelineLoading = false;
    refreshPanel(tab);
  }
}

/** Barra que representa o arquivo inteiro: altura = volume de erros na faixa,
 *  marcas verticais = crashes, ANRs e afins. Clicar navega ate a faixa. */
function buildTimeline(tab) {
  // A linha do tempo so ocupa espaco quando pedida, e o botao da barra fecha.
  if (!tab.timelineOpen) return null;

  const box = document.createElement("div");
  box.className = "timeline";
  const close = () => {
    tab.timelineOpen = false;
    refreshPanel(tab);
  };

  if (!tab.timeline) {
    box.innerHTML = tab.timelineLoading
      ? '<div class="tl-head"><span class="timeline-hint">Analisando o arquivo inteiro...</span></div>'
      : '<div class="tl-head"><button class="timeline-load">Analisar o arquivo e montar a linha do tempo</button>' +
        '<span class="timeline-hint">Percorre o arquivo todo uma vez; o resultado fica em cache.</span></div>';
    const head = box.querySelector(".tl-head");
    const btn = document.createElement("button");
    btn.className = "icon-btn tl-close";
    btn.innerHTML = "&times;";
    btn.title = "Fechar a linha do tempo";
    btn.addEventListener("click", close);
    head.appendChild(btn);
    const load = box.querySelector(".timeline-load");
    if (load) load.addEventListener("click", () => loadTimeline(tab));
    return box;
  }

  const buckets = tab.timeline.buckets;
  const worst = Math.max(1, ...buckets.map((b) =>
    (b.levels.E || 0) + (b.levels.F || 0) + (b.levels.W || 0)));

  const bars = buckets.map((b) => {
    const err = (b.levels.E || 0) + (b.levels.F || 0);
    const warn = b.levels.W || 0;
    const height = Math.round(((err + warn) / worst) * 100);
    const kinds = Object.keys(b.events);
    const evColor = kinds.length ? EVENT_STYLE[kinds[0]].color : null;
    const title = `linhas ${fmtNum(b.start_line)}-${fmtNum(b.end_line)}` +
      (b.first_time ? ` | ${b.first_time}` : "") +
      ` | ${err} erro(s), ${warn} aviso(s)` +
      (kinds.length ? ` | ${kinds.map((k) => EVENT_STYLE[k].label).join(", ")}` : "");
    return `<div class="tl-bar" data-line="${b.start_line}" title="${escapeHtml(title)}">` +
      `<i style="height:${height}%;background:${err ? "var(--lvl-E)" : "var(--lvl-W)"}"></i>` +
      (evColor ? `<b style="background:${evColor}"></b>` : "") +
      `</div>`;
  }).join("");

  // Posicao da janela carregada dentro do arquivo.
  const total = Math.max(1, tab.totalLines);
  const left = (tab.offset / total) * 100;
  const width = Math.max(0.4, (tab.lines.length / total) * 100);

  box.innerHTML =
    `<div class="tl-head">` +
      `<span class="timeline-hint">Linha do tempo do arquivo &mdash; clique numa faixa para ir ate ela` +
      `${tab.timeline.truncated ? " (analise truncada)" : ""}</span>` +
      `<span class="fd-spacer"></span>` +
      `<button class="icon-btn tl-close" title="Fechar a linha do tempo">&times;</button>` +
    `</div>` +
    `<div class="tl-track">${bars}<div class="tl-window" style="left:${left}%;width:${width}%"></div></div>` +
    `<div class="tl-events"></div>`;

  box.querySelector(".tl-close").addEventListener("click", close);
  box.querySelector(".tl-track").addEventListener("click", (e) => {
    const bar = e.target.closest(".tl-bar");
    if (!bar) return;
    const line = Number(bar.dataset.line);
    loadFileContent(tab, { offset: Math.max(0, line - 1), scrollToLine: line });
  });

  // Lista compacta dos eventos, para pular direto ao crash.
  const evBox = box.querySelector(".tl-events");
  const events = tab.timeline.events;
  if (!events.length) {
    evBox.innerHTML = '<span class="timeline-hint">Nenhum crash, ANR ou watchdog no arquivo.</span>';
  } else {
    evBox.innerHTML = events.slice(0, 60).map((e, i) =>
      `<button class="tl-event" data-i="${i}" style="border-color:${EVENT_STYLE[e.kind].color}" ` +
      `title="${escapeHtml(`linha ${e.line} | ${e.text}`)}">` +
      `${EVENT_STYLE[e.kind].label} <span class="tl-ev-line">L${fmtNum(e.line)}</span></button>`).join("") +
      (events.length > 60 ? `<span class="timeline-hint">+${events.length - 60} evento(s)</span>` : "");
    evBox.querySelectorAll(".tl-event").forEach((btn) => {
      btn.addEventListener("click", () => {
        const e = events[Number(btn.dataset.i)];
        jumpToLine(tab, e.line);
      });
    });
  }
  return box;
}

// ---------------------------------------------------------------------------
// Mapa PID -> processo
// ---------------------------------------------------------------------------

async function loadProcessMap(tab) {
  if (tab.procMap || tab.procLoading) return;
  tab.procLoading = true;
  try {
    const params = new URLSearchParams({ root: state.root, file: tab.path });
    const res = await fetch(`/api/process_map?${params}`);
    const data = await res.json();
    if (!res.ok) return;
    tab.procMap = data.pids || {};
    tab.procUids = data.uids || {};
    tab.procAmbiguous = new Set(data.ambiguous || []);
    if (data.count) {
      setStatus(`${data.count} PID(s) vinculados ao nome do processo.`);
      refreshPanel(tab);
    }
  } catch { /* o nome do processo e um extra; sem ele a coluna PID segue util */ }
  finally { tab.procLoading = false; }
}

function processName(tab, pid) {
  return (tab.procMap && tab.procMap[pid]) || null;
}

// ---------------------------------------------------------------------------
// Aba lateral: Destaques (varias palavras coloridas, com navegacao)
// ---------------------------------------------------------------------------

const HIGHLIGHTS_KEY = "logviewer.highlights";
const HL_COLORS = 8;  // .hl-0 ... .hl-7 no CSS

state.highlights = store(HIGHLIGHTS_KEY, []);
state.activeHighlightId = null;

const hlListEl = el("#hlList");
let hlNewColor = 0;

function saveHighlights() {
  persist(HIGHLIGHTS_KEY, state.highlights);
  renderHighlightList();
  const tab = activeTab();
  if (tab) refreshPanel(tab);
}

function renderSwatches() {
  el("#hlSwatches").innerHTML = Array.from({ length: HL_COLORS }, (_, i) =>
    `<button type="button" class="hl-swatch hl-${i}${i === hlNewColor ? " on" : ""}" ` +
    `data-color="${i}" title="Cor ${i + 1}"></button>`).join("");
  el("#hlSwatches").querySelectorAll(".hl-swatch").forEach((b) => {
    b.addEventListener("click", () => {
      hlNewColor = Number(b.dataset.color);
      renderSwatches();
    });
  });
}
renderSwatches();

/** Linhas visiveis da pagina que casam com o destaque. */
function highlightHits(tab, hl) {
  if (!tab || !hl.pattern) return [];
  const re = globalRegex(hl.pattern, hl.caseSensitive);
  const hits = [];
  for (const line of visibleLines(tab)) {
    re.lastIndex = 0;
    if (re.test(line.text)) hits.push(line.n);
  }
  return hits;
}

function renderHighlightList() {
  hlListEl.innerHTML = "";
  if (!state.highlights.length) {
    hlListEl.innerHTML = '<li class="hl-empty">Nenhum destaque ainda.</li>';
    return;
  }
  const tab = activeTab();
  for (const hl of state.highlights) {
    const count = hl.enabled && tab ? highlightHits(tab, hl).length : 0;
    const li = document.createElement("li");
    li.className = "hl-item" + (state.activeHighlightId === hl.id ? " active" : "");
    li.innerHTML =
      `<input type="checkbox" class="hl-on"${hl.enabled ? " checked" : ""} title="Ligar/desligar">` +
      `<span class="hl-chip hl-${hl.color}">${escapeHtml(hl.pattern)}</span>` +
      `<span class="hl-count" title="Ocorrencias na pagina carregada">${hl.enabled && tab ? count : "-"}</span>` +
      `<button class="hl-nav" data-dir="-1" title="Ocorrencia anterior (Shift+F3)">&#8963;</button>` +
      `<button class="hl-nav" data-dir="1" title="Proxima ocorrencia (F3)">&#8964;</button>` +
      `<button class="hl-del" title="Remover destaque">&times;</button>`;

    li.querySelector(".hl-on").addEventListener("change", (e) => {
      hl.enabled = e.target.checked;
      saveHighlights();
    });
    li.querySelector(".hl-chip").addEventListener("click", () => stepHighlight(hl, 1));
    li.querySelectorAll(".hl-nav").forEach((b) =>
      b.addEventListener("click", () => stepHighlight(hl, Number(b.dataset.dir))));
    li.querySelector(".hl-del").addEventListener("click", () => {
      state.highlights = state.highlights.filter((h) => h.id !== hl.id);
      if (state.activeHighlightId === hl.id) state.activeHighlightId = null;
      saveHighlights();
    });
    hlListEl.appendChild(li);
  }
}

/** Pula para a proxima (ou anterior) linha que contem o destaque. */
function stepHighlight(hl, delta) {
  const tab = activeTab();
  if (!tab) {
    setStatus("Abra um arquivo primeiro.", true);
    return;
  }
  if (!hl.enabled) {
    hl.enabled = true;
    saveHighlights();
  }
  const hits = highlightHits(tab, hl);
  if (!hits.length) {
    setStatus(`"${hl.pattern}" nao aparece nesta pagina.`, true);
    return;
  }
  // Trocar de destaque recomeca a navegacao a partir da linha selecionada.
  if (state.activeHighlightId !== hl.id || tab.hlIdx == null) {
    const from = tab.selected.size ? Math.min(...tab.selected) : tab.offset;
    const forward = hits.findIndex((n) => n > from);
    tab.hlIdx = delta > 0
      ? (forward === -1 ? 0 : forward)
      : (forward === -1 ? hits.length - 1 : Math.max(0, forward - 1));
    state.activeHighlightId = hl.id;
  } else {
    tab.hlIdx = (tab.hlIdx + delta + hits.length) % hits.length;
  }
  const n = hits[tab.hlIdx];
  tab.selected.clear();
  tab.selected.add(n);
  refreshPanel(tab);
  scrollLogToLine(tab, n);
  renderHighlightList();
  setStatus(`"${hl.pattern}": ocorrencia ${tab.hlIdx + 1} de ${hits.length} (linha ${fmtNum(n)}).`);
}

function addHighlight(pattern, caseSensitive) {
  pattern = (pattern || "").trim();
  if (!pattern) return null;
  const existing = state.highlights.find((h) => h.pattern === pattern);
  if (existing) {
    existing.enabled = true;
    saveHighlights();
    setStatus(`"${pattern}" ja estava na lista de destaques.`);
    return existing;
  }
  const hl = {
    id: "h" + Date.now() + Math.random().toString(36).slice(2, 6),
    pattern,
    color: hlNewColor,
    enabled: true,
    caseSensitive: !!caseSensitive,
  };
  state.highlights.push(hl);
  hlNewColor = (hlNewColor + 1) % HL_COLORS;  // proxima cor por padrao
  renderSwatches();
  saveHighlights();
  return hl;
}

el("#hlAddBtn").addEventListener("click", () => {
  const input = el("#hlPattern");
  if (addHighlight(input.value, el("#hlCase").checked)) input.value = "";
});
el("#hlPattern").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("#hlAddBtn").click();
});
el("#hlFromSelBtn").addEventListener("click", () => {
  const text = String(window.getSelection()).trim();
  if (!text) {
    setStatus("Selecione um trecho de texto na tabela de log primeiro.", true);
    return;
  }
  addHighlight(text, el("#hlCase").checked);
  setStatus(`"${text}" destacado.`);
});

renderHighlightList();

// ---------------------------------------------------------------------------
// Sessao: guardar e retomar a analise inteira
// ---------------------------------------------------------------------------

const SESSION_VERSION = 1;

function exportSession() {
  if (!state.tabs.length && !state.savedFilters.length && !state.highlights.length) {
    setStatus("Nada para salvar ainda.", true);
    return;
  }
  const session = {
    version: SESSION_VERSION,
    saved_at: new Date().toISOString(),
    root: state.root,
    theme: document.documentElement.dataset.theme,
    paneCount: state.paneCount,
    syncTime: state.syncTime,
    savedFilters: state.savedFilters,
    highlights: state.highlights,
    // panes guarda o caminho, nao o id: os ids sao recriados ao abrir.
    panes: state.panes.slice(0, state.paneCount).map((id) => {
      const t = state.tabs.find((x) => x.id === id);
      return t ? t.path : null;
    }),
    tabs: state.tabs.map((t) => ({
      path: t.path,
      offset: t.offset,
      limit: t.limit,
      wrapText: t.wrapText,
      liveFilter: t.liveFilter,
      serverFilter: t.serverFilter,
      levels: [...t.levels],
      showTags: [...t.showTags], hideTags: [...t.hideTags],
      showPids: [...t.showPids], hidePids: [...t.hidePids],
      highlightTags: [...t.highlightTags], highlightPids: [...t.highlightPids],
      bookmarks: [...t.bookmarks],
      timeRange: t.timeRange,
      activeFilterId: t.activeFilterId,
    })),
  };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  downloadText(`logviewer-sessao-${stamp}.json`, JSON.stringify(session, null, 2));
  setStatus(`Sessao salva: ${session.tabs.length} aba(s), ${session.highlights.length} destaque(s).`);
}

async function importSession(file) {
  let session;
  try {
    session = JSON.parse(await file.text());
  } catch (err) {
    setStatus("Arquivo de sessao invalido: " + err, true);
    return;
  }
  if (!session || !Array.isArray(session.tabs)) {
    setStatus("Arquivo de sessao invalido.", true);
    return;
  }

  if (session.theme) applyTheme(session.theme);
  if (Array.isArray(session.savedFilters)) state.savedFilters = session.savedFilters;
  if (Array.isArray(session.highlights)) state.highlights = session.highlights;
  state.paneCount = session.paneCount || 1;
  state.syncTime = session.syncTime !== false;
  el("#paneCount").value = String(state.paneCount);
  el("#syncTime").checked = state.syncTime;
  persist(FILTERS_KEY, state.savedFilters);
  persist(HIGHLIGHTS_KEY, state.highlights);

  if (session.root) {
    state.root = session.root;
    el("#rootInput").value = session.root;
    await loadRoot();
  }

  state.tabs = [];
  state.panes = [null, null, null];
  const byPath = new Map();
  for (const saved of session.tabs) {
    const tab = newTab(saved.path);
    tab.limit = saved.limit || DEFAULT_PAGE_SIZE;
    tab.wrapText = !!saved.wrapText;
    tab.liveFilter = saved.liveFilter || "";
    tab.serverFilter = !!saved.serverFilter;
    tab.activeFilterId = saved.activeFilterId || null;
    tab.timeRange = saved.timeRange || null;
    for (const [key, values] of Object.entries({
      levels: saved.levels, showTags: saved.showTags, hideTags: saved.hideTags,
      showPids: saved.showPids, hidePids: saved.hidePids,
      highlightTags: saved.highlightTags, highlightPids: saved.highlightPids,
      bookmarks: saved.bookmarks,
    })) {
      for (const v of values || []) tab[key].add(v);
    }
    state.tabs.push(tab);
    byPath.set(saved.path, tab);
  }
  (session.panes || []).forEach((path, i) => {
    const tab = path && byPath.get(path);
    if (tab) state.panes[i] = tab.id;
  });
  state.activeTab = state.tabs.length ? (state.panes[0] || state.tabs[0].id) : null;

  renderTabs();
  renderFilterList();
  renderHighlightList();
  // Recarrega o conteudo de cada aba na posicao em que a sessao foi salva.
  for (const saved of session.tabs) {
    const tab = byPath.get(saved.path);
    if (!tab) continue;
    if (tab.serverFilter) await loadServerFiltered(tab, saved.offset || 0);
    else await loadFileContent(tab, { offset: saved.offset || 0 });
  }
  renderPanels();
  setStatus(`Sessao restaurada: ${state.tabs.length} aba(s).`);
}

el("#sessionSaveBtn").addEventListener("click", exportSession);
el("#sessionLoadBtn").addEventListener("click", () => el("#sessionFile").click());
el("#sessionFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importSession(file);
  e.target.value = "";
});

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
  if (e.key === "F3") {
    e.preventDefault();
    const delta = e.shiftKey ? -1 : 1;
    const hl = state.highlights.find((h) => h.id === state.activeHighlightId)
      || state.highlights.find((h) => h.enabled);
    if (hl) stepHighlight(hl, delta);
    else {
      const tab = activeTab();
      if (tab) stepSearch(tab, delta);  // sem destaques, F3 navega a busca
    }
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
  const options = loadHistory()
    .map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");
  // Uma lista para o painel de busca em arquivos e outra para a caixa de
  // filtro de cada painel; as duas compartilham o mesmo historico.
  for (const id of ["searchHistoryList", "filterHistoryList"]) {
    let dl = document.getElementById(id);
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = id;
      document.body.appendChild(dl);
    }
    dl.innerHTML = options;
  }
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
