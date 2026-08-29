"""Analises que percorrem o arquivo inteiro: linha do tempo, mapa de processos
e filtragem no servidor.

Todas guardam o resultado em cache por (caminho, tamanho, mtime), porque a
varredura de um arquivo de milhoes de linhas custa segundos e o arquivo nao
muda entre as consultas da UI.
"""

import json
import os
import re

from .logline import parse_logcat_line

MAX_SCAN_LINES = 8_000_000
DEFAULT_BUCKETS = 600
MAX_BUCKETS = 2000
MAX_EVENTS = 2000
MAX_FILTER_HITS = 2_000_000
_CACHE_MAX = 24

# ---------------------------------------------------------------------------
# Eventos notaveis
# ---------------------------------------------------------------------------
# A deteccao usa substring, nao regex: e uma verificacao por linha em arquivos
# de milhoes de linhas, e `in` e uma ordem de grandeza mais barato.

EVENT_KINDS = (
    ("crash", "Crash Java", ("FATAL EXCEPTION",)),
    ("anr", "ANR", ("ANR in ", "Input dispatching timed out")),
    ("native", "Crash nativo", ("*** *** ***", "Fatal signal ")),
    ("watchdog", "Watchdog", ("WATCHDOG", "Watchdog: ")),
    ("oom", "Falta de memoria", ("OutOfMemoryError", "lowmemorykiller", "Out of memory")),
    ("boot", "Boot", ("Boot completed", "boot completed")),
)

# Uma regex alternada faz a triagem em uma unica varredura em C, em vez de uma
# dezena de testes `in` por linha. Em arquivos de milhoes de linhas essa e a
# diferenca entre a analise levar segundos ou dezenas de segundos.
_EVENT_PROBE = re.compile(
    "|".join(re.escape(n) for _, _, needles in EVENT_KINDS for n in needles))

# needle -> tipo de evento, para classificar depois que a triagem acusou algo.
_NEEDLE_KIND = {
    needle: kind for kind, _, needles in EVENT_KINDS for needle in needles
}


def _classify_event(line, probe_match=None):
    if probe_match is not None:
        return _NEEDLE_KIND.get(probe_match.group(0))
    m = _EVENT_PROBE.search(line)
    return _NEEDLE_KIND.get(m.group(0)) if m else None


# ---------------------------------------------------------------------------
# PID -> nome do processo
# ---------------------------------------------------------------------------
# Cada regra e (regex, grupo_do_pid, grupo_do_nome, grupo_do_uid ou None).

PROC_RULES = (
    # ActivityManager: Start proc 3154:com.whatsapp/u0a123 for activity ...
    (re.compile(r"Start proc (\d+):([\w.:@-]+)/(\S+)"), 1, 2, 3),
    # Formato antigo: Start proc com.whatsapp for broadcast ...: pid=3154 uid=10123
    (re.compile(r"Start proc ([\w.:@-]+) for [^:]*: pid=(\d+) uid=(\d+)"), 2, 1, 3),
    # Buffer de events: am_proc_start: [userId,pid,uid,processName,...]
    (re.compile(r"am_proc_start:\s*\[\d+,(\d+),(\d+),([\w.:@-]+)"), 1, 3, 2),
    (re.compile(r"am_proc_bound:\s*\[\d+,(\d+),([\w.:@-]+)"), 1, 2, None),
    (re.compile(r"am_proc_died:\s*\[\d+,(\d+),([\w.:@-]+)"), 1, 2, None),
    (re.compile(r"am_kill:\s*\[\d+,(\d+),([\w.:@-]+)"), 1, 2, None),
    # ActivityManager: Killing 3154:com.whatsapp/u0a123 (adj 900): empty
    (re.compile(r"Killing (\d+):([\w.:@-]+)/(\S+?)[\s(]"), 1, 2, 3),
    # Process com.whatsapp (pid 3154) has died
    (re.compile(r"Process ([\w.:@-]+) \(pid (\d+)\)"), 2, 1, None),
    # DEBUG/tombstone: pid: 3154, tid: 3154, name: main  >>> com.whatsapp <<<
    (re.compile(r"pid: (\d+), tid: \d+.*>>> ([\w.:@-]+) <<<"), 1, 2, None),
)

# Triagem barata antes de rodar as nove regras acima em cada linha.
_PROC_PROBE = re.compile(r"proc |Proc |pid |pid:|Killing ")

# Secao "ps" do bugreport: USER PID PPID VSZ RSS WCHAN ADDR S NAME
# O estado e uma letra do conjunto do /proc; exigi-la evita casar com outras
# tabelas do bugreport. Nomes sem ponto valem (system_server, init, zygote64).
_PS_RE = re.compile(
    r"^(?P<uid>[\w_]+)\s+(?P<pid>\d+)\s+\d+\s+\d+\s+\d+\s+\S+\s+\S+\s+"
    r"(?P<state>[RSDZTtWXxKP])\s+(?P<name>[\w./:@\[\]+-]+)\s*$"
)


class _Cache:
    """Cache pequeno por (caminho, tamanho, mtime) — o arquivo nao muda entre
    as consultas da UI, e cada varredura custa segundos."""

    def __init__(self):
        self._data = {}

    def key(self, path, extra=None):
        st = os.stat(path)
        return (os.path.realpath(path), st.st_size, int(st.st_mtime_ns), extra)

    def get(self, key):
        return self._data.get(key)

    def put(self, key, value):
        if len(self._data) >= _CACHE_MAX:
            self._data.clear()
        self._data[key] = value
        return value


_timeline_cache = _Cache()
_proc_cache = _Cache()
_filter_cache = _Cache()


# ---------------------------------------------------------------------------
# Linha do tempo (mapa de calor do arquivo inteiro)
# ---------------------------------------------------------------------------

def timeline(path, encoding, log_format, total_lines, buckets=DEFAULT_BUCKETS):
    """Divide o arquivo em faixas de linhas e conta niveis e eventos em cada
    uma, para desenhar a barra de navegacao do arquivo."""
    buckets = max(20, min(buckets, MAX_BUCKETS))
    key = _timeline_cache.key(path, ("timeline", buckets, log_format))
    cached = _timeline_cache.get(key)
    if cached is not None:
        return cached

    total = max(1, total_lines)
    counts = [None] * buckets
    events = []
    scanned = 0
    truncated = False

    with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
        for i, raw in enumerate(f):
            if i >= MAX_SCAN_LINES:
                truncated = True
                break
            scanned += 1
            b = min(buckets - 1, i * buckets // total)
            slot = counts[b]
            if slot is None:
                slot = counts[b] = {"levels": {}, "events": {}, "first_time": None, "n": 0}
            slot["n"] += 1

            line = raw.rstrip("\n").rstrip("\r")
            parsed = parse_logcat_line(line, log_format)
            if parsed:
                level = parsed["level"]
                if level:
                    slot["levels"][level] = slot["levels"].get(level, 0) + 1
                if slot["first_time"] is None and parsed["time"]:
                    slot["first_time"] = parsed["time"]

            probe = _EVENT_PROBE.search(line)
            if probe is not None:
                kind = _classify_event(line, probe)
                if kind:
                    slot["events"][kind] = slot["events"].get(kind, 0) + 1
                    if len(events) < MAX_EVENTS:
                        msg = (parsed["msg"] if parsed else line) or line
                        events.append({
                            "line": i + 1,
                            "kind": kind,
                            "time": parsed["time"] if parsed else None,
                            "tag": parsed["tag"] if parsed else None,
                            "pid": parsed["pid"] if parsed else None,
                            "text": msg[:200],
                        })

    out = []
    for b in range(buckets):
        slot = counts[b]
        start = b * total // buckets
        end = (b + 1) * total // buckets
        out.append({
            "i": b,
            "start_line": start + 1,
            "end_line": max(start + 1, end),
            "n": slot["n"] if slot else 0,
            "levels": slot["levels"] if slot else {},
            "events": slot["events"] if slot else {},
            "first_time": slot["first_time"] if slot else None,
        })

    return _timeline_cache.put(key, {
        "buckets": out,
        "events": events,
        "events_truncated": len(events) >= MAX_EVENTS,
        "lines_scanned": scanned,
        "truncated": truncated,
        "total_lines": total_lines,
    })


# ---------------------------------------------------------------------------
# Mapa PID -> processo
# ---------------------------------------------------------------------------

def process_map(path, encoding, log_format):
    """Descobre a que processo pertence cada PID, juntando as linhas em que o
    ActivityManager anuncia inicio/morte de processo e a secao 'ps' do
    bugreport. Sem isso a coluna PID e so um numero solto."""
    key = _proc_cache.key(path, ("procs", log_format))
    cached = _proc_cache.get(key)
    if cached is not None:
        return cached

    # {pid: {nome: contagem}} — um PID pode ser reaproveitado durante a captura,
    # entao contamos as evidencias e ficamos com a leitura mais frequente.
    names = {}
    uids = {}

    def record(pid, name, uid):
        if not pid or not name:
            return
        if name.isdigit() or len(name) > 128:
            return
        bucket = names.setdefault(pid, {})
        bucket[name] = bucket.get(name, 0) + 1
        if uid:
            uids.setdefault(pid, uid)

    # As regras abaixo sao especificas o bastante para rodar na linha crua; sem
    # o parse de logcat por linha a varredura fica cerca de tres vezes mais
    # rapida, o que importa em arquivos de milhoes de linhas.
    with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
        for i, raw in enumerate(f):
            if i >= MAX_SCAN_LINES:
                break
            line = raw.rstrip("\n").rstrip("\r")
            if not line:
                continue

            if _PROC_PROBE.search(line):
                for regex, g_pid, g_name, g_uid in PROC_RULES:
                    m = regex.search(line)
                    if m:
                        record(m.group(g_pid), m.group(g_name),
                               m.group(g_uid) if g_uid else None)
                        break
                continue

            # A secao ps do bugreport nao casa com nenhuma regra acima.
            m = _PS_RE.match(line)
            if m:
                record(m.group("pid"), m.group("name"), m.group("uid"))

    resolved = {
        pid: max(bucket.items(), key=lambda kv: kv[1])[0]
        for pid, bucket in names.items()
    }
    result = {
        "pids": resolved,
        "uids": uids,
        "count": len(resolved),
        # PIDs com mais de um nome indicam reuso de PID durante a captura.
        "ambiguous": sorted(p for p, b in names.items() if len(b) > 1),
    }
    return _proc_cache.put(key, result)


# ---------------------------------------------------------------------------
# Filtragem no servidor (o arquivo inteiro, nao so a pagina carregada)
# ---------------------------------------------------------------------------

class FilterSpec:
    """Filtro aplicavel linha a linha. Os campos de texto sao regex."""

    def __init__(self, levels=None, tag=None, text=None, pid=None, tid=None,
                 uid=None, raw=None, negate=False, case_sensitive=False):
        flags = 0 if case_sensitive else re.IGNORECASE
        self.flags = flags
        self.levels = set(levels or ())
        self.negate = bool(negate)
        self.tag = re.compile(tag, flags) if tag else None
        self.text = re.compile(text, flags) if text else None
        self.pid = re.compile(pid, flags) if pid else None
        self.tid = re.compile(tid, flags) if tid else None
        self.uid = re.compile(uid, flags) if uid else None
        # `raw` casa com a linha inteira, incluindo hora, PID e TAG. E o que um
        # termo digitado sem prefixo deve fazer: quem procura "Vold" espera
        # achar tanto no texto quanto na TAG. Em um bugreport a maior parte das
        # linhas nem e logcat, e so `raw` alcanca essas.
        self.raw = re.compile(raw, flags) if raw else None
        # Versao em bytes do padrao, usada quando o filtro so olha a linha crua:
        # evita decodificar centenas de MB so para descartar a maioria das
        # linhas. So vale para padroes ASCII, que e o caso de busca em log.
        self.raw_bytes = None
        self.raw_bytes_lower = None
        if raw and raw.isascii():
            try:
                self.raw_bytes = re.compile(raw.encode("ascii"), flags)
            except re.error:
                self.raw_bytes = None
            # Buscar sem diferenciar maiusculas custa caro: o motor de regex
            # refaz o dobramento de caixa a cada caractere. Passar o bloco para
            # minusculas de uma vez e comparar com o padrao ja minusculo e umas
            # seis vezes mais rapido, e bytes.lower() preserva o tamanho, entao
            # os deslocamentos continuam validos.
            # So vale sem barra invertida no padrao: minusculizar trocaria \W
            # por \w e mudaria o sentido.
            if self.raw_bytes is not None and flags & re.IGNORECASE and "\\" not in raw:
                try:
                    self.raw_bytes_lower = re.compile(raw.lower().encode("ascii"))
                except re.error:
                    self.raw_bytes_lower = None

    @property
    def empty(self):
        return not (self.levels or self.tag or self.text or self.raw
                    or self.pid or self.tid or self.uid)

    @property
    def needs_parse(self):
        """Se o filtro so olha a linha crua, da para pular o parse de logcat —
        que e o maior custo da varredura, ainda mais em arquivo de formato misto
        onde cada linha tenta os nove padroes antes de desistir."""
        return bool(self.levels or self.tag or self.pid
                    or self.tid or self.uid or self.text)

    def cache_key(self):
        return json.dumps({
            "levels": sorted(self.levels),
            "tag": self.tag.pattern if self.tag else None,
            "text": self.text.pattern if self.text else None,
            "pid": self.pid.pattern if self.pid else None,
            "tid": self.tid.pattern if self.tid else None,
            "uid": self.uid.pattern if self.uid else None,
            "raw": self.raw.pattern if self.raw else None,
            "negate": self.negate,
            "flags": self.flags,
        }, sort_keys=True)

    def matches(self, line, parsed):
        hit = self._raw_match(line, parsed)
        return (not hit) if self.negate else hit

    def _raw_match(self, line, parsed):
        if self.raw is not None and not self.raw.search(line):
            return False
        if self.levels:
            if not parsed or parsed["level"] not in self.levels:
                return False
        for regex, field in ((self.tag, "tag"), (self.pid, "pid"),
                             (self.tid, "tid"), (self.uid, "uid")):
            if regex is None:
                continue
            if not parsed or not regex.search(parsed[field] or ""):
                return False
        if self.text is not None:
            # Sem parse (cabecalho de bugreport, dumpsys) o texto e a linha toda.
            subject = (parsed["msg"] if parsed else line) or ""
            if not self.text.search(subject):
                return False
        return True


SCAN_CHUNK = 8 << 20


def _scan_raw_bytes(path, pattern, max_hits, lowered=None):
    """Varre o arquivo em blocos grandes procurando o padrao, e devolve
    (numero_da_linha, deslocamento_em_bytes) de cada linha que casa.

    Uma regex por linha significaria milhoes de chamadas ao interpretador; aqui
    cada bloco de 8 MB e percorrido de uma vez dentro do modulo `re`, e o numero
    da linha sai de contagens de '\\n' feitas so ate o proximo acerto — barato
    porque os acertos sao esparsos."""
    hits = []
    truncated = False
    buf = b""
    base = 0          # deslocamento, em bytes, do inicio de `buf` no arquivo
    lines_done = 0    # linhas completas antes de `buf`

    probe = lowered if lowered is not None else pattern

    def harvest(block, block_base, lines_before):
        """Acumula os acertos de um bloco terminado em '\\n'."""
        nonlocal truncated
        counted = 0          # posicao ate onde ja contamos '\n' neste bloco
        line_no = lines_before
        last_start = -1
        for m in probe.finditer(block):
            start = block.rfind(b"\n", 0, m.start()) + 1
            if start == last_start:
                continue     # outro acerto na mesma linha
            line_no += block.count(b"\n", counted, start)
            counted = start
            last_start = start
            hits.append((line_no + 1, block_base + start))
            if len(hits) >= max_hits:
                truncated = True
                return
        return

    with open(path, "rb") as f:
        while True:
            data = f.read(SCAN_CHUNK)
            if not data:
                break
            buf += data
            cut = buf.rfind(b"\n")
            if cut == -1:
                continue     # linha maior que o bloco: acumula mais
            block = buf[:cut + 1]
            # lower() preserva o tamanho, entao '\n' e os deslocamentos ficam
            # nos mesmos lugares e o bloco convertido serve para tudo.
            harvest(block.lower() if lowered is not None else block, base, lines_done)
            if truncated:
                return hits, True
            lines_done += block.count(b"\n")
            base += len(block)
            buf = buf[cut + 1:]

    # Ultima linha sem quebra no final.
    if buf and probe.search(buf.lower() if lowered is not None else buf):
        hits.append((lines_done + 1, base))
    return hits, truncated


class MultiSpec:
    """Varios filtros em OU: a linha entra se casar com qualquer um dos nos.

    E o que permite montar uma consulta do tipo "TAG Telecom com estas palavras
    OU o PID do sbrowser com aquelas", que nenhum filtro de campo unico
    consegue expressar."""

    def __init__(self, specs):
        self.specs = [s for s in specs if not s.empty]

    @property
    def empty(self):
        return not self.specs

    @property
    def needs_parse(self):
        return any(s.needs_parse for s in self.specs)

    def cache_key(self):
        return json.dumps(["OR"] + [s.cache_key() for s in self.specs], sort_keys=True)

    def matches(self, line, parsed):
        return any(s.matches(line, parsed) for s in self.specs)

    def prefilter(self):
        """Regex em bytes que qualquer linha aceitavel obrigatoriamente casa.

        So existe se todo no tiver um padrao de texto: basta um no sem texto
        (por exemplo, so `tag:`) para que qualquer linha seja candidata e a
        triagem perca o sentido. Serve para nao parsear o arquivo inteiro
        quando os acertos sao esparsos, que e o caso normal."""
        parts = []
        for spec in self.specs:
            probe = spec.raw or spec.text
            if probe is None or spec.negate or not probe.pattern.isascii():
                return None
            parts.append(f"(?:{probe.pattern})")
        if not parts:
            return None
        try:
            return re.compile("|".join(parts).encode("ascii"), re.IGNORECASE)
        except re.error:
            return None


def filter_index(path, encoding, log_format, spec):
    """Numeros de linha e deslocamentos em bytes de tudo que casa com o filtro.
    Guardar o deslocamento permite paginar depois com um seek por linha, em vez
    de reler o arquivo do inicio."""
    key = _filter_cache.key(path, ("filter", log_format, spec.cache_key()))
    cached = _filter_cache.get(key)
    if cached is not None:
        return cached

    needs_parse = spec.needs_parse

    # Caminho rapido: o filtro so procura texto na linha inteira, entao da para
    # varrer os bytes em blocos, sem decodificar nem parsear nada.
    if (not needs_parse) and getattr(spec, "raw_bytes", None) is not None and not spec.negate:
        hits, truncated = _scan_raw_bytes(
            path, spec.raw_bytes, MAX_FILTER_HITS, spec.raw_bytes_lower)
        return _filter_cache.put(key, {"hits": hits, "truncated": truncated})

    # Filtro composto: faz a triagem nos bytes e so decodifica e parseia as
    # linhas candidatas, que costumam ser uma fracao minima do arquivo.
    probe = spec.prefilter() if isinstance(spec, MultiSpec) else None
    if probe is not None:
        candidates, truncated = _scan_raw_bytes(path, probe, MAX_FILTER_HITS)
        hits = []
        with open(path, "rb") as f:
            for line_no, byte_off in candidates:
                f.seek(byte_off)
                line = f.readline().decode(encoding, errors="replace").rstrip("\n").rstrip("\r")
                parsed = parse_logcat_line(line, log_format) if needs_parse else None
                if spec.matches(line, parsed):
                    hits.append((line_no, byte_off))
        return _filter_cache.put(key, {"hits": hits, "truncated": truncated})

    hits = []
    truncated = False
    offset = 0
    with open(path, "rb") as f:
        for i, raw in enumerate(f, start=1):
            start = offset
            offset += len(raw)
            if i > MAX_SCAN_LINES:
                truncated = True
                break
            line = raw.decode(encoding, errors="replace").rstrip("\n").rstrip("\r")
            parsed = parse_logcat_line(line, log_format) if needs_parse else None
            if spec.matches(line, parsed):
                hits.append((i, start))
                if len(hits) >= MAX_FILTER_HITS:
                    truncated = True
                    break

    return _filter_cache.put(key, {"hits": hits, "truncated": truncated})


def read_filtered(path, encoding, log_format, spec, offset=0, limit=500):
    """Uma pagina do resultado filtrado, com as linhas ja lidas do disco."""
    index = filter_index(path, encoding, log_format, spec)
    hits = index["hits"]
    offset = max(0, min(offset, len(hits)))
    window = hits[offset:offset + limit]

    lines = []
    numbers = []
    with open(path, "rb") as f:
        for line_no, byte_off in window:
            f.seek(byte_off)
            raw = f.readline()
            lines.append(raw.decode(encoding, errors="replace").rstrip("\n").rstrip("\r"))
            numbers.append(line_no)

    return {
        "lines": lines,
        "line_numbers": numbers,
        "offset": offset,
        "returned": len(lines),
        "matched": len(hits),
        "has_more": offset + len(window) < len(hits),
        "truncated": index["truncated"],
    }
