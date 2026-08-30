import json
import os
import re

from flask import Blueprint, jsonify, request

from . import analysis, deviceinfo, devices, glossary, prefs
from .fsops import PathError, browse, list_tree, resolve_within_root
from .logline import scan_fields
from .reader import cached_format, columns_for, count_lines, detect_encoding, read_file
from .search import RegexError, gather_folder_files, search_files

api = Blueprint("api", __name__, url_prefix="/api")


def _resolve_scope_rel_paths(root, scope, args, default_max_files):
    """Shared by /search and /log_fields: figure out which relative paths are
    in scope (explicit list, currently open tabs, or a folder walk)."""
    if scope == "folder":
        glob_patterns = [g for g in args.get("glob", "").split(",") if g.strip()]
        max_files = args.get("max_files", default_max_files, type=int)
        rel_paths, truncated = gather_folder_files(root, glob_patterns, max_files)
        return rel_paths, truncated
    elif scope == "open":
        return [p for p in args.get("open_files", "").split(",") if p], False
    else:
        return [p for p in args.get("files", "").split(",") if p], False


@api.get("/tree")
def get_tree():
    root = request.args.get("root", "")
    try:
        result = list_tree(root)
    except PathError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(result)


@api.get("/file")
def get_file():
    root = request.args.get("root", "")
    rel_path = request.args.get("file", "")
    tail = request.args.get("tail", "false").lower() == "true"
    offset = request.args.get("offset", 0, type=int)
    limit = request.args.get("limit", 500, type=int)
    parse = request.args.get("parse", "true").lower() != "false"

    try:
        full_path = resolve_within_root(root, rel_path)
    except PathError as e:
        return jsonify({"error": str(e)}), 400

    if os.path.isdir(full_path):
        return jsonify({"error": f"'{rel_path}' e um diretorio, nao um arquivo."}), 400

    try:
        result = read_file(full_path, offset=offset, limit=limit, tail=tail, parse=parse)
    except OSError as e:
        return jsonify({"error": f"Erro lendo arquivo: {e}"}), 500

    result["path"] = rel_path
    return jsonify(result)


@api.get("/search")
def get_search():
    root = request.args.get("root", "")
    scope = request.args.get("scope", "explicit")  # explicit | open | folder
    pattern = request.args.get("pattern", "")
    flags = [f for f in request.args.get("flags", "").split(",") if f]
    max_results = request.args.get("max_results", 500, type=int)
    total_max_results = request.args.get("total_max_results", max_results, type=int)
    context = request.args.get("context", 0, type=int)

    levels = set(v for v in request.args.get("levels", "").split(",") if v)
    tags = set(v for v in request.args.get("tags", "").split(",") if v)
    pids = set(v for v in request.args.get("pids", "").split(",") if v)
    uids = set(v for v in request.args.get("uids", "").split(",") if v)
    field_filters = {
        "levels": levels or None,
        "tags": tags or None,
        "pids": pids or None,
        "uids": uids or None,
    }

    try:
        rel_paths, files_truncated = _resolve_scope_rel_paths(root, scope, request.args, 300)
    except PathError as e:
        return jsonify({"error": str(e)}), 400

    if not rel_paths:
        return jsonify({"error": "Nenhum arquivo no escopo da busca."}), 400

    resolved = []
    kept_rel_paths = []
    try:
        for rel in rel_paths:
            full_path = resolve_within_root(root, rel)
            if os.path.isdir(full_path):
                continue
            resolved.append(full_path)
            kept_rel_paths.append(rel)
    except PathError as e:
        return jsonify({"error": str(e)}), 400

    try:
        results, total_matches = search_files(
            resolved, pattern, flags, max_results, context, total_max_results, field_filters
        )
    except RegexError as e:
        return jsonify({"error": str(e)}), 400

    for r, rel in zip(results, kept_rel_paths):
        r["path"] = rel

    return jsonify({
        "pattern": pattern,
        "flags": flags,
        "scope": scope,
        "results": results,
        "total_matches": total_matches,
        "files_searched": len(results),
        "files_truncated": files_truncated,
    })


def _resolve_log_file(root, rel_path):
    """Resolve um arquivo do escopo e devolve (caminho, encoding, formato).
    Levanta PathError ou ValueError com mensagem pronta para a UI."""
    full_path = resolve_within_root(root, rel_path)
    if os.path.isdir(full_path):
        raise ValueError(f"'{rel_path}' e um diretorio, nao um arquivo.")
    encoding = detect_encoding(full_path)
    return full_path, encoding, cached_format(full_path, encoding)


@api.get("/timeline")
def get_timeline():
    """Mapa de calor do arquivo inteiro: niveis e eventos notaveis por faixa de
    linhas, para a barra de navegacao."""
    root = request.args.get("root", "")
    rel_path = request.args.get("file", "")
    buckets = request.args.get("buckets", analysis.DEFAULT_BUCKETS, type=int)

    try:
        full_path, encoding, log_format = _resolve_log_file(root, rel_path)
    except PathError as e:
        return jsonify({"error": str(e)}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        total = count_lines(full_path)
        result = analysis.timeline(full_path, encoding, log_format, total, buckets)
    except OSError as e:
        return jsonify({"error": f"Erro lendo arquivo: {e}"}), 500

    result["path"] = rel_path
    result["format"] = log_format
    return jsonify(result)


@api.get("/process_map")
def get_process_map():
    """Descobre a que processo pertence cada PID visto no arquivo."""
    root = request.args.get("root", "")
    rel_path = request.args.get("file", "")

    try:
        full_path, encoding, log_format = _resolve_log_file(root, rel_path)
    except PathError as e:
        return jsonify({"error": str(e)}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = analysis.process_map(full_path, encoding, log_format)
    except OSError as e:
        return jsonify({"error": f"Erro lendo arquivo: {e}"}), 500

    result["path"] = rel_path
    return jsonify(result)


@api.get("/filtered")
def get_filtered():
    """Uma pagina do resultado de um filtro aplicado ao arquivo inteiro, e nao
    apenas a pagina carregada na tela."""
    root = request.args.get("root", "")
    rel_path = request.args.get("file", "")
    offset = request.args.get("offset", 0, type=int)
    limit = request.args.get("limit", 500, type=int)
    limit = max(1, min(limit, 20000))

    try:
        full_path, encoding, log_format = _resolve_log_file(root, rel_path)
    except PathError as e:
        return jsonify({"error": str(e)}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    case_sensitive = request.args.get("case", "false").lower() == "true"

    def build(src):
        levels = src.get("levels")
        if isinstance(levels, str):
            levels = [v for v in levels.split(",") if v]
        return analysis.FilterSpec(
            levels=levels or None,
            tag=src.get("tag") or None,
            # `text` tambem pode vir repetido, como `raw`.
            text=(src.getlist("text") if hasattr(src, "getlist") else src.get("text")) or None,
            pid=src.get("pid") or None,
            tid=src.get("tid") or None,
            uid=src.get("uid") or None,
            # `raw` pode vir repetido: todas as palavras na mesma linha.
            raw=(src.getlist("raw") if hasattr(src, "getlist") else src.get("raw")) or None,
            negate=str(src.get("negate", "")).lower() == "true",
            case_sensitive=case_sensitive,
        )

    try:
        # `groups` e uma lista JSON de nos combinados em OU, para consultas do
        # tipo "esta TAG com estas palavras OU aquele PID com aquelas".
        groups_raw = request.args.get("groups")
        if groups_raw:
            groups = json.loads(groups_raw)
            if not isinstance(groups, list) or not groups:
                return jsonify({"error": "Parametro 'groups' invalido."}), 400
            spec = analysis.MultiSpec([build(g) for g in groups if isinstance(g, dict)])
        else:
            spec = build(request.args)
    except (re.error, ValueError) as e:
        return jsonify({"error": f"Filtro invalido: {e}"}), 400

    if spec.empty:
        return jsonify({"error": "Informe ao menos um criterio de filtro."}), 400

    try:
        result = analysis.read_filtered(
            full_path, encoding, log_format, spec, offset=offset, limit=limit)
    except OSError as e:
        return jsonify({"error": f"Erro lendo arquivo: {e}"}), 500

    result["columns"] = columns_for(result["lines"], log_format)
    result["path"] = rel_path
    result["format"] = log_format
    result["total_lines"] = count_lines(full_path)
    return jsonify(result)


@api.get("/browse")
def get_browse():
    """Lista as subpastas de um caminho, para o seletor de pasta."""
    try:
        result = browse(request.args.get("path") or None)
    except PathError as e:
        return jsonify({"error": str(e)}), 400

    # Atalhos para os lugares que fazem sentido comecar.
    shortcuts = []
    for label, target in (
        ("Pasta de logs", os.environ.get("LOG_ROOT")),
        ("Capturas USB", devices.DEFAULT_CAPTURE_ROOT),
        ("Minha pasta", os.path.expanduser("~")),
    ):
        if target and os.path.isdir(target):
            shortcuts.append({"label": label, "path": os.path.realpath(target)})
    result["shortcuts"] = shortcuts
    return jsonify(result)


@api.get("/config")
def get_config():
    """Configuracao do servidor que a interface precisa conhecer: a pasta de
    logs padrao (dentro do container e um volume montado do host) e onde as
    capturas sao gravadas."""
    return jsonify({
        "default_root": os.environ.get("LOG_ROOT") or "",
        "capture_root": devices.DEFAULT_CAPTURE_ROOT,
        "adb": devices.adb_path(),
        "adb_host": devices.ADB_HOST,
        "in_container": os.path.exists("/.dockerenv"),
    })


@api.get("/saved_filters")
def get_saved_filters():
    """Filtros salvos, compartilhados entre TODAS as distribuicoes (web, Mac,
    Windows): ficam num arquivo no backend, nao no localStorage do navegador
    (que e proprio de cada origem/webview e por isso nao seria o mesmo entre
    a versao web e a versao desktop, mesmo conversando com o mesmo servidor)."""
    return jsonify({"filters": prefs.load_saved_filters()})


@api.put("/saved_filters")
def put_saved_filters():
    body = request.get_json(silent=True)
    if not isinstance(body, list):
        return jsonify({"error": "Corpo precisa ser uma lista de filtros."}), 400
    try:
        prefs.save_saved_filters(body)
    except (OSError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "count": len(body)})


@api.get("/project_entries")
def get_project_entries():
    """Pastas/arquivos extras fixados na barra lateral, cada um com sua
    propria raiz (podem estar em qualquer lugar do disco). Compartilhado
    entre distribuicoes do mesmo jeito que /api/saved_filters."""
    return jsonify({"entries": prefs.load_project_entries()})


@api.put("/project_entries")
def put_project_entries():
    body = request.get_json(silent=True)
    if not isinstance(body, list):
        return jsonify({"error": "Corpo precisa ser uma lista de entradas."}), 400

    entries = []
    for item in body:
        if not isinstance(item, dict) or not item.get("path"):
            continue
        path = os.path.realpath(os.path.expanduser(item["path"]))
        if not os.path.exists(path) or not os.access(path, os.R_OK):
            continue
        entries.append({"path": path, "is_dir": os.path.isdir(path)})

    try:
        prefs.save_project_entries(entries)
    except (OSError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "entries": entries})


@api.get("/hidden_paths")
def get_hidden_paths():
    """Caminhos removidos da barra lateral (sem apagar do disco)."""
    return jsonify({"paths": prefs.load_hidden_paths()})


@api.put("/hidden_paths")
def put_hidden_paths():
    body = request.get_json(silent=True)
    if not isinstance(body, list) or not all(isinstance(p, str) for p in body):
        return jsonify({"error": "Corpo precisa ser uma lista de caminhos."}), 400
    try:
        prefs.save_hidden_paths(body)
    except (OSError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "count": len(body)})


@api.get("/usb_devices")
def get_usb_devices():
    """Aparelhos Android ligados na USB, com o que identifica cada um."""
    try:
        found = devices.list_devices()
    except devices.AdbError as e:
        return jsonify({"error": str(e), "adb": devices.adb_path()}), 400

    out = []
    for dev in found:
        try:
            out.append(devices.describe(dev["serial"]))
        except devices.AdbError as e:
            out.append({**dev, "identity": None, "error": str(e)})
    return jsonify({
        "devices": out,
        "adb": devices.adb_path(),
        "labels": devices.IDENTITY_LABELS,
        "capture_root": devices.DEFAULT_CAPTURE_ROOT,
    })


@api.post("/usb_capture")
def post_usb_capture():
    """Despeja os logs de um aparelho numa pasta so dele, para ser aberta como
    qualquer outra pasta de log."""
    serial = (request.args.get("serial") or "").strip()
    with_bugreport = request.args.get("bugreport", "false").lower() == "true"
    root = request.args.get("dest") or None
    buffers = [b for b in request.args.get("buffers", "").split(",") if b] or None

    try:
        result = devices.capture(serial, root=root, with_bugreport=with_bugreport,
                                 buffers=buffers)
    except devices.AdbError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        return jsonify({"error": f"Erro gravando a captura: {e}"}), 500
    return jsonify(result)


@api.get("/live_status")
def get_live_status():
    """Estado das coletas ao vivo em andamento."""
    try:
        return jsonify({"sessions": devices.live_status(
            request.args.get("serial") or None)})
    except devices.AdbError as e:
        return jsonify({"error": str(e)}), 400


@api.post("/live")
def post_live():
    """Comanda a coleta ao vivo: iniciar, pausar, retomar, parar ou reiniciar."""
    action = (request.args.get("action") or "").strip()
    serial = (request.args.get("serial") or "").strip()
    try:
        if action == "start":
            result = devices.live_start(
                serial,
                filterspec=request.args.get("filter"),
                buffers=[b for b in request.args.get("buffers", "").split(",") if b],
            )
        elif action == "pause":
            result = devices.live_pause(serial)
        elif action == "resume":
            result = devices.live_resume(serial)
        elif action == "stop":
            result = devices.live_stop(serial)
        elif action == "restart":
            devices.live_stop(serial)
            result = devices.live_start(
                serial,
                filterspec=request.args.get("filter"),
                buffers=[b for b in request.args.get("buffers", "").split(",") if b],
            )
        else:
            return jsonify({"error": f"Acao desconhecida: {action!r}"}), 400
    except devices.AdbError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        return jsonify({"error": f"Erro na coleta: {e}"}), 500
    return jsonify(result or {"serial": serial, "state": "encerrada"})


@api.get("/glossary")
def get_glossary():
    """Siglas de log do Android (PID, TID, UID, niveis, AMS/WMS/PMS, ANR, OOM...)."""
    return jsonify(glossary.as_dict())


@api.get("/device_info")
def get_device_info():
    """Extrai e classifica as informacoes de hardware e software presentes nos
    arquivos do escopo, para alimentar a aba lateral 'Dispositivo'."""
    root = request.args.get("root", "")
    scope = request.args.get("scope", "explicit")
    max_lines = request.args.get("max_lines", deviceinfo.DEFAULT_MAX_LINES, type=int)

    try:
        rel_paths, files_truncated = _resolve_scope_rel_paths(root, scope, request.args, 40)
    except PathError as e:
        return jsonify({"error": str(e)}), 400

    if not rel_paths:
        return jsonify({"error": "Nenhum arquivo no escopo informado."}), 400

    entries = []
    try:
        for rel in rel_paths:
            full_path = resolve_within_root(root, rel)
            if os.path.isdir(full_path):
                continue
            try:
                encoding = detect_encoding(full_path)
                entries.append((rel, full_path, encoding, cached_format(full_path, encoding)))
            except OSError:
                continue
    except PathError as e:
        return jsonify({"error": str(e)}), 400

    if not entries:
        return jsonify({"error": "Nenhum arquivo legivel no escopo informado."}), 400

    try:
        if len(entries) == 1:
            rel, full_path, encoding, log_format = entries[0]
            report = deviceinfo.analyze(
                full_path, encoding, max_lines=max_lines,
                log_format=log_format, file_label=rel,
            )
            report["files_used"] = [rel]
        else:
            report = deviceinfo.analyze_many(entries, max_lines=max_lines)
    except (OSError, UnicodeError) as e:
        return jsonify({"error": f"Erro analisando arquivos: {e}"}), 500

    report["files_truncated"] = files_truncated
    report["scope"] = scope
    return jsonify(report)


@api.get("/log_fields")
def get_log_fields():
    """Descobre valores reais de tag/pid/uid/level nos arquivos do escopo
    informado, para popular os filtros avancados de busca (estilo Android
    Studio Logcat / Splunk field sidebar)."""
    root = request.args.get("root", "")
    scope = request.args.get("scope", "explicit")

    try:
        rel_paths, files_truncated = _resolve_scope_rel_paths(root, scope, request.args, 15)
    except PathError as e:
        return jsonify({"error": str(e)}), 400

    if not rel_paths:
        return jsonify({"error": "Nenhum arquivo no escopo informado."}), 400

    tag_totals, pid_totals, uid_totals, tid_totals = {}, {}, {}, {}
    levels = set()
    lines_scanned = 0
    lines_parsed = 0
    files_used = 0

    try:
        for rel in rel_paths:
            full_path = resolve_within_root(root, rel)
            if os.path.isdir(full_path):
                continue
            try:
                encoding = detect_encoding(full_path)
                r = scan_fields(full_path, encoding)
            except (OSError, UnicodeError):
                continue
            files_used += 1
            lines_scanned += r["lines_scanned"]
            lines_parsed += r["lines_parsed"]
            levels |= set(r["levels"])
            for t in r["tags"]:
                tag_totals[t] = tag_totals.get(t, 0) + 1
            for p in r["pids"]:
                pid_totals[p] = pid_totals.get(p, 0) + 1
            for u in r["uids"]:
                uid_totals[u] = uid_totals.get(u, 0) + 1
            for t in r["tids"]:
                tid_totals[t] = tid_totals.get(t, 0) + 1
    except PathError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({
        "files_used": files_used,
        "files_truncated": files_truncated,
        "lines_scanned": lines_scanned,
        "lines_parsed": lines_parsed,
        "tags": sorted(tag_totals, key=lambda k: (-tag_totals[k], k))[:300],
        "pids": sorted(pid_totals, key=lambda k: (-pid_totals[k], int(k)))[:300],
        "tids": sorted(tid_totals, key=lambda k: (-tid_totals[k], k))[:300],
        "uids": sorted(uid_totals, key=lambda k: (-uid_totals[k], k))[:300],
        "levels": sorted(levels),
    })
