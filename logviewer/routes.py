import os

from flask import Blueprint, jsonify, request

from . import deviceinfo
from .fsops import PathError, list_tree, resolve_within_root
from .logline import scan_fields
from .reader import cached_format, detect_encoding, read_file
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
