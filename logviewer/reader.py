import itertools
import os

from .fsops import sniff_is_text

DEFAULT_LIMIT = 500
MAX_LIMIT = 5000
TAIL_CHUNK_SIZE = 65536


def detect_encoding(path, sample_size=65536):
    with open(path, "rb") as f:
        sample = f.read(sample_size)
    try:
        sample.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "latin-1"


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


def read_file(path, offset=0, limit=DEFAULT_LIMIT, tail=False):
    limit = max(1, min(limit, MAX_LIMIT))

    if not sniff_is_text(path):
        return {
            "binary": True,
            "lines": [],
            "offset": 0,
            "returned": 0,
            "has_more": False,
            "size": os.path.getsize(path),
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
        }

    encoding = detect_encoding(path)

    if tail:
        raw_lines = _tail_lines_bytes(path, limit)
        lines = [ln.decode(encoding, errors="replace") for ln in raw_lines]
        return {
            "binary": False,
            "lines": lines,
            "offset": None,
            "returned": len(lines),
            "has_more": None,  # unknown without a full line count on large files
            "size": size,
            "encoding": encoding,
            "mode": "tail",
        }

    with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
        window = list(itertools.islice(f, offset, offset + limit))
        next_line = f.readline()
    lines = [ln.rstrip("\n").rstrip("\r") for ln in window]
    return {
        "binary": False,
        "lines": lines,
        "offset": offset,
        "returned": len(lines),
        "has_more": bool(next_line),
        "size": size,
        "encoding": encoding,
        "mode": "range",
    }
