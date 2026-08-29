import re
from collections import Counter

# Formato "threadtime" do logcat Android, com ou sem a coluna de UID que o
# dumpstate/bugreport da Samsung inclui. Exemplos reais observados na pasta de logs:
#   08-28 21:20:09.064  1000  3154  4048 D BackgroundInstallControlService: msg
#   08-28 21:20:09.067 radio 19523 19523 E ActivityThread: msg
# Campos: data hora UID PID TID NIVEL TAG: mensagem
# O UID pode vir numerico (1000) ou como nome simbolico de AID reservado do
# Android (radio, system, bluetooth, wifi, shell, root, ...).

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

_DATE_TIME = r"\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+"

_UID_RE = re.compile(
    _DATE_TIME
    + r"(?P<uid>\S+)\s+(?P<pid>\d+)\s+(?P<tid>\d+)\s+"
    + r"(?P<level>[VDIWEFAS])\s+(?P<tag>[^:]*?)\s*:\s?(?P<msg>.*)$"
)
_NOUID_RE = re.compile(
    _DATE_TIME
    + r"(?P<pid>\d+)\s+(?P<tid>\d+)\s+"
    + r"(?P<level>[VDIWEFAS])\s+(?P<tag>[^:]*?)\s*:\s?(?P<msg>.*)$"
)

MAX_FIELD_SCAN_LINES = 300_000
MAX_DISTINCT_VALUES = 300


def parse_logcat_line(line):
    """Extrai uid/pid/tid/level/tag/msg de uma linha no formato threadtime do
    logcat Android. Retorna None se a linha nao seguir esse formato (a maioria
    dos arquivos da pasta nao segue - xml, csv, texto livre, etc)."""
    m = _UID_RE.match(line)
    if m:
        d = m.groupdict()
        return d
    m = _NOUID_RE.match(line)
    if m:
        d = m.groupdict()
        d["uid"] = None
        return d
    return None


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
    """Varre um arquivo e conta valores distintos de tag/pid/uid/level, para
    popular os filtros avancados na UI com o que realmente existe no arquivo."""
    tag_counts = Counter()
    pid_counts = Counter()
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
            parsed = parse_logcat_line(line)
            if not parsed:
                continue
            lines_parsed += 1
            tag_counts[parsed["tag"]] += 1
            pid_counts[parsed["pid"]] += 1
            if parsed["uid"]:
                uid_counts[parsed["uid"]] += 1
            level_counts[parsed["level"]] += 1

    return {
        "lines_scanned": lines_scanned,
        "lines_parsed": lines_parsed,
        "tags": [t for t, _ in tag_counts.most_common(MAX_DISTINCT_VALUES)],
        "pids": [p for p, _ in pid_counts.most_common(MAX_DISTINCT_VALUES)],
        "uids": [u for u, _ in uid_counts.most_common(MAX_DISTINCT_VALUES)],
        "levels": sorted(level_counts.keys()),
    }
