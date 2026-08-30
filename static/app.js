/* Log Viewer - visualizador offline de logcat.
 *
 * A tabela, as cores por nivel, o menu de contexto (mostrar/esconder/destacar
 * TAG e PID) e os filtros salvos seguem o LogcatOfflineView; o filtro ao vivo
 * com prefixos e condicoes negadas segue o LogRabbit. A aba lateral
 * "Dispositivo" e alimentada por /api/device_info.
 */

const LEVELS = ["V", "D", "I", "W", "E", "F"];
const PAGE_SIZES = [500, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
// Por padrao carrega o maximo de linhas que o backend aceita (MAX_LIMIT em
// reader.py): menos paginacao para navegar, e a virtualizacao abaixo cuida
// de manter isso leve no navegador.
const DEFAULT_PAGE_SIZE = PAGE_SIZES[PAGE_SIZES.length - 1];

// Acima deste numero de linhas visiveis, a tabela vira uma janela virtual:
// so as linhas dentro (ou perto) da area visivel do painel viram <tr> de
// verdade, e o espaco das demais e reservado por duas linhas "espacadoras"
// com a altura equivalente. Sem isso, escolher 50.000+ linhas travaria o
// navegador (centenas de milhares de <tr> no DOM). --row-h no style.css
// precisa continuar em 18px para essa conta bater.
const ROW_H = 18;
const VIRTUALIZE_THRESHOLD = 2000;
const VIRTUALIZE_BUFFER = 60;
// "Quebrar linha" desliga a virtualizacao (altura da linha deixa de ser fixa),
// entao com a pagina padrao carregando ate 200.000 linhas ligar esse modo sem
// limite travaria o navegador com centenas de milhares de <tr> reais.
const WRAP_SAFE_LIMIT = 20000;

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
  // Aparelho USB de onde veio a pasta aberta, quando foi uma captura.
  rootDevice: null,
  rootDeviceBase: null,
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
// Seletor de pasta
// ---------------------------------------------------------------------------
// Quem navega e o servidor: o navegador nunca revela o caminho real de uma
// pasta escolhida pelo usuario, e e o servidor que precisa enxerga-la para ler
// os logs. Dentro do container isso mostra exatamente o que foi montado.

const browseDialog = el("#browseDialog");
let browsePathAtual = "";
// "root": escolher a pasta principal (#rootInput), como sempre.
// "add-entry": adicionar um arquivo OU pasta aos arquivos do projeto — o
// navegador nunca revela o caminho real de algo escolhido pelo usuario, entao
// mesmo pra "adicionar" precisa ser o servidor navegando (mesma razao de
// /api/browse existir).
let browseMode = "root";

el("#browseBtn").addEventListener("click", () => {
  browseMode = "root";
  el("#browseTitle").textContent = "Escolher a pasta com os logs";
  el("#browsePick").textContent = "Usar esta pasta";
  const atual = el("#rootInput").value.trim();
  browseDialog.hidden = false;
  openBrowse(atual || (state.config && state.config.default_root) || "");
});

el("#addEntryBtn").addEventListener("click", () => {
  browseMode = "add-entry";
  el("#browseTitle").textContent = "Adicionar arquivo ou pasta aos arquivos do projeto";
  el("#browsePick").textContent = "Adicionar esta pasta";
  browseDialog.hidden = false;
  openBrowse(state.root || (state.config && state.config.default_root) || "");
});

const fecharBrowse = () => { browseDialog.hidden = true; };
el("#browseClose").addEventListener("click", fecharBrowse);
el("#browseCancel").addEventListener("click", fecharBrowse);
browseDialog.addEventListener("click", (e) => { if (e.target === browseDialog) fecharBrowse(); });

el("#browseUp").addEventListener("click", () => {
  if (browseParent) openBrowse(browseParent);
});
el("#browseGo").addEventListener("click", () => openBrowse(el("#browsePath").value.trim()));
el("#browsePath").addEventListener("keydown", (e) => {
  if (e.key === "Enter") openBrowse(el("#browsePath").value.trim());
});
el("#browsePick").addEventListener("click", () => {
  if (!browsePathAtual) return;
  fecharBrowse();
  if (browseMode === "add-entry") {
    addProjectEntry(browsePathAtual, true);
  } else {
    el("#rootInput").value = browsePathAtual;
    loadRoot();
  }
});

let browseParent = null;

async function openBrowse(path) {
  const lista = el("#browseList");
  lista.innerHTML = '<li class="browse-empty">Carregando...</li>';
  try {
    const params = path ? `?path=${encodeURIComponent(path)}` : "";
    const res = await fetch(`/api/browse${params}`);
    const data = await res.json();
    if (!res.ok) {
      lista.innerHTML = `<li class="browse-empty browse-err">${escapeHtml(data.error)}</li>`;
      return;
    }
    browsePathAtual = data.path;
    browseParent = data.parent;
    el("#browsePath").value = data.path;
    el("#browseUp").disabled = !data.parent;

    const dirsHtml = data.dirs.map((d) =>
      `<li class="browse-dir" data-path="${escapeHtml(d.path)}">` +
      `\u{1F4C1} ${escapeHtml(d.name)}</li>`).join("");
    // No modo de adicionar, arquivos tambem aparecem e sao escolhiveis um a
    // um — no modo de escolher a pasta raiz eles nao interessam.
    const filesHtml = browseMode === "add-entry" && data.file_list
      ? data.file_list.map((f) =>
          `<li class="browse-file" data-path="${escapeHtml(f.path)}" title="Adicionar este arquivo">` +
          `\u{1F4C4} ${escapeHtml(f.name)}</li>`).join("")
      : "";
    const semNada = browseMode === "add-entry"
      ? !dirsHtml && !filesHtml
      : !dirsHtml;
    lista.innerHTML = dirsHtml + filesHtml +
      (data.truncated ? '<li class="browse-empty">(lista truncada)</li>' : "") +
      (semNada ? `<li class="browse-empty">${browseMode === "add-entry" ? "Pasta vazia." : "Nenhuma subpasta aqui."}</li>` : "");

    // O numero de arquivos ajuda a reconhecer a pasta certa sem entrar nela.
    el("#browseInfo").textContent = data.files
      ? `${fmtNum(data.files)} arquivo(s) nesta pasta` +
        (data.dirs.length ? ` e ${data.dirs.length} subpasta(s)` : "")
      : `${data.dirs.length} subpasta(s), nenhum arquivo solto aqui`;

    lista.querySelectorAll(".browse-dir").forEach((li) => {
      li.addEventListener("click", () => openBrowse(li.dataset.path));
    });
    lista.querySelectorAll(".browse-file").forEach((li) => {
      li.addEventListener("click", () => {
        fecharBrowse();
        addProjectEntry(li.dataset.path, false);
      });
    });

    if (data.shortcuts) {
      el("#browseShortcuts").innerHTML = data.shortcuts.map((s) =>
        `<button class="browse-shortcut" data-path="${escapeHtml(s.path)}" ` +
        `title="${escapeHtml(s.path)}">${escapeHtml(s.label)}</button>`).join("");
      el("#browseShortcuts").querySelectorAll(".browse-shortcut").forEach((btn) => {
        btn.addEventListener("click", () => openBrowse(btn.dataset.path));
      });
    }
  } catch (err) {
    lista.innerHTML = `<li class="browse-empty browse-err">Falha: ${escapeHtml(err)}</li>`;
  }
}

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

/** No container a pasta de logs e um volume montado; sem isso o campo abriria
 *  vazio e o usuario teria de adivinhar o caminho de dentro do container.
 *
 *  A pasta lembrada da sessao anterior pode nao existir no ambiente atual —
 *  e o caso classico de ter usado o app direto e depois subir o container, em
 *  que o caminho do host nao existe la dentro. Nesse caso caimos na pasta
 *  padrao em vez de deixar o erro na tela. */
fetch("/api/config").then(async (r) => {
  const cfg = await r.json();
  state.config = cfg;
  const salvo = el("#rootInput").value.trim();

  if (salvo && await loadRoot()) return;
  if (!cfg.default_root || cfg.default_root === salvo) return;

  el("#rootInput").value = cfg.default_root;
  if (await loadRoot() && salvo) {
    setStatus(`A pasta "${salvo}" nao existe neste ambiente; abri ${cfg.default_root}.`);
  }
}).catch(() => { /* sem config o app segue como antes */ });

/** Carrega a arvore da pasta informada. Devolve true se deu certo. */
async function loadRoot() {
  const root = el("#rootInput").value.trim();
  if (!root) return false;
  state.root = root;
  // Trocar para uma pasta fora da captura desfaz o vinculo com o aparelho.
  if (state.rootDevice && !(state.rootDeviceBase && root.startsWith(state.rootDeviceBase))) {
    setRootDevice(null);
  }
  setStatus("Carregando arvore...");
  const data = await fetchTreeEntries(root);
  if (data.error) {
    // Dentro do container so existe o que foi montado; dizer isso evita o
    // usuario ficar procurando um caminho do host que nunca vai aparecer.
    const dica = state.config && state.config.in_container
      ? ` O app esta rodando em container e so enxerga a pasta montada` +
        `${state.config.default_root ? " (" + state.config.default_root + ")" : ""}.`
      : "";
    setStatus(data.error + dica, true);
    return false;
  }
  // So guarda o caminho depois de saber que ele funciona: guardar antes fazia
  // um caminho invalido voltar a cada recarga da pagina.
  persist(ROOT_KEY, root);
  state.rootEntries = data.entries;
  renderFilesPane();
  setStatus(`${data.entries.length} itens` +
    (data.truncated ? ` (truncado em ${data.max_entries})` : ""));
  return true;
}

async function fetchTreeEntries(root) {
  try {
    const res = await fetch(`/api/tree?root=${encodeURIComponent(root)}`);
    const data = await res.json();
    if (!res.ok) return { error: data.error || "Erro ao carregar pasta" };
    return data;
  } catch (err) {
    return { error: "Falha na requisicao: " + err };
  }
}

/** Junta uma raiz absoluta com um caminho relativo que o /api/tree devolveu
 *  (relativo pode vir vazio, para a propria raiz). */
function joinPath(root, rel) {
  if (!rel) return root;
  return root.replace(/\/+$/, "") + "/" + rel;
}

function pathBasename(p) {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function pathDirname(p) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Um caminho (arquivo ou pasta, em qualquer raiz) foi removido dos arquivos
 *  do projeto: some da barra lateral sem tocar em nada no disco. */
function isHidden(absPath) {
  for (const h of state.hiddenPaths) {
    if (absPath === h || absPath.startsWith(h + "/")) return true;
  }
  return false;
}

/** Monta o modelo em arvore (pastas/arquivos aninhados) a partir da lista
 *  achatada que o /api/tree devolve para uma raiz, pulando o que foi
 *  removido dos arquivos do projeto. */
function buildTreeModel(root, entries) {
  const rootNode = { children: new Map(), is_dir: true, path: "" };
  for (const entry of entries) {
    if (isHidden(joinPath(root, entry.path))) continue;
    const parts = entry.path.split("/");
    let node = rootNode;
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
  return rootNode;
}

/** Redesenha a aba "Arquivos" inteira: a arvore da pasta raiz principal (se
 *  houver) seguida de cada item extra fixado nos arquivos do projeto — cada
 *  um com a sua propria raiz, podendo estar em qualquer lugar do disco. */
function renderFilesPane() {
  treeEl.innerHTML = "";
  if (state.root && state.rootEntries) {
    const model = buildTreeModel(state.root, state.rootEntries);
    renderNode(model, treeEl, { root: state.root });
  }
  for (const entryItem of state.projectEntries) {
    treeEl.appendChild(renderProjectEntryRow(entryItem));
  }
  if (!state.root && !state.projectEntries.length) {
    treeEl.innerHTML = '<p class="side-hint">Carregue uma pasta ou adicione um arquivo/pasta ' +
      'aos arquivos do projeto.</p>';
  }
}

const REMOVE_BTN_HTML =
  '<button class="entry-remove" tabindex="-1" ' +
  'title="Remover dos arquivos do projeto (nao apaga do disco)">&times;</button>';

/** Clique no "x" ou tecla Delete/Backspace com a linha focada removem o item
 *  — sempre so da lista de exibicao, nunca do disco. */
function wireRemove(row, onRemove) {
  row.querySelector(".entry-remove").addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  row.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove();
    }
  });
}

/** Um item de `state.projectEntries`: sua propria linha de topo (com raiz
 *  independente), removivel por inteiro. Pastas carregam a arvore so quando
 *  expandidas pela primeira vez. */
function renderProjectEntryRow(entryItem) {
  const wrap = document.createElement("div");
  const name = pathBasename(entryItem.path) || entryItem.path;
  const row = document.createElement("div");
  row.className = "entry project-entry " + (entryItem.is_dir ? "dir" : "file text");
  row.tabIndex = 0;
  row.title = entryItem.path;

  const childContainer = document.createElement("div");
  if (entryItem.is_dir) {
    childContainer.style.display = "none";
    childContainer.style.paddingLeft = "14px";
  }

  const label = () => (entryItem.is_dir
    ? (childContainer.style.display !== "none" ? "▾ " : "▸ ")
    : "") + `\u{1F4CC} ${escapeHtml(name)}`;
  row.innerHTML = `<span class="entry-label">${label()}</span>` + REMOVE_BTN_HTML;

  row.addEventListener("click", async (e) => {
    if (e.target.closest(".entry-remove")) return;
    if (!entryItem.is_dir) {
      openFile(pathDirname(entryItem.path), pathBasename(entryItem.path));
      return;
    }
    const open = childContainer.style.display !== "none";
    childContainer.style.display = open ? "none" : "block";
    row.querySelector(".entry-label").innerHTML = label();
    if (!open && childContainer.childElementCount === 0) {
      childContainer.innerHTML = '<p class="side-hint">Carregando...</p>';
      const data = await fetchTreeEntries(entryItem.path);
      if (data.error) {
        childContainer.innerHTML = `<p class="side-hint">${escapeHtml(data.error)}</p>`;
        return;
      }
      childContainer.innerHTML = "";
      const model = buildTreeModel(entryItem.path, data.entries);
      renderNode(model, childContainer, { root: entryItem.path });
    }
  });
  wireRemove(row, () => removeProjectEntry(entryItem.path));

  wrap.appendChild(row);
  if (entryItem.is_dir) wrap.appendChild(childContainer);
  return wrap;
}

function renderNode(node, container, ctx) {
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
    row.tabIndex = 0;
    const label = (open) => (open ? "▾ " : "▸ ") + escapeHtml(dir.name);
    row.innerHTML = `<span class="entry-label">${label(false)}</span>` + REMOVE_BTN_HTML;
    const childContainer = document.createElement("div");
    childContainer.style.display = "none";
    childContainer.style.paddingLeft = "14px";
    row.addEventListener("click", (e) => {
      if (e.target.closest(".entry-remove")) return;
      const open = childContainer.style.display !== "none";
      childContainer.style.display = open ? "none" : "block";
      row.querySelector(".entry-label").innerHTML = label(!open);
      if (!open && childContainer.childElementCount === 0) {
        renderNode(dir, childContainer, ctx);
      }
    });
    wireRemove(row, () => hidePath(joinPath(ctx.root, dir.path)));
    container.appendChild(row);
    container.appendChild(childContainer);
  }

  for (const file of files) {
    const row = document.createElement("div");
    const isText = file.meta && file.meta.likely_text !== false;
    row.className = "entry file " + (isText ? "text" : "binary");
    row.tabIndex = 0;
    row.innerHTML =
      `<span class="entry-label">${escapeHtml(file.name)} <span class="size">${fmtSize(file.meta ? file.meta.size : null)}</span></span>` +
      REMOVE_BTN_HTML;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".entry-remove")) return;
      openFile(ctx.root, file.path);
    });
    wireRemove(row, () => hidePath(joinPath(ctx.root, file.path)));
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Arquivos do projeto: itens extras fixados na barra lateral (podem estar em
// qualquer lugar do disco) e caminhos removidos da exibicao. Compartilhados
// entre web/Mac/Windows via o backend (o mesmo motivo do FILTERS_KEY).
// ---------------------------------------------------------------------------

const PROJECT_ENTRIES_KEY = "logviewer.projectEntries";
const HIDDEN_PATHS_KEY = "logviewer.hiddenPaths";
state.projectEntries = store(PROJECT_ENTRIES_KEY, []);
state.hiddenPaths = new Set(store(HIDDEN_PATHS_KEY, []));

async function syncProjectEntries() {
  persist(PROJECT_ENTRIES_KEY, state.projectEntries);
  try {
    const res = await fetch("/api/project_entries", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.projectEntries),
    });
    if (res.ok) {
      // O servidor decide arquivo/pasta pelo que existe de verdade no disco
      // (util quando quem chamou nao tinha certeza, como um item arrastado).
      const data = await res.json();
      if (Array.isArray(data.entries)) {
        state.projectEntries = data.entries;
        persist(PROJECT_ENTRIES_KEY, state.projectEntries);
        renderFilesPane();
      }
    }
  } catch { /* sem servidor: continua valendo localmente */ }
}

async function syncHiddenPaths() {
  persist(HIDDEN_PATHS_KEY, [...state.hiddenPaths]);
  try {
    await fetch("/api/hidden_paths", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([...state.hiddenPaths]),
    });
  } catch { /* sem servidor: continua valendo localmente */ }
}

async function loadProjectPrefsFromServer() {
  try {
    const [entriesRes, hiddenRes] = await Promise.all([
      fetch("/api/project_entries"), fetch("/api/hidden_paths"),
    ]);
    if (entriesRes.ok) {
      const data = await entriesRes.json();
      if (Array.isArray(data.entries)) state.projectEntries = data.entries;
    }
    if (hiddenRes.ok) {
      const data = await hiddenRes.json();
      if (Array.isArray(data.paths)) state.hiddenPaths = new Set(data.paths);
    }
    persist(PROJECT_ENTRIES_KEY, state.projectEntries);
    persist(HIDDEN_PATHS_KEY, [...state.hiddenPaths]);
    renderFilesPane();
  } catch { /* offline: segue com o cache local */ }
}
loadProjectPrefsFromServer();

function addProjectEntry(path, isDir) {
  if (state.projectEntries.some((e) => e.path === path)) {
    setStatus("Esse item ja esta nos arquivos do projeto.");
    return;
  }
  // Reaparecer depois de ter sido removido e o comportamento esperado de
  // "adicionar de novo", entao desfaz uma remocao anterior deste mesmo item.
  state.hiddenPaths.delete(path);
  state.projectEntries.push({ path, is_dir: isDir });
  syncProjectEntries();
  syncHiddenPaths();
  renderFilesPane();
  setStatus(`Adicionado aos arquivos do projeto: ${path}`);
}

function removeProjectEntry(path) {
  state.projectEntries = state.projectEntries.filter((e) => e.path !== path);
  syncProjectEntries();
  renderFilesPane();
  setStatus("Removido dos arquivos do projeto (o arquivo/pasta continua no disco).");
}

function hidePath(absPath) {
  state.hiddenPaths.add(absPath);
  syncHiddenPaths();
  renderFilesPane();
  setStatus("Removido dos arquivos do projeto (o arquivo/pasta continua no disco).");
}

// ---------------------------------------------------------------------------
// Arrastar um arquivo/pasta do sistema operacional para a barra lateral.
//
// Um navegador comum nunca entrega o caminho absoluto de um arquivo
// arrastado do Finder/Explorer (removido de todo navegador por seguranca ha
// anos) — so da pra ler o CONTEUDO dele, o que exigiria copiar o arquivo pro
// servidor, contrariando o resto do app (que sempre le em vez de copiar). O
// app desktop (Tauri) e diferente: a janela nativa recebe o caminho de
// verdade, entao o drag-and-drop funciona igual ao que foi pedido; no
// navegador comum, tentamos o caminho quando o proprio navegador o expoe (js
// so sabe depois de tentar) e, se nao vier, apontamos pro botao "Adicionar"
// — mesmo resultado final, um clique a mais.
// ---------------------------------------------------------------------------

const filesPaneEl = document.querySelector('.side-pane[data-pane="files"]');

if (filesPaneEl) {
  filesPaneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    filesPaneEl.classList.add("drag-over");
  });
  filesPaneEl.addEventListener("dragleave", (e) => {
    if (!filesPaneEl.contains(e.relatedTarget)) filesPaneEl.classList.remove("drag-over");
  });
  filesPaneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    filesPaneEl.classList.remove("drag-over");
    const paths = [...(e.dataTransfer?.files || [])].map((f) => f.path).filter(Boolean);
    if (!paths.length) {
      setStatus('Este navegador nao entrega o caminho real do arquivo arrastado. ' +
        'Use o botao "Adicionar" para escolher pelo servidor.', true);
      return;
    }
    for (const p of paths) addProjectEntry(p, undefined);
  });
}

/** No app desktop (Tauri) a janela nativa avisa o drag-and-drop com o
 *  caminho de verdade — ligado sob demanda em wireTauriDragDrop() (chamado
 *  la embaixo, so quando o runtime do Tauri esta presente). */
async function wireTauriDragDrop() {
  const tauri = window.__TAURI__;
  if (!tauri?.window) return;
  try {
    const win = tauri.window.getCurrentWindow();
    await win.onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      for (const p of event.payload.paths || []) addProjectEntry(p, undefined);
    });
  } catch { /* versao do Tauri sem esse evento: so o botao "Adicionar" mesmo */ }
}
wireTauriDragDrop();

// ---------------------------------------------------------------------------
// Abas de arquivo
// ---------------------------------------------------------------------------

function newTab(root, path) {
  return {
    id: "t" + Date.now() + Math.random().toString(36).slice(2, 6),
    // Cada aba lembra a propria raiz: com arquivos do projeto adicionados de
    // qualquer lugar do disco, nao existe mais uma unica raiz global valendo
    // pra tudo (so a pasta carregada em #rootInput tem esse papel hoje).
    root,
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
    activeFilterIds: new Set(),
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
    // Intervalo de tempo marcado a partir de duas linhas selecionadas.
    timeRange: null,
    // Blocos de stack trace abertos (por padrao ficam dobrados).
    openTraces: new Set(),
    // Segue o fim do arquivo enquanto ele cresce (coleta ao vivo) e mantem a
    // visao na ultima linha a cada atualizacao.
    follow: false,
    autoScroll: false,
    // Linha do tempo: fechada ate ser pedida.
    timelineOpen: false,
    // Janela de resultados: uma secao por busca feita.
    findOpen: false,
    findSections: [],
    findHeight: null,
    findScope: "current",
    colorCursor: 0,
    // Linhas escolhidas para exportar, e o estado da secao que as mostra.
    exportMarks: new Set(),
    markedCollapsed: false,
    markedExport: false,
    // Cores atribuidas a cada palavra em uso.
    filterTerms: [],
  };
}

function openFile(root, path, jumpLine) {
  let tab = state.tabs.find((t) => t.root === root && t.path === path);
  if (!tab) {
    tab = newTab(root, path);
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
  // Filtros ativos e associacoes sao por aba; ambos refletem a aba atual.
  renderFilterList();
  renderDeviceInfo();
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
    root: tab.root || state.root,
    file: tab.path,
    limit: effectiveLimit,
  });
  if (tail) params.set("tail", "true");
  else params.set("offset", offset);

  // Onde a rolagem estava, para nao jogar o usuario de volta ao topo a cada
  // atualizacao do modo "Seguir".
  const painelAtual = panelsEl.querySelector(`[data-panel-id="${tab.id}"] .log-wrap`);
  const rolagemAnterior = painelAtual ? painelAtual.scrollTop : null;
  // O mesmo vale para a janela de resultados: duplo clique num item dela so
  // deve mexer no log, a lista de resultados tem que continuar exatamente
  // onde estava (sem voltar pro topo a cada salto).
  const dockScrolls = [...panelsEl.querySelectorAll(`[data-panel-id="${tab.id}"] .fd-sections`)]
    .map((node) => [node.closest(".panel").dataset.paneIndex, node.scrollTop]);

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
  tab.hasMore = !!data.has_more;
  // `tab.limit` e a escolha do usuario no seletor e so muda por la; um salto
  // carrega uma janela maior sem baguncar o que o seletor mostra.
  if (!limit) tab.limit = effectiveLimit;
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
  for (const [paneIndex, top] of dockScrolls) {
    const sections = panelsEl.querySelector(
      `[data-panel-id="${tab.id}"][data-pane-index="${paneIndex}"] .fd-sections`);
    if (sections) sections.scrollTop = top;
  }
  renderHighlightList();
  // O nome do processo por PID e util em toda linha; busca uma vez por arquivo.
  loadProcessMap(tab);
  setStatus(`${tab.path.split("/").pop()}: linhas ${fmtNum(tab.offset + 1)}-` +
    `${fmtNum(tab.offset + tab.lines.length)} de ${fmtNum(tab.totalLines)}` +
    (tab.format ? ` | formato ${tab.format}` : ""));
  if (scrollToLine) {
    scrollLogToLine(tab, scrollToLine);
  } else if (tab.autoScroll) {
    scrollToEnd(tab);
  } else if (rolagemAnterior !== null && tail) {
    // Atualizacao do "Seguir" sem autoscroll: mantem onde o usuario estava.
    restoreScroll(tab, rolagemAnterior);
  }
}

/** Leva a tabela ate a ultima linha carregada. */
function scrollToEnd(tab) {
  requestAnimationFrame(() => {
    for (const panel of panelsEl.querySelectorAll(`[data-panel-id="${tab.id}"]`)) {
      const wrap = panel.querySelector(".log-wrap");
      if (!wrap) continue;
      suppressScrollHide = true;
      wrap.scrollTop = wrap.scrollHeight;
      updateVirtualSlice(wrap, tab);
      setTimeout(() => { suppressScrollHide = false; }, 0);
    }
  });
}

function restoreScroll(tab, top) {
  requestAnimationFrame(() => {
    for (const panel of panelsEl.querySelectorAll(`[data-panel-id="${tab.id}"]`)) {
      const wrap = panel.querySelector(".log-wrap");
      if (!wrap) continue;
      suppressScrollHide = true;
      wrap.scrollTop = top;
      updateVirtualSlice(wrap, tab);
      setTimeout(() => { suppressScrollHide = false; }, 0);
    }
  });
}

// Ao pular para uma linha (resultado de busca, evento da linha do tempo),
// carrega a maior janela possivel em volta dela, com mais folga abaixo do que
// acima: depois de achar o que procurava, quem le costuma seguir para frente
// no arquivo, entao vale mais espaco carregado nessa direcao antes de precisar
// recarregar. A linha em si fica centralizada na tela (ver scrollLogToLine).
const JUMP_SPAN = PAGE_SIZES[PAGE_SIZES.length - 1];
const JUMP_ABOVE_RATIO = 0.3;

async function jumpToLine(tab, lineNumber) {
  const offset = Math.max(0, lineNumber - 1 - Math.floor(JUMP_SPAN * JUMP_ABOVE_RATIO));
  tab.jumpLine = lineNumber;
  await loadFileContent(tab, { offset, limit: JUMP_SPAN, scrollToLine: lineNumber });
}

function scrollLogToLine(tab, lineNumber, paneIndex) {
  requestAnimationFrame(() => {
    const selector = paneIndex == null
      ? `[data-panel-id="${tab.id}"]`
      : `[data-panel-id="${tab.id}"][data-pane-index="${paneIndex}"]`;
    for (const panel of panelsEl.querySelectorAll(selector)) {
      const wrap = panel.querySelector(".log-wrap");
      if (!wrap) continue;
      // A busca do alvo tem que ficar dentro de `wrap`: o painel tambem
      // contem a janela de resultados, cujas linhas usam o mesmo atributo
      // data-line — procurando em `panel` inteiro um duplo clique podia achar
      // a propria linha clicada no dock e rolar o log por um valor sem
      // relacao nenhuma com a posicao real dela no arquivo.
      let target = wrap.querySelector(`tr[data-line="${lineNumber}"]`);
      // Na janela virtual a linha pode estar fora do slice desenhado; pula
      // direto para a posicao pelo indice (altura fixa de linha) e reconcilia
      // o slice antes de procurar de novo.
      if (!target && wrap.dataset.virtual === "1" && wrap._display) {
        const idx = wrap._display.findIndex((l) => l.n === lineNumber);
        if (idx >= 0) {
          suppressScrollHide = true;
          wrap.scrollTop = Math.max(0, idx * ROW_H - wrap.clientHeight / 2 + ROW_H / 2);
          updateVirtualSlice(wrap, tab);
          setTimeout(() => { suppressScrollHide = false; }, 0);
          target = wrap.querySelector(`tr[data-line="${lineNumber}"]`);
        }
      }
      if (!target) continue;
      // scrollIntoView rolaria a pagina inteira quando ha varios paineis;
      // ajustar o scrollTop do proprio container mantem os outros parados.
      suppressScrollHide = true;
      wrap.scrollTop = target.offsetTop - wrap.clientHeight / 2 + target.offsetHeight / 2;
      updateVirtualSlice(wrap, tab);
      setTimeout(() => { suppressScrollHide = false; }, 0);
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
  "app:": "pid", "text:": "msg", "msg:": "msg",
  "level:": "level", "lvl:": "level",
};

/** Traduz `pid:` e `app:` para os PIDs de verdade.
 *
 *  Numero e usado como esta (casamento exato). Texto e procurado no mapa
 *  PID -> processo: `pid:sbrows` acha o PID de com.sec.android.app.sbrowser.
 *  Sem isso o usuario precisaria descobrir o numero antes de poder buscar. */
function resolvePid(tab, value) {
  if (/^\d+$/.test(value)) return { pattern: `^${value}$`, pids: [value], byName: false };
  const map = (tab && tab.procMap) || {};
  const re = safeRegex(value, false);
  const pids = Object.keys(map).filter((pid) => re.test(map[pid]) || re.test(pid));
  if (!pids.length) return { pattern: null, pids: [], byName: true };
  return { pattern: `^(?:${pids.join("|")})$`, pids, byName: true };
}

/** Quebra uma expressao de palavras-chave na gramatica do app:
 *
 *    created for   -> a frase inteira, com o espaco (uma coisa so)
 *    created|for   -> uma ou outra
 *    created&for   -> as duas, em qualquer lugar da mesma linha
 *    a&b|c         -> `a` e mais (`b` ou `c`)
 *
 *  Espaco nunca separa termos: faz parte da palavra procurada. Padroes com
 *  barra invertida ficam intactos — ali o autor escreveu regex de proposito. */
function splitAndOr(value) {
  if (value.includes("\\") || !value.includes("&")) {
    return { groups: [value], words: value.split("|").map((w) => w.trim()).filter(Boolean) };
  }
  const groups = value.split("&").map((g) => g.trim()).filter(Boolean);
  return {
    groups,
    words: groups.flatMap((g) => g.split("|")).map((w) => w.trim()).filter(Boolean),
  };
}

/** Regex unica equivalente a expressao, para o casamento no cliente (uma linha
 *  por vez, entao o lookahead aqui e barato). No servidor os grupos de E vao
 *  separados, porque la a varredura e por bloco e o lookahead custaria caro. */
function termPattern(value) {
  const { groups } = splitAndOr(value);
  if (groups.length < 2) return value;
  return groups.map((g) => `(?=.*(?:${g}))`).join("") + ".*";
}

const FIELD_TOKEN = new RegExp(
  "^-?(?:" + Object.keys(FIELD_PREFIXES).map((p) => p.slice(0, -1)).join("|") + "):",
  "i");

/** Separa a consulta em campos (tag:, pid:, ...) e a expressao de
 *  palavras-chave.
 *
 *  Os campos sao tokens soltos, delimitados por espaco. Todo o resto volta
 *  junto, com os espacos preservados, porque `created for` e uma frase e nao
 *  dois termos. */
function parseQuery(query, tab) {
  const fields = [];
  const rest = [];
  for (const token of String(query || "").trim().split(/\s+/)) {
    if (!token) continue;
    if (!FIELD_TOKEN.test(token)) { rest.push(token); continue; }

    let raw = token;
    let negate = false;
    if (raw.startsWith("-")) { negate = true; raw = raw.slice(1); }
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

    if (field === "pid" || field === "tid") {
      const r = resolvePid(tab, value);
      fields.push({ field, negate, value, pattern: r.pattern, pids: r.pids,
                    unresolved: r.byName && !r.pids.length });
    } else {
      fields.push({ field, negate, value, pattern: value });
    }
  }
  return { fields, keywords: rest.join(" ") };
}

const MAX_ACTIVE_TERMS = 24;

/** Quebra uma busca nas palavras que a compoem, cada uma com sua cor.
 *  `start` continua a numeracao de cores de onde a secao anterior parou, para
 *  que buscas diferentes nao repitam cor. */
function termsOf(query, start = 0, tab = null) {
  const out = [];
  let color = start;
  const { fields, keywords } = parseQuery(query, tab);

  for (const f of fields) {
    if (f.negate) continue;   // termo negado nao pinta nada
    // Para pid:/app: pinta o numero resolvido, nao o texto digitado:
    // "sbrowser" nao aparece na linha, mas "10076" aparece.
    if (f.pids && f.pids.length) {
      for (const pid of f.pids.slice(0, 4)) {
        const proc = (tab && tab.procMap && tab.procMap[pid]) || null;
        out.push({
          // O numero sozinho nao diz nada: a etiqueta carrega o processo.
          pattern: `\\b${pid}\\b`,
          label: proc ? `${pid} ${shortProc(proc)}` : pid,
          color: color % HL_COLORS, field: f.field, note: proc,
        });
        color++;
      }
      continue;
    }
    out.push({ pattern: f.value, label: f.value, color: color % HL_COLORS, field: f.field });
    color++;
  }

  if (keywords) {
    // Uma cor por palavra, tanto nas alternativas de "a|b" quanto nos termos
    // exigidos de "a&b". Com parenteses ou colchetes o "|" pode ser interno ao
    // regex, entao a expressao fica com uma cor so.
    const parts = /[()[\]\\]/.test(keywords) ? [keywords] : splitAndOr(keywords).words;
    for (const part of parts) {
      out.push({ pattern: part, label: part, color: color % HL_COLORS });
      color++;
    }
  }
  return out;
}

/** Todas as palavras que devem aparecer coloridas no log: as de cada secao de
 *  resultado ainda aberta. Assim a cor no log e a mesma da etiqueta na janela
 *  de baixo. */
function activeTerms(tab) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (seen.has(t.pattern) || out.length >= MAX_ACTIVE_TERMS) return;
    seen.add(t.pattern);
    out.push(t);
  };
  for (const section of tab.findSections || []) section.terms.forEach(push);
  return out;
}


/** Linhas que a tabela de log mostra.
 *
 *  A caixa de busca NAO entra aqui de proposito: ela so pinta as palavras no
 *  log e alimenta as secoes da janela de resultados. O log continua sendo o
 *  log. Os niveis tambem nao filtram — marcam (ver `levelMarked`). O que ainda
 *  esconde linha e o que veio do menu de contexto (mostrar/esconder TAG e PID),
 *  o filtro salvo e o intervalo de tempo, todos acoes explicitas de esconder. */
function visibleLines(tab) {
  const range = tab.timeRange;
  const out = [];
  for (const line of tab.lines) {
    const c = line.c;

    if (range) {
      const v = timeValue(c && c.time);
      if (v === null || v < range.from || v > range.to) continue;
    }
    if (tab.showTags.size && (!c || !tab.showTags.has(c.tag))) continue;
    if (c && tab.hideTags.has(c.tag)) continue;
    if (tab.showPids.size && (!c || !tab.showPids.has(c.pid))) continue;
    if (c && tab.hidePids.has(c.pid)) continue;

    out.push(line);
  }
  return out;
}

/** Nivel ligado nos botoes V D I W E F: a linha ganha a cor daquele nivel, no
 *  log e nas secoes de resultado. Nao esconde nada. */
function levelMarked(tab, c) {
  return !!(c && c.level && tab.levels.has(c.level));
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

/** Linhas realmente desenhaveis: os blocos de trace fechados encolhem a
 *  um so header, entao a matematica de altura fixa da virtualizacao usa
 *  esta lista (nao `shown`) para casar com o que a tela mostra de fato. */
function displayRows(shown, tab) {
  const groups = groupTraces(shown);
  const display = [];
  for (const line of shown) {
    const g = groups.get(line.n);
    if (g && !g.head && !tab.openTraces.has(g.group.id)) continue;
    display.push(line);
  }
  return { display, groups };
}

/** HTML das linhas <tr> entre `start` e `end` de `display`, com uma linha
 *  espacadora acima e outra abaixo cobrindo a altura do que ficou de fora —
 *  e o que faz a barra de rolagem continuar representando o arquivo
 *  inteiro mesmo com so um pedaco no DOM. */
function renderVirtualRows(display, groups, tab, start, end, total, colCount) {
  const topH = start * ROW_H;
  const botH = (total - end) * ROW_H;
  let html = "";
  if (topH > 0) {
    html += `<tr class="vspacer" style="height:${topH}px"><td colspan="${colCount}" style="padding:0;border:0"></td></tr>`;
  }
  for (let i = start; i < end; i++) html += rowHtml(tab, display[i], groups);
  if (botH > 0) {
    html += `<tr class="vspacer" style="height:${botH}px"><td colspan="${colCount}" style="padding:0;border:0"></td></tr>`;
  }
  return html;
}

/** Slice [start, end) de `display` que cobre a area visivel de `wrap`, com
 *  uma folga de VIRTUALIZE_BUFFER linhas de cada lado para a rolagem nao
 *  mostrar espaco em branco antes do proximo redesenho. */
function virtualRange(total, scrollTop, viewportH) {
  const visibleCount = Math.ceil(viewportH / ROW_H) + VIRTUALIZE_BUFFER * 2;
  let start = Math.max(0, Math.floor(scrollTop / ROW_H) - VIRTUALIZE_BUFFER);
  start = Math.min(start, Math.max(0, total - visibleCount));
  const end = Math.min(total, start + visibleCount);
  return { start, end };
}

/** Reconcilia o <tbody> virtualizado com a posicao de rolagem atual.
 *  So reescreve o HTML quando o slice necessario muda — senao cada pixel
 *  rolado dispararia uma escrita no DOM. */
function updateVirtualSlice(wrap, tab) {
  if (!wrap || wrap.dataset.virtual !== "1" || !wrap._display) return;
  const tbody = wrap.querySelector("tbody");
  if (!tbody) return;
  const total = wrap._display.length;
  const viewportH = wrap.clientHeight || 700;
  const { start, end } = virtualRange(total, wrap.scrollTop, viewportH);
  if (start === wrap._vStart && end === wrap._vEnd) return;
  wrap._vStart = start;
  wrap._vEnd = end;
  tbody.innerHTML = renderVirtualRows(wrap._display, wrap._groups, tab, start, end, total, wrap._colCount);
}

function isHighlighted(tab, line) {
  const c = line.c;
  if (!c) return false;
  return (c.tag && tab.highlightTags.has(c.tag)) || (c.pid && tab.highlightPids.has(c.pid));
}

// ---------------------------------------------------------------------------
// Colunas: mesma definicao para a tabela de log e para a de resultados, com
// largura ajustavel arrastando a borda do cabecalho.
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: "n", cls: "c-n", label: "Linha", sigla: null },
  { key: "file", cls: "c-file", label: "Arquivo", sigla: null },
  { key: "lvl", cls: "c-lvl", label: "L.", sigla: "L." },
  { key: "time", cls: "c-time", label: "Hora", sigla: "Hora" },
  { key: "pid", cls: "c-pid", label: "PID", sigla: "PID" },
  { key: "tid", cls: "c-tid", label: "TID", sigla: "TID" },
  { key: "tag", cls: "c-tag", label: "Tag", sigla: "Tag" },
];

const COL_WIDTHS_KEY = "logviewer.colWidths";
const DEFAULT_COL_WIDTHS = { n: 74, file: 150, lvl: 20, time: 132, pid: 108, tid: 52, tag: 150 };
state.colWidths = { ...DEFAULT_COL_WIDTHS, ...store(COL_WIDTHS_KEY, {}) };

/** As larguras viram variaveis CSS: mudar uma redesenha as duas tabelas sem
 *  precisar refazer o HTML. */
function applyColWidths() {
  for (const [key, px] of Object.entries(state.colWidths)) {
    document.documentElement.style.setProperty(`--w-${key}`, px + "px");
  }
}
applyColWidths();

/** Conteudo de uma celula de largura fixa. O span com largura propria e o que
 *  segura a coluna: em tabela de layout automatico, largura no <td> e so uma
 *  sugestao e o conteudo manda. */
function cell(colKey, html, attrs = "") {
  return `<span class="cell cell-${colKey}"${attrs}>${html}</span>`;
}

function tableHeadHtml(withFile) {
  const cols = COLUMNS.filter((c) => c.key !== "file" || withFile);
  // O colgroup e o que faz cabecalho e corpo concordarem sobre a largura de
  // cada coluna; sem ele o navegador redistribui a sobra por conta propria.
  const colgroup = "<colgroup>" +
    cols.map((c) => `<col class="col-${c.key}">`).join("") +
    "<col></colgroup>";
  const th = cols.map((c) => {
    const e = c.sigla && glossaryEntry(c.sigla);
    const title = e ? ` title="${escapeHtml(`${e.sigla} - ${e.nome}: ${e.desc}`)}"` : "";
    return `<th class="${c.cls}"${title}><span class="cell cell-${c.key}">${c.label}</span>` +
      `<span class="col-resize" data-col="${c.key}" title="Arraste para redimensionar"></span></th>`;
  }).join("");
  return colgroup + `<thead><tr>${th}<th>Texto</th></tr></thead>`;
}

function rowHtml(tab, line, groups) {
  const c = line.c;
  const classes = ["lvl-" + (c && c.level ? c.level : "none")];
  if (tab.selected.has(line.n)) classes.push("selected");
  if (isHighlighted(tab, line)) classes.push("highlighted");
  if (tab.bookmarks.has(line.n)) classes.push("bookmarked");
  // Os botoes de nivel pintam a linha em vez de esconder as outras.
  if (levelMarked(tab, c)) classes.push("lvl-mark", "mk-" + c.level);
  if (tab.exportMarks.has(line.n)) classes.push("is-marked");

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
      `<td class="c-n">${cell("n", String(line.n))}</td>` +
      `<td class="c-lvl">${cell("lvl", "")}</td>` +
      `<td class="c-time">${cell("time", "")}</td>` +
      `<td class="c-pid">${cell("pid", "")}</td>` +
      `<td class="c-tid">${cell("tid", "")}</td>` +
      `<td class="c-tag">${cell("tag", "")}</td>` +
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
    `<td class="c-n">${cell("n", String(line.n))}</td>` +
    `<td class="c-lvl">${cell("lvl", escapeHtml(c.level || ""), levelTitle(c.level))}</td>` +
    `<td class="c-time">${cell("time", decorateText(c.time || "", tab))}</td>` +
    `<td class="c-pid">${cell("pid", pidCell, pidTitle)}</td>` +
    `<td class="c-tid">${cell("tid", decorateText(c.tid || "", tab))}</td>` +
    `<td class="c-tag">${cell("tag", decorateText(c.tag || "", tab), tagInfo)}</td>` +
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
  tab.filterTerms = activeTerms(tab);
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
      title="Enter busca no ARQUIVO INTEIRO e abre a janela de resultados.&#10;&#10;created for   = a frase inteira, com o espaco&#10;created|for   = uma ou outra&#10;created&amp;for   = as duas na mesma linha&#10;&#10;tag:X pid:Y   = filtra o campo (na busca comum o campo casa por conter)&#10;                e as palavras vao no texto da mensagem&#10;Prefixos: tag: pid: tid: uid: app: level:&#10;Cada palavra ganha sua cor. Aceita regex.">
    <select data-act="scope" title="Onde procurar">
      <option value="current"${(tab.findScope || "current") === "current" ? " selected" : ""}>neste arquivo</option>
      <option value="open"${tab.findScope === "open" ? " selected" : ""}>arquivos abertos</option>
      <option value="folder"${tab.findScope === "folder" ? " selected" : ""}>pasta inteira</option>
    </select>
    <button data-act="filesearch" class="primary" title="Buscar (Enter)">Buscar</button>
    <div class="level-toggles">
      ${LEVELS.map((l) => `<button class="level-toggle${tab.levels.has(l) ? " on" : ""}" data-level="${l}" title="Marcar as linhas de nivel ${l} com a cor do nivel">${l}</button>`).join("")}
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
    <label class="toolbar-check" title="Recarregar o fim do arquivo automaticamente — util enquanto uma coleta ao vivo esta gravando">
      <input type="checkbox" data-act="follow"${tab.follow ? " checked" : ""}> Seguir
    </label>
    <label class="toolbar-check" title="Manter a visao na ultima linha a cada atualizacao">
      <input type="checkbox" data-act="autoscroll"${tab.autoScroll ? " checked" : ""}> Rolar p/ o fim
    </label>
    <label class="toolbar-check" title="Quebrar linhas longas no espaco horizontal disponivel, em vez de rolar na horizontal">
      <input type="checkbox" data-act="wrap"${tab.wrapText ? " checked" : ""}> Quebrar linha
    </label>
    <button data-act="export" title="Exportar as linhas visiveis (ou a selecao) para arquivo">Exportar</button>
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
    ` | ${fmtNum(tab.offset + 1)}-${fmtNum(tab.offset + tab.lines.length)} de ${fmtNum(tab.totalLines)}` +
    (tab.size != null ? ` | ${fmtSize(tab.size)}` : "") +
    (tab.searchHits.length ? ` | ${tab.searchHits.length} ocorrencia(s)` : "");

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
    const { display, groups } = displayRows(shown, tab);
    const virtual = !tab.wrapText && display.length > VIRTUALIZE_THRESHOLD;
    const colCount = COLUMNS.filter((c) => c.key !== "file").length + 1;
    let tbodyHtml;
    if (virtual) {
      // Altura real do painel so existe depois de anexado ao DOM; ate la um
      // palpite generoso evita renderizar de menos no primeiro paint (o
      // ResizeObserver em wirePanel corrige assim que o layout roda).
      const { start, end } = virtualRange(display.length, 0, 900);
      wrap._display = display;
      wrap._groups = groups;
      wrap._colCount = colCount;
      wrap._vStart = start;
      wrap._vEnd = end;
      tbodyHtml = renderVirtualRows(display, groups, tab, start, end, display.length, colCount);
    } else {
      tbodyHtml = display.map((l) => rowHtml(tab, l, groups)).join("");
    }
    wrap.dataset.virtual = virtual ? "1" : "";
    wrap.innerHTML =
      `<table class="log-table${tab.wrapText ? " wrap" : ""}">` +
      tableHeadHtml(false) + "<tbody>" + tbodyHtml + "</tbody></table>";
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
// ---------------------------------------------------------------------------
// Busca no arquivo inteiro, com os resultados numa janela propria
// ---------------------------------------------------------------------------

const FIND_PAGE = 1000;
const MAX_SECTIONS = 12;

// ---------------------------------------------------------------------------
// Busca: cada pesquisa vira uma secao na janela de resultados
// ---------------------------------------------------------------------------

/** Monta os parametros de /api/filtered a partir de uma consulta da caixa de
 *  busca.
 *
 *  Primeiro os campos (tag:, pid:, ...), depois as palavras-chave. Na busca
 *  comum o campo casa por *conter* o valor — e uma consulta rapida, e digitar
 *  tag:Telephony para varrer a familia toda e util. No filtro salvo o valor e
 *  exato, porque ali o criterio foi escrito para ficar.
 *
 *  Havendo campo, as palavras vao para `text` (so a mensagem); sem campo
 *  nenhum, viram `raw` e valem para a linha inteira — unico jeito de alcancar
 *  as linhas que nem sao logcat. */
function fileSearchParams(tab, query) {
  const params = new URLSearchParams({ root: tab.root || state.root, file: tab.path });
  const { fields, keywords } = parseQuery(query, tab);
  const byField = { tag: [], msg: [], pid: [], tid: [], uid: [], level: [] };
  let negated = 0;
  let unresolved = null;

  for (const f of fields) {
    if (f.negate) { negated++; continue; }
    if (f.unresolved) { unresolved = f.value; continue; }
    if (byField[f.field]) byField[f.field].push(f.pattern);
  }
  if (byField.tag.length) params.set("tag", byField.tag.join("|"));
  if (byField.uid.length) params.set("uid", byField.uid.join("|"));
  if (byField.pid.length) params.set("pid", byField.pid.join("|"));
  if (byField.tid.length) params.set("tid", byField.tid.join("|"));
  if (byField.level.length) params.set("levels", byField.level.join(","));
  // text: escrito a mao continua valendo como palavra-chave da mensagem.
  const words = [...byField.msg];
  if (keywords) words.push(...splitAndOr(keywords).groups);

  const hasField = [...params.keys()].length > 2;
  // Cada entrada e uma exigencia: a linha precisa casar com todas. O servidor
  // usa a mais longa para triar e confere as outras so nas candidatas.
  for (const w of words) params.append(hasField ? "text" : "raw", w);

  return {
    params,
    hasCriteria: [...params.keys()].length > 2,
    negated,
    unresolved,
  };
}

/** Leva o foco para a caixa de busca do painel ativo (Ctrl+F / Ctrl+Shift+F). */
function focusSearchBox(scope) {
  const tab = activeTab();
  if (!tab) return;
  if (scope) tab.findScope = scope;
  const panel = panelsEl.querySelector(`[data-panel-id="${tab.id}"]`);
  const input = panel && panel.querySelector(".live-filter");
  if (!input) return;
  if (scope) {
    const sel = panel.querySelector('[data-act="scope"]');
    if (sel) sel.value = scope;
  }
  input.focus();
  input.select();
}

/** Busca com escopo em varios arquivos, reaproveitando /api/search. */
async function searchAcrossFiles(tab, query, scope) {
  const root = tab.root || state.root;
  const params = new URLSearchParams({ root, pattern: query });
  if (scope === "open") {
    params.set("scope", "open");
    // So as abas da MESMA raiz: o backend resolve caminho relativo a uma
    // raiz so, e com arquivos do projeto de qualquer lugar do disco as abas
    // podem pertencer a raizes diferentes.
    params.set("open_files", state.tabs
      .filter((t) => (t.root || state.root) === root)
      .map((t) => t.path).join(","));
  } else {
    params.set("scope", "folder");
    params.set("max_files", 300);
  }
  params.set("flags", "i");
  params.set("max_results", 2000);
  params.set("total_max_results", 5000);

  const res = await fetch(`/api/search?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro na busca.");

  // Achata os resultados por arquivo numa lista unica, do mesmo formato da
  // busca de um arquivo so — assim a secao se desenha igual nos dois casos.
  const lines = [], numbers = [], columns = [], files = [];
  for (const fileResult of data.results) {
    for (const m of fileResult.matches || []) {
      lines.push(m.line);
      numbers.push(m.line_number);
      files.push(fileResult.path);
      columns.push(m.level ? { level: m.level, tag: m.tag, pid: m.pid, tid: m.tid } : null);
    }
  }
  return {
    lines, numbers, columns, files,
    matched: data.total_matches,
    offset: 0,
    hasMore: false,
    truncated: data.results.some((r) => r.truncated) || data.files_truncated,
    filesSearched: data.files_searched,
  };
}

/** Roda a busca e guarda o resultado como mais uma secao da janela de baixo.
 *  Buscar de novo o mesmo termo atualiza a secao existente em vez de duplicar. */
async function runSearch(tab, query, { sectionId = null, offset = 0, groups = null,
                                        filter = null, id = null, savedNames = null,
                                        colorSource = null } = {}) {
  query = (query ?? tab.liveFilter).trim();
  if (!query) {
    setStatus("Digite algo na caixa de busca.", true);
    return;
  }
  // Um filtro com nos sempre vale no arquivo atual: os nos falam de TAG/PID
  // deste log.
  const scope = groups ? "current" : (tab.findScope || "current");

  let section = sectionId
    ? tab.findSections.find((x) => x.id === sectionId)
    : tab.findSections.find((x) => x.query === query && x.scope === scope);

  if (!section) {
    // As palavras coloridas de um filtro sao as palavras-chave dos seus nos.
    const source = colorSource ?? (filter
      ? filterNodes(filter).map((n) => n.text).filter(Boolean).join(" ")
      : query);
    section = {
      id: id || ("s" + Date.now() + Math.random().toString(36).slice(2, 5)),
      query,
      scope,
      groups,
      savedNames,
      terms: termsOf(source, tab.colorCursor || 0, tab),
      source: tab.path.split("/").pop(),
      results: null,
      collapsed: false,
      exportChecked: false,
      loading: true,
      error: null,
    };
    tab.colorCursor = ((tab.colorCursor || 0) + section.terms.length) % HL_COLORS;
    tab.findSections.unshift(section);
    if (tab.findSections.length > MAX_SECTIONS) tab.findSections.length = MAX_SECTIONS;
  } else {
    section.loading = true;
    section.error = null;
    if (groups) section.groups = groups;
  }

  // Uma busca nova recolhe as anteriores e fica aberta: com varias secoes
  // abertas a lista vira uma parede e some o que se acabou de procurar.
  for (const other of tab.findSections) other.collapsed = other !== section;
  section.collapsed = false;

  saveToHistory(query);
  tab.findOpen = true;
  refreshPanel(tab);

  try {
    if (scope === "current") {
      let params, hasCriteria = true, unresolved = null;
      if (section.groups) {
        params = new URLSearchParams({ root: tab.root || state.root, file: tab.path });
        params.set("groups", JSON.stringify(section.groups));
      } else {
        ({ params, hasCriteria, unresolved } = fileSearchParams(tab, query));
      }
      if (unresolved) {
        section.error = `Nenhum processo casa com "${unresolved}". ` +
          (tab.procMap ? "Veja os nomes na coluna PID." : "O mapa de processos ainda esta carregando.");
        return;
      }
      if (!hasCriteria) {
        section.error = "Consulta vazia.";
        return;
      }
      params.set("offset", offset);
      params.set("limit", FIND_PAGE);
      const res = await fetch(`/api/filtered?${params}`);
      const data = await res.json();
      if (!res.ok) {
        section.error = data.error || "Erro na busca.";
        section.results = null;
        return;
      }
      section.results = {
        lines: data.lines,
        numbers: data.line_numbers,
        columns: data.columns || [],
        files: null,
        matched: data.matched,
        offset: data.offset,
        hasMore: data.has_more,
        truncated: data.truncated,
      };
    } else {
      section.results = await searchAcrossFiles(tab, query, scope);
    }
    section.error = null;
    setStatus(`"${query}": ${fmtNum(section.results.matched)} linha(s).`);
  } catch (err) {
    section.error = "Falha na requisicao: " + err.message;
    section.results = null;
  } finally {
    section.loading = false;
    refreshPanel(tab);
  }
}

/** Linhas que o usuario marcou para exportar, mais os bookmarks. */
function markedRows(tab) {
  const rows = [];
  const byNumber = new Map(tab.lines.map((l) => [l.n, l]));
  const numbers = new Set([...tab.exportMarks, ...tab.bookmarks]);
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const line = byNumber.get(n);
    rows.push({
      n,
      text: line ? line.text : null,   // null = linha fora da pagina carregada
      c: line ? line.c : null,
      marked: tab.exportMarks.has(n),
      bookmarked: tab.bookmarks.has(n),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Janela de resultados (fica no fluxo do painel, dividindo espaco com o log)
// ---------------------------------------------------------------------------

/** Distingue um clique de um arrasto para selecionar texto.
 *
 *  Usado na tabela de log, onde o clique simples seleciona a linha: sem isso,
 *  arrastar para copiar um trecho trocaria a linha selecionada no meio da
 *  selecao. Guarda onde o botao desceu e so trata como clique se o ponteiro
 *  praticamente nao andou. */
function clickNotDrag(container, handler) {
  let down = null;
  container.addEventListener("mousedown", (e) => { down = [e.clientX, e.clientY]; });
  container.addEventListener("click", (e) => {
    const moved = down && (Math.abs(e.clientX - down[0]) > 4 || Math.abs(e.clientY - down[1]) > 4);
    down = null;
    // Arrastar (selecionar texto) ou dar duplo clique (selecionar palavra) nao
    // navega. Um clique parado navega, mesmo que exista selecao anterior na
    // tela — checar a selecao aqui travaria o clique seguinte.
    if (moved || e.detail > 1) return;
    handler(e);
  });
}

// Rotulo do campo mostrado na etiqueta, para nao restar duvida se aquela
// palavra foi procurada na TAG, no PID ou no texto da mensagem.
const FIELD_LABEL = {
  tag: "TAG", pid: "PID", tid: "TID", uid: "UID", msg: "TEXTO", level: "NIVEL",
};

function chipsHtml(section) {
  const chips = [];
  if (section.savedNames) {
    chips.push('<span class="fd-term fd-term-flag">FILTROS SALVOS</span>');
    for (const name of section.savedNames) {
      chips.push(`<span class="fd-term fd-term-plain">${escapeHtml(name)}</span>`);
    }
  }
  for (const t of section.terms) {
    const flag = t.field && FIELD_LABEL[t.field]
      ? `<b class="fd-fieldflag">${FIELD_LABEL[t.field]}</b>`
      : "";
    const title = t.note ? ` title="${escapeHtml(t.note)}"` : "";
    chips.push(`<span class="fd-term hl-${t.color}"${title}>` +
      `${flag}${escapeHtml(t.label ?? t.pattern)}</span>`);
  }
  return chips.join("");
}

/** Uma linha de resultado, nas mesmas colunas da tabela de log. */
function resultRowHtml(tab, row, withFile) {
  const { n, c, text, file } = row;
  const classes = ["fd-row", "lvl-" + (c && c.level ? c.level : "none")];
  if (levelMarked(tab, c)) classes.push("lvl-mark", "mk-" + c.level);
  if (row.marked) classes.push("is-marked");
  if (row.active) classes.push("on");

  const fileCell = withFile
    ? `<td class="c-file">${cell("file", escapeHtml((file || "").split("/").pop()),
        file ? ` title="${escapeHtml(file)}"` : "")}</td>`
    : "";

  if (!c) {
    // Linha fora do formato logcat: o texto cru ocupa a coluna de conteudo.
    return `<tr class="${classes.join(" ")}" data-line="${n}"` +
      `${file ? ` data-file="${escapeHtml(file)}"` : ""}>` +
      `<td class="c-n">${cell("n", fmtNum(n))}</td>${fileCell}` +
      `<td class="c-lvl">${cell("lvl", "")}</td>` +
      `<td class="c-time">${cell("time", "")}</td>` +
      `<td class="c-pid">${cell("pid", "")}</td>` +
      `<td class="c-tid">${cell("tid", "")}</td>` +
      `<td class="c-tag">${cell("tag", "")}</td>` +
      `<td class="c-text c-raw">${row.body ?? decorateText(text || "", tab)}</td></tr>`;
  }

  const proc = processName(tab, c.pid);
  const pidCell = decorateText(c.pid || "", tab) +
    (proc ? ` <span class="proc-name">${escapeHtml(shortProc(proc))}</span>` : "");
  return `<tr class="${classes.join(" ")}" data-line="${n}"` +
    `${file ? ` data-file="${escapeHtml(file)}"` : ""}>` +
    `<td class="c-n">${cell("n", fmtNum(n))}</td>${fileCell}` +
    `<td class="c-lvl">${cell("lvl", escapeHtml(c.level || ""), levelTitle(c.level))}</td>` +
    `<td class="c-time">${cell("time", decorateText(c.time || "", tab))}</td>` +
    `<td class="c-pid">${cell("pid", pidCell, proc ? ` title="PID ${c.pid} - ${escapeHtml(proc)}"` : "")}</td>` +
    `<td class="c-tid">${cell("tid", decorateText(c.tid || "", tab))}</td>` +
    `<td class="c-tag">${cell("tag", decorateText(c.tag || "", tab), glossaryTagTitle(c.tag))}</td>` +
    `<td class="c-text">${row.body ?? decorateText(c.msg ?? text ?? "", tab)}</td></tr>`;
}

/** Envolve as linhas numa tabela com cabecalho, igual a do log. */
function resultTableHtml(tab, rows, withFile, wrapText) {
  return `<table class="log-table fd-table${wrapText ? " wrap" : ""}">` +
    tableHeadHtml(withFile) + "<tbody>" +
    rows.map((row) => resultRowHtml(tab, row, withFile)).join("") +
    "</tbody></table>";
}

function buildSection(tab, section) {
  const box = document.createElement("section");
  box.className = "fd-section" + (section.collapsed ? " collapsed" : "");
  box.dataset.sectionId = section.id;

  const r = section.results;
  const count = section.loading
    ? "buscando..."
    : section.error
      ? section.error
      : r
        ? `${fmtNum(r.matched)}${r.truncated ? "+" : ""} linha(s)` +
          (r.files ? ` em ${r.filesSearched} arquivo(s)` : "")
        : "";

  // De onde vieram os resultados. Com dois aparelhos capturados ou varios
  // arquivos abertos, a secao precisa dizer a que log ela se refere.
  const origem = r && r.files
    ? `${r.filesSearched} arquivo(s)`
    : (section.source || tab.path.split("/").pop());
  const aparelho = state.rootDevice && state.rootDevice.modelo
    ? ` \u00b7 ${state.rootDevice.modelo.value}` : "";

  // Paginacao: quantas linhas desta pagina, de quantas encontradas.
  const pagina = r && !r.files && r.matched > r.lines.length
    ? `${fmtNum(r.offset + 1)}-${fmtNum(r.offset + r.lines.length)} de ${fmtNum(r.matched)}`
    : "";

  box.innerHTML =
    `<header class="fd-sec-head">` +
      `<button class="fd-toggle" title="Colapsar/expandir">${section.collapsed ? "▸" : "▾"}</button>` +
      `<span class="fd-chips">${chipsHtml(section)}</span>` +
      `<span class="fd-origin" title="${escapeHtml(origem + aparelho)}">` +
        `${escapeHtml(origem)}${escapeHtml(aparelho)}</span>` +
      `<span class="fd-count${section.error ? " fd-err" : ""}">${escapeHtml(count)}</span>` +
      `${pagina ? `<span class="fd-pagina">${pagina}</span>` : ""}` +
      `<span class="fd-spacer"></span>` +
      `<label class="fd-check" title="Marcar esta secao para exportar">` +
        `<input type="checkbox" class="fd-export"${section.exportChecked ? " checked" : ""}> exportar</label>` +
      `<button class="fd-page" data-dir="-1" ${!r || r.files || r.offset === 0 ? "disabled" : ""} title="Pagina anterior">&#8592;</button>` +
      `<button class="fd-page" data-dir="1" ${!r || r.files || !r.hasMore ? "disabled" : ""} title="Proxima pagina">&#8594;</button>` +
      `<button class="fd-close icon-btn" title="Remover esta busca">&times;</button>` +
    `</header>` +
    `<div class="fd-list"></div>`;

  const list = box.querySelector(".fd-list");
  if (r && r.lines.length) {
    const withFile = !!r.files;
    const rows = r.lines.map((text, i) => ({
      n: r.numbers[i], c: r.columns[i], text,
      file: withFile ? r.files[i] : null,
      marked: !withFile && tab.exportMarks.has(r.numbers[i]),
      active: section.activeLine === r.numbers[i],
    }));
    list.innerHTML = resultTableHtml(tab, rows, withFile, tab.wrapText);
  } else if (r) {
    list.innerHTML = '<div class="fd-empty">Nenhuma linha encontrada.</div>';
  }

  box.querySelector(".fd-toggle").addEventListener("click", () => {
    section.collapsed = !section.collapsed;
    refreshPanel(tab);
  });
  box.querySelector(".fd-close").addEventListener("click", () => {
    if (section.id === SAVED_SECTION_ID) {
      // Fechar a secao dos filtros salvos e o mesmo que desligar todos.
      tab.activeFilterIds.clear();
      syncSavedFilters(tab);
      return;
    }
    tab.findSections = tab.findSections.filter((x) => x.id !== section.id);
    refreshPanel(tab);
  });
  box.querySelector(".fd-export").addEventListener("change", (e) => {
    section.exportChecked = e.target.checked;
  });
  box.querySelectorAll(".fd-page").forEach((btn) => {
    btn.addEventListener("click", () => {
      const delta = Number(btn.dataset.dir) * FIND_PAGE;
      runSearch(tab, section.query, {
        sectionId: section.id,
        offset: Math.max(0, section.results.offset + delta),
      });
    });
  });
  // Duplo clique navega. O clique simples nao faz nada de proposito: assim da
  // para selecionar trechos de uma ou varias linhas aqui sem que a janela do
  // log fique pulando a cada toque.
  wireColumnResize(box);
  list.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".fd-row");
    if (!row) return;
    section.activeLine = Number(row.dataset.line);
    openAtLine(tab, section.activeLine, row.dataset.file);
  });
  return box;
}

/** Secao fixa com o que foi marcado para exportar e com os bookmarks. */
function buildMarkedSection(tab) {
  const rows = markedRows(tab);
  const box = document.createElement("section");
  box.className = "fd-section fd-marked" + (tab.markedCollapsed ? " collapsed" : "");

  box.innerHTML =
    `<header class="fd-sec-head">` +
      `<button class="fd-toggle" title="Colapsar/expandir">${tab.markedCollapsed ? "▸" : "▾"}</button>` +
      `<span class="fd-chips"><span class="fd-term fd-term-plain">✓ marcadas para exportar</span>` +
      `<span class="fd-term fd-term-plain">⚑ bookmarks</span></span>` +
      `<span class="fd-count">${fmtNum(rows.length)} linha(s)</span>` +
      `<span class="fd-spacer"></span>` +
      `<label class="fd-check" title="Marcar esta secao para exportar">` +
        `<input type="checkbox" class="fd-export"${tab.markedExport ? " checked" : ""}> exportar</label>` +
      `<button class="fd-clear" title="Limpar as marcacoes">Limpar</button>` +
    `</header>` +
    `<div class="fd-list"></div>`;

  const list = box.querySelector(".fd-list");
  if (rows.length) {
    const shaped = rows.map((row) => ({
      n: row.n, c: row.c, text: row.text, file: null,
      marked: row.marked,
      active: tab.markedActiveLine === row.n,
      body: (row.marked ? '<span class="fd-flag">&#10003;</span>' : "") +
        (row.bookmarked ? '<span class="fd-flag">&#9873;</span>' : "") +
        (row.text === null
          ? '<span class="fd-out">(fora da pagina carregada — duplo clique para ir ate ela)</span>'
          : decorateText(row.c ? (row.c.msg ?? row.text) : row.text, tab)),
    }));
    list.innerHTML = resultTableHtml(tab, shaped, false, tab.wrapText);
  } else {
    list.innerHTML = '<div class="fd-empty">Nenhuma linha marcada. Use o menu de ' +
      'contexto do log: "Marcar para exportar" ou "Marcar/desmarcar (bookmark)".</div>';
  }

  box.querySelector(".fd-toggle").addEventListener("click", () => {
    tab.markedCollapsed = !tab.markedCollapsed;
    refreshPanel(tab);
  });
  box.querySelector(".fd-export").addEventListener("change", (e) => {
    tab.markedExport = e.target.checked;
  });
  box.querySelector(".fd-clear").addEventListener("click", () => {
    if (!rows.length) return;
    if (!window.confirm("Limpar as linhas marcadas e os bookmarks desta aba?")) return;
    tab.exportMarks.clear();
    tab.bookmarks.clear();
    refreshPanel(tab);
  });
  wireColumnResize(box);
  list.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".fd-row");
    if (!row) return;
    tab.markedActiveLine = Number(row.dataset.line);
    openAtLine(tab, tab.markedActiveLine, null);
  });
  return box;
}

function buildFindDock(tab) {
  if (!tab.findOpen) return null;
  const dock = document.createElement("div");
  dock.className = "find-dock";

  dock.innerHTML =
    `<div class="fd-resize" title="Arraste para redimensionar"></div>` +
    `<div class="fd-head">` +
      `<strong>Resultados</strong>` +
      `<span class="fd-hint">duplo clique numa linha vai ate ela no log</span>` +
      `<span class="fd-spacer"></span>` +
      `<button data-fd="export" title="Exportar as secoes marcadas com 'exportar'">Exportar marcadas</button>` +
      `<button data-fd="clear" title="Remover todas as buscas">Limpar buscas</button>` +
      `<button data-fd="close" class="icon-btn" title="Fechar a janela de resultados">&times;</button>` +
    `</div>` +
    `<div class="fd-sections"></div>`;

  const holder = dock.querySelector(".fd-sections");
  holder.appendChild(buildMarkedSection(tab));
  for (const section of tab.findSections) holder.appendChild(buildSection(tab, section));

  dock.querySelector('[data-fd="close"]').addEventListener("click", () => {
    tab.findOpen = false;
    refreshPanel(tab);
  });
  dock.querySelector('[data-fd="clear"]').addEventListener("click", () => {
    tab.findSections = [];
    tab.activeFilterIds.clear();
    renderFilterList();
    refreshPanel(tab);
  });
  dock.querySelector('[data-fd="export"]').addEventListener("click", () => exportChecked(tab));

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

function openAtLine(tab, line, file) {
  if (file && file !== tab.path) {
    // A lista de resultados viaja junto para continuar clicando nos proximos.
    const carry = {
      findOpen: true, findSections: tab.findSections, findScope: tab.findScope,
      findHeight: tab.findHeight, liveFilter: tab.liveFilter,
      colorCursor: tab.colorCursor,
    };
    openFile(tab.root, file, line);
    const opened = state.tabs.find((t) => t.root === tab.root && t.path === file);
    if (opened) {
      Object.assign(opened, carry);
      opened.filterTerms = activeTerms(opened);
    }
    return;
  }
  jumpToLine(tab, line);
}

/** Exporta as secoes marcadas com "exportar". */
async function exportChecked(tab) {
  const parts = [];
  if (tab.markedExport) {
    const rows = markedRows(tab);
    if (rows.length) {
      parts.push(`===== linhas marcadas (${rows.length}) =====`);
      for (const row of rows) {
        parts.push(`${row.n}: ${row.text ?? "(fora da pagina carregada)"}`);
      }
    }
  }
  for (const section of tab.findSections) {
    if (!section.exportChecked || !section.results) continue;
    // Exporta tudo o que a busca encontrou, nao so a pagina exibida.
    let lines = section.results.lines;
    let numbers = section.results.numbers;
    if (section.scope === "current" && section.results.matched > lines.length) {
      let params;
      if (section.groups) {
        params = new URLSearchParams({ root: tab.root || state.root, file: tab.path });
        params.set("groups", JSON.stringify(section.groups));
      } else {
        ({ params } = fileSearchParams(tab, section.query));
      }
      params.set("offset", 0);
      params.set("limit", 20000);
      try {
        const res = await fetch(`/api/filtered?${params}`);
        const data = await res.json();
        if (res.ok) { lines = data.lines; numbers = data.line_numbers; }
      } catch { /* mantem a pagina carregada */ }
    }
    parts.push(`===== ${section.query} (${lines.length} de ${fmtNum(section.results.matched)}) =====`);
    lines.forEach((l, i) => parts.push(`${numbers[i]}: ${l}`));
  }

  if (!parts.length) {
    setStatus('Marque "exportar" em ao menos uma secao.', true);
    return;
  }
  const base = tab.path.split("/").pop().replace(/\.[^.]+$/, "");
  downloadText(`${base}-selecao.txt`, parts.join("\n") + "\n");
  setStatus("Exportado.");
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
  // Digitar apenas guarda o texto. Nada na tela muda ate a busca ser
  // disparada: o log nao se mexe, e as cores so aparecem depois que a consulta
  // vira uma secao de resultados.
  liveInput.addEventListener("input", () => { tab.liveFilter = liveInput.value; });
  // Enter procura no arquivo inteiro: e o gesto natural, e sem ele a busca
  // ficaria presa na pagina carregada.
  liveInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    tab.liveFilter = liveInput.value;
    runSearch(tab);
  });

  toolbar.querySelectorAll(".level-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lvl = btn.dataset.level;
      if (tab.levels.has(lvl)) tab.levels.delete(lvl);
      else tab.levels.add(lvl);
      refreshPanel(tab);   // marca as linhas do nivel; nao esconde nada
    });
  });

  const act = (name) => toolbar.querySelector(`[data-act="${name}"]`);
  // No modo "arquivo todo" a paginacao percorre o resultado filtrado.
  const goTo = (offset) => loadFileContent(tab, { offset });
  // Avanca pelo que esta carregado: depois de um salto a janela e maior que a
  // pagina escolhida, e paginar pelo valor do seletor repetiria linhas.
  const step = () => Math.max(1, tab.lines.length || tab.limit);
  act("start").addEventListener("click", () => goTo(0));
  act("tail").addEventListener("click", () => loadFileContent(tab, { tail: true }));
  act("prev").addEventListener("click", () => goTo(Math.max(0, tab.offset - step())));
  act("next").addEventListener("click", () => goTo(tab.offset + step()));
  act("pagesize").addEventListener("change", (e) => {
    tab.limit = Number(e.target.value);
    goTo(tab.offset);
  });
  act("find").addEventListener("click", () => promptSearch(tab));
  act("prevhit").addEventListener("click", () => stepSearch(tab, -1));
  act("nexthit").addEventListener("click", () => stepSearch(tab, 1));
  act("filesearch").addEventListener("click", () => runSearch(tab));
  act("scope").addEventListener("change", (e) => {
    tab.findScope = e.target.value;
    if (tab.liveFilter.trim()) runSearch(tab);
  });
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
  act("follow").addEventListener("change", (e) => {
    tab.follow = e.target.checked;
    if (tab.follow) loadFileContent(tab, { tail: true });
  });
  act("autoscroll").addEventListener("change", (e) => {
    tab.autoScroll = e.target.checked;
    if (tab.autoScroll) scrollToEnd(tab);
  });
  act("wrap").addEventListener("change", (e) => {
    if (e.target.checked && shown.length > WRAP_SAFE_LIMIT) {
      e.target.checked = false;
      setStatus(`Quebrar linha desativado: escolha ate ${fmtNum(WRAP_SAFE_LIMIT)} linhas por pagina ` +
        "para usar esse modo (ele desliga a virtualizacao da tabela).", true);
      return;
    }
    tab.wrapText = e.target.checked;
    refreshPanel(tab);
  });
  act("export").addEventListener("click", () => exportLines(tab, shown));
  act("reset").addEventListener("click", () => resetFilters(tab));

  wireColumnResize(panel);

  if (wrap.dataset.virtual === "1") {
    // O primeiro render usa um palpite de altura (o painel ainda nao tem
    // layout); assim que o navegador calcular o tamanho de verdade (e a
    // cada resize depois disso), reconcilia o slice visivel.
    const ro = new ResizeObserver(() => updateVirtualSlice(wrap, tab));
    ro.observe(wrap);
    let scrollPending = false;
    wrap.addEventListener("scroll", () => {
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(() => { scrollPending = false; updateVirtualSlice(wrap, tab); });
    });
  }

  const tbody = wrap.querySelector("tbody");
  if (!tbody) return;

  clickNotDrag(tbody, (e) => {
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

/** Arrastar a borda do cabecalho muda a largura da coluna. A largura vive numa
 *  variavel CSS, entao o ajuste vale ao mesmo tempo para a tabela de log e para
 *  as de resultado, sem refazer o HTML durante o arrasto. */
function wireColumnResize(root) {
  root.querySelectorAll(".col-resize").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = handle.dataset.col;
      const startX = e.clientX;
      const startW = state.colWidths[key] ?? DEFAULT_COL_WIDTHS[key] ?? 80;
      document.body.classList.add("resizing-col");
      const onMove = (ev) => {
        state.colWidths[key] = Math.max(16, Math.round(startW + ev.clientX - startX));
        applyColWidths();
      };
      const onUp = () => {
        document.body.classList.remove("resizing-col");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        persist(COL_WIDTHS_KEY, state.colWidths);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    // Duplo clique na borda devolve a largura padrao da coluna.
    handle.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      state.colWidths[handle.dataset.col] = DEFAULT_COL_WIDTHS[handle.dataset.col];
      applyColWidths();
      persist(COL_WIDTHS_KEY, state.colWidths);
    });
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
    const dockScrollTop = old.querySelector(".fd-sections")?.scrollTop ?? 0;
    const wasFocused = old === focusedPanel;

    const fresh = buildPanel(tab, paneIndex);
    old.replaceWith(fresh);

    const dockSections = fresh.querySelector(".fd-sections");
    if (dockSections && dockScrollTop) dockSections.scrollTop = dockScrollTop;

    const wrap = fresh.querySelector(".log-wrap");
    if (wrap && scrollTop) {
      // Restaurar a rolagem dispara um evento de scroll; sem essa trava ele
      // fecharia o menu de contexto que acabou de ser aberto sobre a linha.
      suppressScrollHide = true;
      wrap.scrollTop = scrollTop;
      updateVirtualSlice(wrap, tab);
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
  tab.activeFilterIds.clear();
  tab.searchTerm = "";
  tab.timeRange = null;
  recomputeSearch(tab);
  state.selectedFilterId = null;
  renderFilterList();
  refreshPanel(tab);
  // As buscas e as marcacoes ficam: sao trabalho do usuario, nao filtro.
  setStatus("Filtros, marcas de nivel e destaques limpos.");
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
    { label: "Marcar para exportar", act: () => toggleExportMarks(tab) },
    { label: "Marcar/desmarcar (bookmark)", act: () => toggleBookmarks(tab) },
    { label: "Ver linhas marcadas", act: () => { tab.findOpen = true; tab.markedCollapsed = false; } },
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

function toggleExportMarks(tab) {
  for (const n of tab.selected) {
    if (tab.exportMarks.has(n)) tab.exportMarks.delete(n);
    else tab.exportMarks.add(n);
  }
  tab.findOpen = true;   // a janela abre para conferir antes de exportar
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
  if (scope === "current") {
    const tab = activeTab();
    if (!tab) return null;
    const params = new URLSearchParams({ root: tab.root || state.root });
    params.set("scope", "explicit");
    params.set("files", tab.path);
    return params;
  }
  if (scope === "open") {
    const tab = activeTab();
    if (!tab || !state.tabs.length) return null;
    const root = tab.root || state.root;
    const params = new URLSearchParams({ root });
    params.set("scope", "open");
    // So as abas da mesma raiz da aba ativa: /api/device_info resolve
    // caminho relativo a uma raiz so.
    params.set("open_files", state.tabs
      .filter((t) => (t.root || state.root) === root)
      .map((t) => t.path).join(","));
    return params;
  }
  // "folder" sempre varre a pasta raiz principal (#rootInput), nao os
  // arquivos do projeto adicionados de fora dela.
  if (!state.root) return null;
  const params = new URLSearchParams({ root: state.root });
  params.set("scope", "folder");
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
  if (!state.root && !state.tabs.length) {
    deviceInfoEl.innerHTML = '<p class="side-hint">Carregue uma pasta ou abra um arquivo primeiro.</p>';
    return;
  }
  const scope = el("#deviceScope").value;
  const params = scopeParams(scope);
  if (!params) {
    deviceInfoEl.innerHTML = scope === "folder"
      ? '<p class="side-hint">Carregue uma pasta primeiro (a varredura por pasta so olha a raiz principal).</p>'
      : '<p class="side-hint">Abra um arquivo de log primeiro.</p>';
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

/** Tudo que o app conseguiu associar a um codigo do log: PID e UID viram nome
 *  de processo, TAG vira o servico do sistema. Sao as mesmas associacoes que
 *  aparecem na dica de cada celula, reunidas num lugar so para consulta. */
function associationsHtml(tab, q) {
  if (!tab) return "";
  const parts = [];
  const hit = (a, b) => !q || String(a).toLowerCase().includes(q) ||
    String(b).toLowerCase().includes(q);

  const pids = Object.entries(tab.procMap || {})
    .filter(([pid, name]) => hit(pid, name))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  if (pids.length) {
    parts.push(
      `<details class="dev-cat" ${q ? "open" : ""}>` +
      `<summary>\u{1F5C2} PID &rarr; processo<span class="count">${pids.length}</span></summary>` +
      pids.map(([pid, name]) => {
        const uid = (tab.procUids || {})[pid];
        const dup = tab.procAmbiguous && tab.procAmbiguous.has(pid);
        return `<div class="dev-item assoc" data-pid="${escapeHtml(pid)}" ` +
          `title="Clique para buscar as linhas deste PID${dup ? " (PID reutilizado na captura)" : ""}">` +
          `<span class="k">PID ${escapeHtml(pid)}${uid ? " &middot; uid " + escapeHtml(uid) : ""}` +
          `${dup ? ' <em class="assoc-warn">reutilizado</em>' : ""}</span>` +
          `<span class="v">${escapeHtml(name)}</span></div>`;
      }).join("") + `</details>`);
  }

  // TAGs que o glossario reconhece como servico do sistema.
  if (glossaryData) {
    const tags = Object.entries(glossaryData.tag_index)
      .map(([tag, sigla]) => [tag, sigla, glossaryEntry(sigla)])
      .filter(([tag, sigla, e]) => e && hit(tag, `${sigla} ${e.nome}`));
    if (tags.length) {
      parts.push(
        `<details class="dev-cat" ${q ? "open" : ""}>` +
        `<summary>\u{1F3F7} TAG &rarr; servico<span class="count">${tags.length}</span></summary>` +
        tags.map(([tag, sigla, e]) =>
          `<div class="dev-item assoc" data-tag="${escapeHtml(tag)}" ` +
          `title="${escapeHtml(e.desc)}">` +
          `<span class="k">${escapeHtml(tag)}</span>` +
          `<span class="v">${escapeHtml(sigla)} &middot; ${escapeHtml(e.nome)}</span></div>`).join("") +
        `</details>`);
    }
  }
  return parts.join("");
}

/** Clicar numa associacao dispara a busca correspondente. */
function wireAssociations(tab) {
  deviceInfoEl.querySelectorAll(".dev-item.assoc").forEach((node) => {
    node.addEventListener("click", () => {
      if (!tab) return;
      const query = node.dataset.pid ? `pid:${node.dataset.pid}` : `tag:${node.dataset.tag}`;
      tab.liveFilter = query;
      runSearch(tab, query);
    });
  });
}

function renderDeviceInfo() {
  const tab = activeTab();
  const q = el("#deviceSearch").value.trim().toLowerCase();
  const parts = [];
  const assoc = associationsHtml(tab, q);
  if (assoc) parts.push(assoc);

  if (!deviceReport) {
    // As associacoes vem do mapa de processos, que carrega sozinho ao abrir o
    // arquivo; nao dependem da analise completa do aparelho.
    deviceInfoEl.innerHTML = parts.length
      ? parts.join("") +
        '<p class="side-hint">Clique em <strong>Analisar</strong> para extrair ' +
        'modelo, build, kernel, CPU, memoria, bateria e o resto.</p>'
      : '<p class="side-hint">Abra um arquivo de log e clique em <strong>Analisar</strong> ' +
        'para extrair modelo, build, kernel, CPU, memoria, bateria, telefonia e ' +
        'demais dados do aparelho.</p>';
    wireAssociations(tab);
    return;
  }

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

  wireAssociations(activeTab());

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
// Aparelhos ligados na USB (adb)
// ---------------------------------------------------------------------------

const usbListEl = el("#usbList");
let usbLabels = {};

/** Marca no topo de qual aparelho e a pasta aberta. Sem isso, com dois
 *  aparelhos capturados, nada na tela diria de quem sao as linhas na tela. */
function setRootDevice(identity) {
  state.rootDevice = identity || null;
  const badge = el("#rootDevice");
  if (!identity) {
    badge.hidden = true;
    return;
  }
  const modelo = identity.modelo?.value || "aparelho";
  const serial = identity.serial?.value || "";
  badge.hidden = false;
  badge.textContent = `\u{1F4F1} ${modelo}${serial ? " · " + serial : ""}`;
  badge.title = Object.entries(identity)
    .filter(([, v]) => v && v.value)
    .map(([k, v]) => `${usbLabels[k] || k}: ${v.value}  (${v.prop})`)
    .join("\n");
}

el("#usbScanBtn").addEventListener("click", scanUsb);

async function scanUsb() {
  const btn = el("#usbScanBtn");
  btn.disabled = true;
  usbListEl.innerHTML = '<p class="side-hint">Procurando...</p>';
  try {
    const res = await fetch("/api/usb_devices");
    const data = await res.json();
    if (!res.ok) {
      usbListEl.innerHTML = `<p class="side-hint usb-err">${escapeHtml(data.error)}</p>`;
      return;
    }
    usbLabels = data.labels || {};
    renderUsb(data);
  } catch (err) {
    usbListEl.innerHTML = `<p class="side-hint usb-err">Falha na requisicao: ${escapeHtml(err)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function renderUsb(data) {
  if (!data.devices.length) {
    usbListEl.innerHTML = '<p class="side-hint">Nenhum aparelho na USB. Ligue o cabo e ' +
      'habilite a depuracao USB no aparelho.</p>';
    return;
  }
  usbListEl.innerHTML = data.devices.map((dev, i) => {
    const id = dev.identity;
    if (!id) {
      return `<div class="usb-dev usb-off">` +
        `<div class="usb-title">${escapeHtml(dev.model_hint || dev.serial)}</div>` +
        `<div class="usb-err">${escapeHtml(dev.error || "sem resposta")}</div></div>`;
    }
    const rows = Object.entries(id)
      .filter(([, v]) => v && v.value)
      .map(([k, v]) =>
        `<div class="usb-row" title="${escapeHtml(v.prop)}">` +
        `<span class="k">${escapeHtml(usbLabels[k] || k)}</span>` +
        `<span class="v">${escapeHtml(v.value)}</span></div>`).join("");
    return `<div class="usb-dev" data-i="${i}">` +
      `<div class="usb-title">${escapeHtml(id.modelo?.value || dev.serial)}</div>` +
      rows +
      `<button class="usb-capture" data-serial="${escapeHtml(dev.serial)}">Capturar logs</button>` +
      `<div class="usb-live" data-serial="${escapeHtml(dev.serial)}"></div>` +
      `</div>`;
  }).join("") +
    `<p class="side-hint">Cada aparelho grava numa pasta propria, nomeada por ` +
    `modelo e serial, e a captura abre essa pasta — dois aparelhos nunca se misturam.</p>`;

  usbListEl.querySelectorAll(".usb-capture").forEach((btn) => {
    btn.addEventListener("click", () => captureUsb(btn, btn.dataset.serial));
  });
  renderLive();
}

// ---------------------------------------------------------------------------
// Coleta ao vivo do logcat
// ---------------------------------------------------------------------------
// O adb grava num arquivo que cresce e o app abre esse arquivo como qualquer
// outro; a analise ao vivo e a mesma de um log parado.

let liveSessions = [];

async function refreshLive() {
  try {
    const res = await fetch("/api/live_status");
    const data = await res.json();
    liveSessions = data.sessions || [];
  } catch { liveSessions = []; }
  renderLive();
}

function liveOf(serial) {
  return liveSessions.find((s) => s.serial === serial) || null;
}

function renderLive() {
  usbListEl.querySelectorAll(".usb-live").forEach((box) => {
    const serial = box.dataset.serial;
    const live = liveOf(serial);
    const rodando = live && live.state !== "encerrada";

    box.innerHTML = rodando
      ? `<div class="live-state live-${live.state}">` +
          `${live.state === "pausada" ? "\u23f8 pausada" : "\u25cf coletando"}` +
          ` \u00b7 ${fmtSize(live.size)}` +
          `${live.filter ? " \u00b7 filtro " + escapeHtml(live.filter) : ""}</div>` +
        `<div class="live-btns">` +
          `<button data-live="${live.state === "pausada" ? "resume" : "pause"}">` +
            `${live.state === "pausada" ? "Retomar" : "Pausar"}</button>` +
          `<button data-live="restart">Reiniciar</button>` +
          `<button data-live="stop">Parar</button>` +
          `<button data-live="open">Abrir</button>` +
        `</div>`
      : `<div class="live-btns">` +
          `<input class="live-filter-spec" placeholder="filtro do logcat, ex: *:E" ` +
            `title="Formato do logcat: TAG:nivel. Ex: ActivityManager:I *:S">` +
          `<button data-live="start" class="primary">Coletar ao vivo</button>` +
        `</div>`;

    box.querySelectorAll("[data-live]").forEach((btn) => {
      btn.addEventListener("click", () => liveAction(serial, btn.dataset.live, box));
    });
  });
}

async function liveAction(serial, action, box) {
  if (action === "open") {
    const live = liveOf(serial);
    if (live) await abrirAoVivo(live);
    return;
  }
  const params = new URLSearchParams({ action, serial });
  const spec = box.querySelector(".live-filter-spec");
  if (spec && spec.value.trim()) params.set("filter", spec.value.trim());

  try {
    const res = await fetch(`/api/live?${params}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Erro na coleta.", true);
      return;
    }
    await refreshLive();
    if (action === "start" || action === "restart") {
      setStatus(`Coletando o logcat de ${serial}...`);
      await abrirAoVivo(data);
    } else {
      setStatus(`Coleta ${action === "pause" ? "pausada" : action === "resume" ? "retomada" : "encerrada"}.`);
    }
  } catch (err) {
    setStatus("Falha na requisicao: " + err, true);
  }
}

/** Abre o arquivo que esta sendo gravado e liga o modo "seguir". */
async function abrirAoVivo(live) {
  el("#rootInput").value = live.dir;
  state.rootDeviceBase = live.dir;
  if (live.identity) setRootDevice(live.identity);
  await loadRoot();
  // Sem trocar de aba: os controles de pausar e parar ficam nesta, e escondê-los
  // logo depois de iniciar a coleta deixaria o usuario sem como interromper.
  openFile(state.root, live.file.split("/").pop());
  const tab = activeTab();
  if (tab) {
    // Numa coleta ao vivo o que interessa e a linha que acabou de chegar.
    tab.follow = true;
    tab.autoScroll = true;
    await loadFileContent(tab, { tail: true });
  }
}

// Enquanto houver coleta rodando, o estado dos botoes e o tamanho do arquivo
// se atualizam sozinhos.
setInterval(() => {
  if (liveSessions.some((s) => s.state !== "encerrada")) refreshLive();
}, 3000);

// O modo "seguir" recarrega o fim do arquivo que cresce.
setInterval(() => {
  for (const tab of state.tabs) {
    if (!tab.follow || tab.binary) continue;
    loadFileContent(tab, { tail: true });
  }
}, 3000);

async function captureUsb(btn, serial) {
  const withBugreport = el("#usbBugreport").checked;
  btn.disabled = true;
  btn.textContent = withBugreport ? "Capturando (bugreport demora)..." : "Capturando...";
  setStatus(`Capturando logs de ${serial}...`);
  try {
    const params = new URLSearchParams({ serial });
    if (withBugreport) params.set("bugreport", "true");
    const res = await fetch(`/api/usb_capture?${params}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Erro na captura.", true);
      return;
    }
    // Abre a pasta do aparelho: a partir daqui a analise e a mesma de sempre.
    el("#rootInput").value = data.path;
    state.rootDeviceBase = data.path;
    setRootDevice(data.identity);
    await loadRoot();
    // Leva para a arvore: e nela que os arquivos capturados aparecem.
    document.querySelector('.side-tab[data-side="files"]').click();
    setStatus(`${data.files.length} arquivo(s) capturados de ` +
      `${data.identity.modelo?.value || serial} em ${data.path}`);
  } catch (err) {
    setStatus("Falha na requisicao: " + err, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Capturar logs";
  }
}

// ---------------------------------------------------------------------------
// Aba lateral: Filtros salvos
// ---------------------------------------------------------------------------

const FILTERS_KEY = "logviewer.savedFilters";
// O localStorage e so um cache local pra pintar a tela na hora; ele fica
// preso a cada origem/webview, entao web e desktop (mesmo backend, mesmo
// arquivo) apareceriam com filtros diferentes se fosse a unica fonte. O
// arquivo no servidor (/api/saved_filters) e quem manda de verdade.
state.savedFilters = store(FILTERS_KEY, []);

const filterListEl = el("#filterList");
const filterDialog = el("#filterDialog");

async function syncFiltersToServer() {
  try {
    await fetch("/api/saved_filters", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.savedFilters),
    });
  } catch { /* sem servidor: os filtros continuam validos localmente */ }
}

async function loadSavedFiltersFromServer() {
  try {
    const res = await fetch("/api/saved_filters");
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.filters)) return;
    if (data.filters.length) {
      state.savedFilters = data.filters;
      persist(FILTERS_KEY, state.savedFilters);
      renderFilterList();
    } else if (state.savedFilters.length) {
      // Servidor ainda sem nada (primeira vez com esta versao) mas ja existem
      // filtros no localStorage de uma versao anterior: migra pra virarem a
      // fonte compartilhada, em vez de sumirem da tela.
      await syncFiltersToServer();
    }
  } catch { /* offline: segue com o que tem no cache local */ }
}
loadSavedFiltersFromServer();

function saveFilters() {
  persist(FILTERS_KEY, state.savedFilters);
  syncFiltersToServer();
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
  // Cada filtro e um botao de liga/desliga: varios podem ficar ativos ao mesmo
  // tempo, e juntos formam uma unica secao de resultados.
  const tab = activeTab();
  for (const f of state.savedFilters) {
    const on = !!(tab && tab.activeFilterIds.has(f.id));
    const li = document.createElement("li");
    li.className = (on ? "on " : "") + (state.selectedFilterId === f.id ? "selected" : "");
    // Um no por linha no resumo: espremer tudo numa linha so obrigava a cortar
    // o nome, que e justamente o que identifica o filtro.
    const nodes = filterNodes(f);
    const resumo = nodes.map((n) => {
      const campos = [
        n.tag ? `tag:${n.tag}` : "",
        n.pid ? `pid:${n.pid}` : "",
        n.tid ? `tid:${n.tid}` : "",
        n.levels && n.levels.length ? n.levels.join("") : "",
      ].filter(Boolean).join(" ");
      const partes = [campos, n.text].filter(Boolean);
      return partes.join(" \u00b7 ") || "(vazio)";
    });
    li.innerHTML =
      `<span class="filter-onoff">${on ? "&#9679;" : "&#9675;"}</span>` +
      `<div class="filter-body">` +
        `<div class="filter-name">${escapeHtml(f.name)}</div>` +
        resumo.map((linha, i) =>
          `<div class="filter-meta">${i ? '<em class="filter-ou">ou</em> ' : ""}` +
          `${escapeHtml(linha)}</div>`).join("") +
      `</div>`;
    li.title = (on ? "Ativo — clique para desligar" : "Clique para ativar") +
      "\nDuplo clique edita o filtro";
    li.addEventListener("click", () => {
      state.selectedFilterId = f.id;   // qual o Editar/Excluir vao pegar
      toggleSavedFilter(f.id);
    });
    li.addEventListener("dblclick", () => openFilterDialog(f.id));
    filterListEl.appendChild(li);
  }
}

/** Valor de campo casa exatamente, nao por pedaco: quem escreve
 *  tag:TelephonyDataSource quer aquela TAG, nao qualquer uma que a contenha.
 *  Continua aceitando "a|b" para varios valores, e um padrao com sintaxe de
 *  regex e respeitado como o autor escreveu. */
function exactPattern(value) {
  if (/[\\^$.*+?()[\]{}]/.test(value)) return value;
  const parts = value.split("|").map((v) => v.trim()).filter(Boolean);
  if (!parts.length) return value;
  return `^(?:${parts.join("|")})$`;
}

/** Converte os nos do filtro no payload que /api/filtered espera, resolvendo
 *  nomes de processo em PIDs.
 *
 *  Dentro de um no tudo e E: os campos preenchidos precisam casar todos. As
 *  palavras-chave procuram no texto da mensagem quando o no tambem define
 *  TAG/PID/TID/nivel — senao "TAG Telecom com a palavra Telecom" casaria pela
 *  propria coluna TAG. Num no so de palavras-chave elas valem para a linha
 *  inteira, que e o unico jeito de alcancar as linhas que nem sao logcat.
 *  Entre nos e OU: cada no filtra por conta e os resultados se somam. */
function filterGroups(tab, f) {
  const groups = [];
  let unresolved = null;
  for (const node of filterNodes(f)) {
    const g = {};
    if (node.tag) g.tag = exactPattern(node.tag);
    if (node.tid) g.tid = exactPattern(node.tid);
    if (node.levels && node.levels.length) g.levels = node.levels.join(",");
    if (node.pid) {
      const r = resolvePid(tab, node.pid);
      if (!r.pattern) { unresolved = node.pid; continue; }
      g.pid = r.pattern;
    }
    if (node.text) {
      const words = splitAndOr(node.text).groups;
      if (Object.keys(g).length) g.text = words;   // com campo definido: so a mensagem
      else g.raw = words;                          // no de palavras: a linha toda
    }
    if (Object.keys(g).length) groups.push(g);
  }
  return { groups, unresolved };
}

// Todos os filtros salvos ativos vivem numa secao so, com este id fixo: ligar
// ou desligar um filtro atualiza essa mesma secao em vez de empilhar outras.
const SAVED_SECTION_ID = "filtros-salvos";

/** Liga/desliga um filtro salvo na aba atual. Varios podem ficar ativos ao
 *  mesmo tempo, e o conjunto vira uma unica secao de resultados. */
function toggleSavedFilter(id) {
  const tab = activeTab();
  if (!tab) {
    setStatus("Abra um arquivo antes de aplicar o filtro.", true);
    return;
  }
  if (tab.activeFilterIds.has(id)) tab.activeFilterIds.delete(id);
  else tab.activeFilterIds.add(id);
  syncSavedFilters(tab);
}

/** Recalcula a secao dos filtros salvos a partir dos que estao ativos. */
function syncSavedFilters(tab) {
  const idx = tab.findSections.findIndex((x) => x.id === SAVED_SECTION_ID);
  if (idx >= 0) tab.findSections.splice(idx, 1);

  const filters = [...tab.activeFilterIds]
    .map((id) => state.savedFilters.find((f) => f.id === id))
    .filter(Boolean);

  // Sem nenhum filtro ativo a secao simplesmente deixa de existir.
  if (!filters.length) {
    renderFilterList();
    refreshPanel(tab);
    setStatus("Nenhum filtro salvo ativo.");
    return;
  }

  const groups = [];
  const unresolved = [];
  for (const f of filters) {
    const r = filterGroups(tab, f);
    groups.push(...r.groups);
    if (r.unresolved) unresolved.push(`${f.name}: "${r.unresolved}"`);
  }
  renderFilterList();

  if (!groups.length) {
    setStatus(unresolved.length
      ? `Nenhum processo casa com ${unresolved.join(", ")}.`
      : "Os filtros ativos nao tem criterios.", true);
    refreshPanel(tab);
    return;
  }
  if (unresolved.length) {
    setStatus(`Ignorando (processo nao encontrado): ${unresolved.join(", ")}`, true);
  }

  const names = filters.map((f) => f.name);
  const colorSource = filters
    .flatMap((f) => filterNodes(f).map((n) => n.text))
    .filter(Boolean).join(" ");
  runSearch(tab, names.join(" + "), {
    groups, id: SAVED_SECTION_ID, savedNames: names, colorSource,
  });
}

/** Um filtro e uma lista de nos combinados em OU. Filtros antigos, de campo
 *  unico, sao lidos como um no so. */
function filterNodes(f) {
  if (Array.isArray(f.nodes) && f.nodes.length) return f.nodes;
  if (f.tag || f.text || f.pid || f.tid || (f.levels && f.levels.length)) {
    return [{ tag: f.tag || "", text: f.text || "", pid: f.pid || "",
              tid: f.tid || "", levels: f.levels || [] }];
  }
  return [{ tag: "", text: "", pid: "", tid: "", levels: [] }];
}

let fdNodes = [];

function renderFilterNodes() {
  const box = el("#fdNodes");
  box.innerHTML = fdNodes.map((node, i) => `
    <fieldset class="fd-node" data-i="${i}">
      <legend>No ${i + 1}${i ? " &mdash; <em>somado ao anterior</em>" : ""}
        ${fdNodes.length > 1 ? '<button type="button" class="fd-node-del" title="Remover este no">&times;</button>' : ""}
      </legend>
      <div class="dialog-row">
        <label>TAG <input data-f="tag" value="${escapeHtml(node.tag || "")}" placeholder="ex: Telecom"></label>
        <label>PID ou app <input data-f="pid" value="${escapeHtml(node.pid || "")}" placeholder="ex: 3154 ou sbrowser"></label>
        <label>TID <input data-f="tid" value="${escapeHtml(node.tid || "")}" placeholder="ex: 8144"></label>
      </div>
      <label>Palavras-chave <input data-f="text" value="${escapeHtml(node.text || "")}"
        placeholder="ex: getSimOperatorMccMnc|mccmnc|plmn  (| = ou, &amp; = e)"></label>
      <div class="dialog-row">
        <span class="dialog-label">Niveis</span>
        <div class="level-toggles" data-f="levels">
          ${LEVELS.map((l) => `<button type="button" class="level-toggle${(node.levels || []).includes(l) ? " on" : ""}" data-level="${l}">${l}</button>`).join("")}
        </div>
      </div>
    </fieldset>`).join("");

  box.querySelectorAll(".fd-node").forEach((fs) => {
    const i = Number(fs.dataset.i);
    fs.querySelectorAll("input[data-f]").forEach((input) => {
      input.addEventListener("input", () => { fdNodes[i][input.dataset.f] = input.value; });
    });
    fs.querySelectorAll(".level-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.classList.toggle("on");
        fdNodes[i].levels = [...fs.querySelectorAll(".level-toggle.on")].map((b) => b.dataset.level);
      });
    });
    const del = fs.querySelector(".fd-node-del");
    if (del) del.addEventListener("click", () => {
      fdNodes.splice(i, 1);
      renderFilterNodes();
    });
  });
}

function openFilterDialog(id) {
  state.editingFilterId = id || null;
  const f = state.savedFilters.find((x) => x.id === id) || {};
  el("#filterDialogTitle").textContent = id ? "Editar filtro" : "Novo filtro";
  el("#fdName").value = f.name || "";
  el("#fdCase").checked = !!f.caseSensitive;
  fdNodes = filterNodes(f).map((n) => ({ ...n, levels: [...(n.levels || [])] }));
  renderFilterNodes();
  filterDialog.hidden = false;
  el("#fdName").focus();
}

el("#fdAddNode").addEventListener("click", () => {
  fdNodes.push({ tag: "", text: "", pid: "", tid: "", levels: [] });
  renderFilterNodes();
});

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
    tab.activeFilterIds.delete(state.selectedFilterId);
  }
  state.selectedFilterId = null;
  saveFilters();
  const tab = activeTab();
  if (tab) syncSavedFilters(tab);
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
        nodes: filterNodes(f),
        caseSensitive: !!f.caseSensitive,
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
  const nodes = fdNodes
    .map((n) => ({
      tag: (n.tag || "").trim(), text: (n.text || "").trim(),
      pid: (n.pid || "").trim(), tid: (n.tid || "").trim(),
      levels: n.levels || [],
    }))
    .filter((n) => n.tag || n.text || n.pid || n.tid || n.levels.length);
  if (!nodes.length) {
    setStatus("Preencha ao menos um campo em algum no.", true);
    return;
  }
  const data = { name, nodes, caseSensitive: el("#fdCase").checked };
  const existing = state.savedFilters.find((x) => x.id === state.editingFilterId);
  if (existing) Object.assign(existing, data);
  else state.savedFilters.push({ id: "f" + Date.now() + Math.random().toString(36).slice(2, 6), ...data });
  filterDialog.hidden = true;
  saveFilters();
  const tab = activeTab();
  if (tab && tab.activeFilterIds.size) syncSavedFilters(tab);
  else if (tab) refreshPanel(tab);
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
    const params = new URLSearchParams({ root: tab.root || state.root, file: tab.path, buckets: 600 });
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
    jumpToLine(tab, line);
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
    const params = new URLSearchParams({ root: tab.root || state.root, file: tab.path });
    const res = await fetch(`/api/process_map?${params}`);
    const data = await res.json();
    if (!res.ok) return;
    tab.procMap = data.pids || {};
    tab.procUids = data.uids || {};
    tab.procAmbiguous = new Set(data.ambiguous || []);
    if (data.count) {
      setStatus(`${data.count} PID(s) vinculados ao nome do processo.`);
      refreshPanel(tab);
      renderDeviceInfo();   // a lista de associacoes ja pode ser consultada
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
  // Mesma gramatica da busca: "a|b" e "a&b" viram um destaque por palavra,
  // cada um com sua cor. Espaco continua fazendo parte da frase.
  if (!/[()[\]\\]/.test(pattern) && /[|&]/.test(pattern)) {
    let last = null;
    for (const word of splitAndOr(pattern).words) last = addHighlight(word, caseSensitive);
    return last;
  }
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
    // panes guarda raiz+caminho, nao o id: os ids sao recriados ao abrir. A
    // raiz entra na chave porque dois arquivos do projeto de pastas
    // diferentes podem ter o mesmo caminho relativo.
    panes: state.panes.slice(0, state.paneCount).map((id) => {
      const t = state.tabs.find((x) => x.id === id);
      return t ? { root: t.root, path: t.path } : null;
    }),
    tabs: state.tabs.map((t) => ({
      root: t.root,
      path: t.path,
      offset: t.offset,
      limit: t.limit,
      wrapText: t.wrapText,
      liveFilter: t.liveFilter,
      levels: [...t.levels],
      showTags: [...t.showTags], hideTags: [...t.hideTags],
      showPids: [...t.showPids], hidePids: [...t.hidePids],
      highlightTags: [...t.highlightTags], highlightPids: [...t.highlightPids],
      bookmarks: [...t.bookmarks],
      exportMarks: [...t.exportMarks],
      timeRange: t.timeRange,
      activeFilterIds: [...t.activeFilterIds],
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
  const paneKey = (root, path) => `${root || ""}::${path}`;
  for (const saved of session.tabs) {
    const tab = newTab(saved.root || session.root || state.root, saved.path);
    tab.limit = saved.limit || DEFAULT_PAGE_SIZE;
    tab.wrapText = !!saved.wrapText;
    tab.liveFilter = saved.liveFilter || "";
    for (const id of saved.activeFilterIds || []) tab.activeFilterIds.add(id);
    tab.timeRange = saved.timeRange || null;
    for (const [key, values] of Object.entries({
      levels: saved.levels, showTags: saved.showTags, hideTags: saved.hideTags,
      showPids: saved.showPids, hidePids: saved.hidePids,
      highlightTags: saved.highlightTags, highlightPids: saved.highlightPids,
      bookmarks: saved.bookmarks, exportMarks: saved.exportMarks,
    })) {
      for (const v of values || []) tab[key].add(v);
    }
    state.tabs.push(tab);
    byPath.set(paneKey(tab.root, saved.path), tab);
  }
  (session.panes || []).forEach((entry, i) => {
    if (!entry) return;
    // Sessoes antigas (v1 sem multi-raiz) guardavam so a string do caminho.
    const root = typeof entry === "string" ? (session.root || state.root) : entry.root;
    const path = typeof entry === "string" ? entry : entry.path;
    const tab = byPath.get(paneKey(root, path));
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
    await loadFileContent(tab, { offset: saved.offset || 0 });
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
    if (!glossaryDialog.hidden) { glossaryDialog.hidden = true; return; }
    if (!browseDialog.hidden) { browseDialog.hidden = true; return; }
    if (!ctxMenu.hidden) { hideContextMenu(); return; }
    const tab = activeTab();
    if (tab && tab.findOpen) { tab.findOpen = false; refreshPanel(tab); }
    return;
  }
  // Uma busca so: Ctrl+F foca a caixa do painel; Ctrl+Shift+F faz o mesmo ja
  // com o escopo na pasta inteira.
  if (mod && e.key.toLowerCase() === "f") {
    e.preventDefault();
    focusSearchBox(e.shiftKey ? "folder" : null);
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
    // Havendo texto selecionado com o mouse, quem copia e o navegador: copiar
    // a linha inteira por cima descartaria justamente o trecho escolhido.
    if (String(window.getSelection() || "").trim()) return;
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
