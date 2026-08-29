"""Parser de linhas de log do Android (logcat) em multiplos formatos.

Cobre os mesmos formatos que o LogcatOfflineView (androidlogcatviewer) aceita,
mais as variantes com coluna de UID e com ano que aparecem em dumpstate/bugreport
de aparelhos recentes:

    threadtime_uid  08-28 21:20:09.064  1000  3154  4048 D Tag: msg
    threadtime      04-08 12:57:40.370    89   103 I Tag: msg
    ddms            04-08 12:57:40.370: INFO/Tag( 1234): msg
    time            04-08 12:57:40.370 I/Tag( 1234): msg
    long            [ 04-08 12:57:40.370  1234:0x1a2 I/Tag ]  (msg nas linhas seguintes)
    brief           I/Tag( 1234): msg
    thread          I( 1234:0x1a2) msg
    process         I( 1234) msg
    tag             I/Tag: msg
"""

import re
from collections import Counter

LEVEL_NAMES = {
    "V": "VERBOSE",
    "D": "DEBUG",
    "I": "INFO",
    "W": "WARN",
    "E": "ERROR",
    "F": "FATAL",
    "A": "ASSERT",
    "S": "SILENT",
}

# Nomes por extenso usados pelo formato de "save log" do DDMS.
_LEVEL_FROM_NAME = {
    "VERBOSE": "V",
    "DEBUG": "D",
    "INFO": "I",
    "WARN": "W",
    "WARNING": "W",
    "ERROR": "E",
    "FATAL": "F",
    "ASSERT": "A",
    "SILENT": "S",
}

# Timestamp do logcat: "04-08 12:57:40.370" ou "2026-04-08 12:57:40.370"
# (Android 12+ pode emitir o ano; a fracao de segundo varia de 1 a 6 digitos).
_TS = r"(?:\d{4}-)?\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}[.,]\d{1,6}"

# UID pode vir numerico (1000) ou como nome simbolico de AID reservado do
# Android (radio, system, bluetooth, wifi, shell, root, u0_a123, ...).
_UID = r"\d+|[A-Za-z_][\w.]*"

_FORMATS = (
    ("threadtime_uid", re.compile(
        rf"^(?P<time>{_TS})\s+(?P<uid>{_UID})\s+(?P<pid>\d+)\s+(?P<tid>\d+)\s+"
        r"(?P<level>[VDIWEFAS])\s+(?P<tag>.*?)\s*:\s?(?P<msg>.*)$")),
    ("threadtime", re.compile(
        rf"^(?P<time>{_TS})\s+(?P<pid>\d+)\s+(?P<tid>\d+)\s+"
        r"(?P<level>[VDIWEFAS])\s+(?P<tag>.*?)\s*:\s?(?P<msg>.*)$")),
    ("ddms", re.compile(
        rf"^(?P<time>{_TS}):?\s+"
        r"(?P<level>VERBOSE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|ASSERT)/(?P<tag>.*?)"
        r"\(\s*(?P<pid>\d+)\):\s?(?P<msg>.*)$")),
    ("time", re.compile(
        rf"^(?P<time>{_TS}):?\s+"
        r"(?P<level>[VDIWEFAS])/(?P<tag>.*?)\(\s*(?P<pid>\d+)\):\s?(?P<msg>.*)$")),
    ("long", re.compile(
        rf"^\[\s*(?P<time>{_TS})\s+(?P<pid>\d+):\s*(?P<tid>\S+)\s+"
        r"(?P<level>[VDIWEFAS])/(?P<tag>.*?)\s*\]$")),
    ("brief", re.compile(
        r"^(?P<level>[VDIWEFAS])/(?P<tag>.*?)\(\s*(?P<pid>\d+)\):\s?(?P<msg>.*)$")),
    ("thread", re.compile(
        r"^(?P<level>[VDIWEFAS])\(\s*(?P<pid>\d+):(?P<tid>0x[0-9a-fA-F]+)\)\s+(?P<msg>.*)$")),
    ("process", re.compile(
        r"^(?P<level>[VDIWEFAS])\(\s*(?P<pid>\d+)\)\s+(?P<msg>.*)$")),
    ("tag", re.compile(
        r"^(?P<level>[VDIWEFAS])/(?P<tag>[^:()]*?)\s*:\s?(?P<msg>.*)$")),
)

_FORMATS_BY_NAME = dict(_FORMATS)

# Marcadores que o logcat intercala entre buffers.
_BUFFER_MARKER = re.compile(r"^-+\s*beginning of (?P<buffer>\S+)", re.IGNORECASE)

MAX_FIELD_SCAN_LINES = 300_000
MAX_DISTINCT_VALUES = 300
FORMAT_SCAN_LINES = 400_000
FORMAT_ENOUGH_MATCHES = 200

_EMPTY = {
    "time": None, "uid": None, "pid": None, "tid": None,
    "level": None, "tag": None, "msg": None, "fmt": None,
}


def _build(match, fmt):
    d = dict(_EMPTY)
    d.update(match.groupdict())
    d["fmt"] = fmt
    level = d.get("level")
    if level and len(level) > 1:
        d["level"] = _LEVEL_FROM_NAME.get(level.upper(), level[0].upper())
    return d


def parse_logcat_line(line, prefer=None):
    """Extrai time/uid/pid/tid/level/tag/msg de uma linha de logcat em qualquer
    formato suportado. Retorna None se a linha nao for logcat (a maioria dos
    arquivos de um bugreport nao e: xml, csv, dumpsys, texto livre, etc).

    `prefer` e o nome de um formato a ser tentado primeiro; passar o formato
    dominante do arquivo evita percorrer a lista toda em cada linha."""
    if not line:
        return None
    if prefer:
        pat = _FORMATS_BY_NAME.get(prefer)
        if pat is not None:
            m = pat.match(line)
            if m:
                return _build(m, prefer)
    for fmt, pat in _FORMATS:
        if fmt == prefer:
            continue
        m = pat.match(line)
        if m:
            return _build(m, fmt)
    return None


def buffer_marker(line):
    """Retorna o nome do buffer ('main', 'events', 'radio', ...) quando a linha
    e um marcador '--------- beginning of main'."""
    m = _BUFFER_MARKER.match(line or "")
    return m.group("buffer") if m else None


def detect_format(path, encoding, max_lines=FORMAT_SCAN_LINES,
                  enough=FORMAT_ENOUGH_MATCHES):
    """Descobre o formato de logcat dominante do arquivo, ou None se ele nao
    parecer logcat.

    A busca nao pode parar nas primeiras linhas: num bugreport o logcat so
    comeca depois de dezenas de milhares de linhas de cabecalho, propriedades e
    dumpsys. Antes disso a deteccao devolvia None e cada linha do arquivo
    passava a tentar os nove padroes, o que deixava toda leitura e filtro
    varias vezes mais lentos. Entao varremos ate juntar `enough` linhas
    reconhecidas, e so desistimos depois de `max_lines`."""
    counts = Counter()
    found = 0
    try:
        with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
            for i, raw in enumerate(f):
                if i >= max_lines or found >= enough:
                    break
                parsed = parse_logcat_line(raw.rstrip("\n").rstrip("\r"))
                if parsed:
                    counts[parsed["fmt"]] += 1
                    found += 1
    except OSError:
        return None
    if not counts:
        return None
    return counts.most_common(1)[0][0]


def parse_lines(lines, prefer=None):
    """Parseia uma sequencia de linhas mantendo o estado necessario para o
    formato 'long', em que o cabecalho e a mensagem ficam em linhas separadas.
    Devolve uma lista do mesmo tamanho de `lines` (None onde nao houve match)."""
    out = []
    pending = None  # cabecalho 'long' aguardando a linha de mensagem
    for line in lines:
        if pending is not None:
            if line.strip():
                filled = dict(pending)
                filled["msg"] = line
                out[-1] = None  # o cabecalho sozinho nao vira linha visivel
                out.append(filled)
                pending = None
                continue
            pending = None
        parsed = parse_logcat_line(line, prefer)
        if parsed and parsed["fmt"] == "long":
            pending = parsed
        out.append(parsed)
    return out


def line_matches_fields(parsed, levels=None, tags=None, pids=None, uids=None):
    if parsed is None:
        return False
    if levels and parsed["level"] not in levels:
        return False
    if tags and parsed["tag"] not in tags:
        return False
    if pids and parsed["pid"] not in pids:
        return False
    if uids and parsed["uid"] not in uids:
        return False
    return True


def scan_fields(path, encoding, max_lines=MAX_FIELD_SCAN_LINES):
    """Varre um arquivo e conta valores distintos de tag/pid/tid/uid/level, para
    popular os filtros avancados na UI com o que realmente existe no arquivo."""
    prefer = detect_format(path, encoding)
    tag_counts = Counter()
    pid_counts = Counter()
    tid_counts = Counter()
    uid_counts = Counter()
    level_counts = Counter()
    lines_scanned = 0
    lines_parsed = 0

    with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
        for i, raw in enumerate(f):
            if i >= max_lines:
                break
            lines_scanned += 1
            line = raw.rstrip("\n").rstrip("\r")
            parsed = parse_logcat_line(line, prefer)
            if not parsed:
                continue
            lines_parsed += 1
            if parsed["tag"]:
                tag_counts[parsed["tag"]] += 1
            if parsed["pid"]:
                pid_counts[parsed["pid"]] += 1
            if parsed["tid"]:
                tid_counts[parsed["tid"]] += 1
            if parsed["uid"]:
                uid_counts[parsed["uid"]] += 1
            if parsed["level"]:
                level_counts[parsed["level"]] += 1

    return {
        "format": prefer,
        "lines_scanned": lines_scanned,
        "lines_parsed": lines_parsed,
        "tags": [t for t, _ in tag_counts.most_common(MAX_DISTINCT_VALUES)],
        "pids": [p for p, _ in pid_counts.most_common(MAX_DISTINCT_VALUES)],
        "tids": [t for t, _ in tid_counts.most_common(MAX_DISTINCT_VALUES)],
        "uids": [u for u, _ in uid_counts.most_common(MAX_DISTINCT_VALUES)],
        "levels": sorted(level_counts.keys()),
        "level_counts": dict(level_counts),
    }
