import itertools
import os

from .fsops import sniff_is_text
from .logline import detect_format, parse_lines

DEFAULT_LIMIT = 500
MAX_LIMIT = 20000
TAIL_CHUNK_SIZE = 65536
COUNT_CHUNK_SIZE = 4 * 1024 * 1024

# Contagem de linhas e deteccao de formato sao caras em arquivos de milhoes de
# linhas e nao mudam enquanto o arquivo nao muda; a chave inclui tamanho e mtime.
_line_count_cache = {}
_format_cache = {}
_CACHE_MAX = 256


def _stat_key(path):
    st = os.stat(path)
    return (os.path.realpath(path), st.st_size, int(st.st_mtime_ns))


def _cache_get(cache, key):
    return cache.get(key)


def _cache_put(cache, key, value):
    if len(cache) >= _CACHE_MAX:
        cache.clear()
    cache[key] = value
    return value


def detect_encoding(path, sample_size=65536):
    with open(path, "rb") as f:
        sample = f.read(sample_size)
    try:
        sample.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "latin-1"


def count_lines(path):
    """Numero de linhas do arquivo, contado em blocos binarios (rapido o
    bastante para arquivos de varios GB) e memorizado por tamanho/mtime."""
    key = _stat_key(path)
    cached = _cache_get(_line_count_cache, key)
    if cached is not None:
        return cached

    total = 0
    last_byte = b"\n"
    with open(path, "rb") as f:
        while True:
            chunk = f.read(COUNT_CHUNK_SIZE)
            if not chunk:
                break
            total += chunk.count(b"\n")
            last_byte = chunk[-1:]
    # Ultima linha sem quebra no final ainda e uma linha.
    if last_byte not in (b"\n", b""):
        total += 1
    return _cache_put(_line_count_cache, key, total)


def cached_format(path, encoding):
    """Formato de logcat dominante do arquivo, memorizado por tamanho/mtime."""
    key = _stat_key(path)
    cached = _cache_get(_format_cache, key)
    if cached is not None:
        return cached[0]
    fmt = detect_format(path, encoding)
    _cache_put(_format_cache, key, (fmt,))
    return fmt


def _tail_lines_bytes(path, n):
    """Read the last n lines of a file without loading it entirely into memory."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        file_size = f.tell()
        blocks = []
        remaining = file_size
        lines_found = 0
        while remaining > 0 and lines_found <= n:
            read_size = min(TAIL_CHUNK_SIZE, remaining)
            remaining -= read_size
            f.seek(remaining)
            chunk = f.read(read_size)
            blocks.append(chunk)
            lines_found += chunk.count(b"\n")
        data = b"".join(reversed(blocks))
    lines = data.splitlines()
    return lines[-n:] if n else []


def _columns(lines, log_format):
    """Campos de logcat de cada linha, na ordem das linhas recebidas."""
    parsed = parse_lines(lines, log_format)
    cols = []
    for p in parsed:
        if p is None:
            cols.append(None)
        else:
            cols.append({
                "time": p["time"], "uid": p["uid"], "pid": p["pid"],
                "tid": p["tid"], "level": p["level"], "tag": p["tag"],
                "msg": p["msg"],
            })
    return cols


def read_file(path, offset=0, limit=DEFAULT_LIMIT, tail=False, parse=True):
    limit = max(1, min(limit, MAX_LIMIT))
    offset = max(0, offset)

    if not sniff_is_text(path):
        return {
            "binary": True,
            "lines": [],
            "offset": 0,
            "returned": 0,
            "has_more": False,
            "size": os.path.getsize(path),
            "total_lines": 0,
        }

    size = os.path.getsize(path)
    if size == 0:
        return {
            "binary": False,
            "lines": [],
            "offset": 0,
            "returned": 0,
            "has_more": False,
            "size": 0,
            "encoding": "utf-8",
            "total_lines": 0,
            "mode": "range",
        }

    encoding = detect_encoding(path)
    total_lines = count_lines(path)
    log_format = cached_format(path, encoding) if parse else None

    if tail:
        raw_lines = _tail_lines_bytes(path, limit)
        lines = [ln.decode(encoding, errors="replace") for ln in raw_lines]
        # Com a contagem total em maos, o tail tambem numera as linhas de forma
        # absoluta, em vez de deixar a coluna em branco.
        start = max(0, total_lines - len(lines))
        return {
            "binary": False,
            "lines": lines,
            "columns": _columns(lines, log_format) if parse else None,
            "offset": start,
            "returned": len(lines),
            "has_more": False,
            "size": size,
            "encoding": encoding,
            "total_lines": total_lines,
            "format": log_format,
            "mode": "tail",
        }

    with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
        window = list(itertools.islice(f, offset, offset + limit))
    lines = [ln.rstrip("\n").rstrip("\r") for ln in window]
    return {
        "binary": False,
        "lines": lines,
        "columns": _columns(lines, log_format) if parse else None,
        "offset": offset,
        "returned": len(lines),
        "has_more": offset + len(lines) < total_lines,
        "size": size,
        "encoding": encoding,
        "total_lines": total_lines,
        "format": log_format,
        "mode": "range",
    }
