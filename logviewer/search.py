import fnmatch
import os
import re

from .fsops import guess_ext_is_text, resolve_root, sniff_is_text
from .logline import line_matches_fields, parse_logcat_line
from .reader import cached_format, detect_encoding

DEFAULT_MAX_RESULTS = 500
MAX_MAX_RESULTS = 200_000
MAX_LINES_SCANNED = 20_000_000  # safety cap per file (well above any single file in real bug-report dumps)
DEFAULT_MAX_FILES = 300
MAX_MAX_FILES = 2000


class RegexError(ValueError):
    pass


def compile_pattern(pattern, flags):
    if not pattern:
        return None
    re_flags = 0
    for f in flags or []:
        if f == "i":
            re_flags |= re.IGNORECASE
        elif f == "m":
            re_flags |= re.MULTILINE
        elif f == "s":
            re_flags |= re.DOTALL
    try:
        return re.compile(pattern, re_flags)
    except re.error as e:
        raise RegexError(f"Regex invalida: {e}")


def search_file(path, compiled, max_results, context, field_filters=None):
    if not sniff_is_text(path):
        return {"file": path, "binary": True, "matches": []}

    has_field_filters = bool(field_filters and any(field_filters.values()))
    encoding = detect_encoding(path)
    log_format = cached_format(path, encoding)
    matches = []
    buffer = []  # rolling buffer of recent lines for "before" context

    with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
        for line_number, raw_line in enumerate(f, start=1):
            line = raw_line.rstrip("\n").rstrip("\r")
            buffer.append(line)
            if len(buffer) > context + 1:
                buffer.pop(0)

            if line_number > MAX_LINES_SCANNED:
                return {"file": path, "binary": False, "matches": matches, "truncated": True}

            parsed = None
            if has_field_filters:
                parsed = parse_logcat_line(line, log_format)
                if not line_matches_fields(parsed, **field_filters):
                    continue

            if compiled is not None:
                m = compiled.search(line)
                if not m:
                    continue
                span = [m.start(), m.end()]
            else:
                span = [0, 0]

            if parsed is None:
                parsed = parse_logcat_line(line, log_format)  # so-so cost: only for actual matches, used for UI badges

            before = buffer[:-1]
            after = []
            if context:
                for _ in range(context):
                    nxt = f.readline()
                    if not nxt:
                        break
                    after.append(nxt.rstrip("\n").rstrip("\r"))

            matches.append({
                "line_number": line_number,
                "line": line,
                "match_span": span,
                "context_before": before,
                "context_after": after,
                "level": parsed["level"] if parsed else None,
                "tag": parsed["tag"] if parsed else None,
                "pid": parsed["pid"] if parsed else None,
                "tid": parsed["tid"] if parsed else None,
                "uid": parsed["uid"] if parsed else None,
                "time": parsed["time"] if parsed else None,
                "msg": parsed["msg"] if parsed else None,
            })

            if len(matches) >= max_results:
                return {"file": path, "binary": False, "matches": matches, "truncated": True}

    return {"file": path, "binary": False, "matches": matches, "truncated": False}


def search_files(root_files, pattern, flags, max_results, context, total_max_results=None, field_filters=None):
    compiled = compile_pattern(pattern, flags)
    if compiled is None and not (field_filters and any(field_filters.values())):
        raise RegexError("Informe um padrao de busca ou pelo menos um filtro avancado (nivel/tag/pid/uid).")
    max_results = max(1, min(max_results, MAX_MAX_RESULTS))
    context = max(0, min(context, 20))
    budget = max(1, min(total_max_results or max_results, MAX_MAX_RESULTS))

    results = []
    total = 0
    for path in root_files:
        remaining = budget - total
        if remaining <= 0:
            results.append({"file": path, "binary": False, "matches": [], "truncated": False, "skipped": True})
            continue
        r = search_file(path, compiled, min(max_results, remaining), context, field_filters)
        total += len(r["matches"])
        results.append(r)
    return results, total


def gather_folder_files(root, glob_patterns=None, max_files=DEFAULT_MAX_FILES):
    """Walk root recursively, returning relative paths of files that look like text
    and match glob_patterns (comma-split patterns like '*.log'), up to max_files."""
    real_root = resolve_root(root)
    patterns = [p.strip() for p in (glob_patterns or []) if p.strip()] or ["*"]
    max_files = max(1, min(max_files, MAX_MAX_FILES))

    results = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(real_root, followlinks=False):
        dirnames.sort()
        filenames.sort()
        for name in filenames:
            ext = os.path.splitext(name)[1]
            if guess_ext_is_text(ext) is False:
                continue
            if not any(fnmatch.fnmatch(name.lower(), p.lower()) for p in patterns):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, real_root)
            results.append(rel)
            if len(results) >= max_files:
                truncated = True
                break
        if truncated:
            break
    return results, truncated
