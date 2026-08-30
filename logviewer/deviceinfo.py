"""Extrai e classifica informacoes de hardware e software presentes no log.

Alimenta a aba lateral "Dispositivo". Trabalha com o que existe de fato em um
dump de aparelho Android: cabecalho de bugreport, blocos de `getprop`, trechos
de `/proc/meminfo` e `/proc/cpuinfo`, secoes de `dumpsys` (bateria, tela,
telefonia, wifi) e pistas espalhadas pelas proprias linhas de logcat.

O varredor e de uma passada so e usa pre-filtros baratos por linha, porque os
arquivos reais tem milhoes de linhas.
"""

import os
import re

from .logline import parse_logcat_line

# Quanto do arquivo varrer por padrao. Os dados de aparelho ficam quase sempre
# no cabecalho do bugreport, mas propriedades aparecem espalhadas, entao o teto
# e alto e ajustavel pela UI.
DEFAULT_MAX_LINES = 400_000
MAX_MAX_LINES = 5_000_000
MAX_VALUE_LEN = 400
MAX_ITEMS_PER_CATEGORY = 200

CATEGORIES = (
    ("identificacao", "Identificacao do aparelho", "\U0001F4F1"),
    ("build", "Build / ROM", "\U0001F9F1"),
    ("sistema", "Sistema operacional", "\U0001F916"),
    ("kernel", "Kernel", "\U0001F427"),
    ("cpu", "CPU / Processador", "\U0001F9E0"),
    ("memoria", "Memoria", "\U0001F4BE"),
    ("armazenamento", "Armazenamento", "\U0001F5C4"),
    ("tela", "Tela / Display", "\U0001F5B5"),
    ("bateria", "Bateria / Energia", "\U0001F50B"),
    ("telefonia", "Telefonia / Radio", "\U0001F4E1"),
    ("rede", "Rede / Conectividade", "\U0001F310"),
    ("bluetooth", "Bluetooth / NFC", "\U0001F535"),
    ("camera", "Camera / Sensores", "\U0001F4F7"),
    ("locale", "Regiao / Idioma / Fuso", "\U0001F30D"),
    ("seguranca", "Seguranca / Boot", "\U0001F512"),
    ("apps", "Apps / Pacotes", "\U0001F4E6"),
    ("diagnostico", "Diagnostico do log", "\U0001F50D"),
)

# ---------------------------------------------------------------------------
# Propriedades do sistema (getprop / build.prop)
# ---------------------------------------------------------------------------

PROP_MAP = {
    # Identificacao
    "ro.product.model": ("identificacao", "Modelo"),
    "ro.product.vendor.model": ("identificacao", "Modelo (vendor)"),
    "ro.product.manufacturer": ("identificacao", "Fabricante"),
    "ro.product.vendor.manufacturer": ("identificacao", "Fabricante (vendor)"),
    "ro.product.brand": ("identificacao", "Marca"),
    "ro.product.name": ("identificacao", "Nome do produto"),
    "ro.product.device": ("identificacao", "Device"),
    "ro.product.board": ("identificacao", "Board"),
    "ro.board.platform": ("identificacao", "Plataforma (SoC)"),
    "ro.hardware": ("identificacao", "Hardware"),
    "ro.hardware.chipname": ("identificacao", "Chipset"),
    "ro.soc.manufacturer": ("identificacao", "Fabricante do SoC"),
    "ro.soc.model": ("identificacao", "Modelo do SoC"),
    "ro.serialno": ("identificacao", "Numero de serie"),
    "ro.boot.serialno": ("identificacao", "Numero de serie (boot)"),
    "ro.product.first_api_level": ("identificacao", "API de lancamento"),
    "ro.csc.sales_code": ("identificacao", "Sales code (CSC)"),
    "ro.boot.sales_code": ("identificacao", "Sales code (boot)"),
    "ro.boot.hardware.sku": ("identificacao", "SKU"),
    "ril.serialnumber": ("identificacao", "Serial (RIL)"),
    "ro.boot.activatedid": ("identificacao", "Activated ID"),

    # Build / ROM
    "ro.build.fingerprint": ("build", "Fingerprint"),
    "ro.build.id": ("build", "Build ID"),
    "ro.build.display.id": ("build", "Display ID"),
    "ro.build.version.incremental": ("build", "Versao incremental"),
    "ro.build.type": ("build", "Tipo de build"),
    "ro.build.tags": ("build", "Tags do build"),
    "ro.build.flavor": ("build", "Flavor"),
    "ro.build.date": ("build", "Data do build"),
    "ro.build.date.utc": ("build", "Data do build (UTC)"),
    "ro.build.user": ("build", "Usuario do build"),
    "ro.build.host": ("build", "Host do build"),
    "ro.build.description": ("build", "Descricao do build"),
    "ro.build.characteristics": ("build", "Caracteristicas"),
    "ro.build.version.security_patch": ("build", "Patch de seguranca"),
    "ro.vendor.build.fingerprint": ("build", "Fingerprint (vendor)"),
    "ro.system.build.fingerprint": ("build", "Fingerprint (system)"),
    "ro.odm.build.fingerprint": ("build", "Fingerprint (odm)"),

    # Sistema operacional
    "ro.build.version.release": ("sistema", "Versao do Android"),
    "ro.build.version.release_or_codename": ("sistema", "Versao / codinome"),
    "ro.build.version.sdk": ("sistema", "Nivel de API (SDK)"),
    "ro.build.version.codename": ("sistema", "Codinome"),
    "ro.build.version.preview_sdk": ("sistema", "SDK de preview"),
    "ro.build.version.base_os": ("sistema", "SO base"),
    "ro.vndk.version": ("sistema", "Versao VNDK"),
    "ro.treble.enabled": ("sistema", "Project Treble"),
    "ro.bootloader": ("sistema", "Bootloader"),
    "ro.boot.bootloader": ("sistema", "Bootloader (boot)"),
    "ro.baseband": ("sistema", "Baseband"),
    "gsm.version.baseband": ("sistema", "Baseband (GSM)"),
    "ro.revision": ("sistema", "Revisao do hardware"),
    "ro.build.version.oneui": ("sistema", "Versao One UI"),
    "ro.miui.ui.version.name": ("sistema", "Versao MIUI"),
    "ro.build.version.emui": ("sistema", "Versao EMUI"),

    # CPU
    "ro.product.cpu.abi": ("cpu", "ABI principal"),
    "ro.product.cpu.abi2": ("cpu", "ABI secundaria"),
    "ro.product.cpu.abilist": ("cpu", "Lista de ABIs"),
    "ro.product.cpu.abilist32": ("cpu", "ABIs 32 bits"),
    "ro.product.cpu.abilist64": ("cpu", "ABIs 64 bits"),
    "ro.zygote": ("cpu", "Zygote"),

    # Memoria
    "dalvik.vm.heapsize": ("memoria", "Heap maximo da VM"),
    "dalvik.vm.heapgrowthlimit": ("memoria", "Limite de crescimento do heap"),
    "dalvik.vm.heapstartsize": ("memoria", "Heap inicial da VM"),
    "ro.config.low_ram": ("memoria", "Modo low RAM"),

    # Armazenamento
    "ro.crypto.state": ("armazenamento", "Estado da criptografia"),
    "ro.crypto.type": ("armazenamento", "Tipo de criptografia"),
    "persist.sys.sdcardfs": ("armazenamento", "sdcardfs"),

    # Tela
    "ro.sf.lcd_density": ("tela", "Densidade (dpi)"),
    "ro.sf.lcd_density.fallback": ("tela", "Densidade (fallback)"),
    "persist.sys.display.size": ("tela", "Resolucao"),
    "ro.surface_flinger.max_frame_buffer_acquired_buffers": ("tela", "Buffers do SurfaceFlinger"),
    "debug.sf.frame_rate_multiple_threshold": ("tela", "Limiar de taxa de quadros"),

    # Telefonia / radio
    "gsm.operator.alpha": ("telefonia", "Operadora"),
    "gsm.operator.numeric": ("telefonia", "Operadora (MCC/MNC)"),
    "gsm.operator.iso-country": ("telefonia", "Pais da operadora"),
    "gsm.sim.operator.alpha": ("telefonia", "Operadora do SIM"),
    "gsm.sim.operator.numeric": ("telefonia", "SIM (MCC/MNC)"),
    "gsm.sim.state": ("telefonia", "Estado do SIM"),
    "gsm.network.type": ("telefonia", "Tipo de rede"),
    "gsm.operator.isroaming": ("telefonia", "Em roaming"),
    "ro.telephony.default_network": ("telefonia", "Rede padrao"),
    "persist.radio.multisim.config": ("telefonia", "Configuracao multi-SIM"),
    "ro.ril.svdo": ("telefonia", "SVDO"),

    # Rede
    "net.hostname": ("rede", "Hostname"),
    "wifi.interface": ("rede", "Interface Wi-Fi"),
    "ro.wifi.channels": ("rede", "Canais Wi-Fi"),
    "net.dns1": ("rede", "DNS 1"),
    "net.dns2": ("rede", "DNS 2"),

    # Bluetooth / NFC
    "ro.bluetooth.library_name": ("bluetooth", "Stack Bluetooth"),
    "bluetooth.device.class_of_device": ("bluetooth", "Classe do dispositivo"),
    "ro.nfc.port": ("bluetooth", "Porta NFC"),

    # Camera / sensores
    "ro.camera.notify_nfc": ("camera", "Camera notifica NFC"),
    "camera.disable_zsl_mode": ("camera", "ZSL desabilitado"),
    "ro.hardware.sensors": ("camera", "HAL de sensores"),

    # Locale
    "persist.sys.locale": ("locale", "Locale"),
    "ro.product.locale": ("locale", "Locale do produto"),
    "persist.sys.timezone": ("locale", "Fuso horario"),
    "ro.csc.country_code": ("locale", "Codigo do pais (CSC)"),
    "ro.csc.countryiso_code": ("locale", "ISO do pais (CSC)"),

    # Seguranca / boot
    "ro.boot.verifiedbootstate": ("seguranca", "Verified boot"),
    "ro.boot.veritymode": ("seguranca", "Modo dm-verity"),
    "ro.boot.flash.locked": ("seguranca", "Bootloader travado"),
    "ro.secure": ("seguranca", "ro.secure"),
    "ro.debuggable": ("seguranca", "Build debugavel"),
    "ro.adb.secure": ("seguranca", "ADB seguro"),
    "ro.build.selinux": ("seguranca", "SELinux"),
    "ro.boot.warranty_bit": ("seguranca", "Warranty bit"),
    "ro.boot.mode": ("seguranca", "Modo de boot"),
    "sys.oem_unlock_allowed": ("seguranca", "Desbloqueio OEM permitido"),
}

# Getprop de fabricantes variam bastante (ex: a chave exata do sales code ou
# do activated id muda entre versoes/vendors). Para nao depender de listar
# cada variante em PROP_MAP, qualquer propriedade nao mapeada cujo nome bata
# com uma destas pistas ainda entra na categoria "identificacao", com o
# proprio nome da chave como rotulo.
_IDENTITY_PROP_HINTS = ("imei", "activatedid", "sales_code", "salescode", "serialno", "serial_no")


def _looks_like_identity_prop(key):
    lowered = key.lower()
    return any(hint in lowered for hint in _IDENTITY_PROP_HINTS)


# ---------------------------------------------------------------------------
# Linhas soltas (cabecalho de bugreport, /proc, dumpsys)
# ---------------------------------------------------------------------------

def _rule(category, label, pattern, flags=0):
    return (category, label, re.compile(pattern, flags))


LINE_RULES = (
    # Cabecalho do bugreport / dumpstate
    _rule("build", "Fingerprint", r"^Build fingerprint:\s*'?(.+?)'?\s*$"),
    _rule("build", "Fingerprint (vendor)", r"^Vendor build fingerprint:\s*'?(.+?)'?\s*$"),
    _rule("kernel", "Versao do kernel", r"^Kernel:\s*(.+)$"),
    _rule("kernel", "Versao do kernel", r"^(Linux version \S+.*)$"),
    _rule("sistema", "Bootloader", r"^Bootloader:\s*(.+)$"),
    _rule("sistema", "Baseband", r"^Radio:\s*(.+)$"),
    _rule("telefonia", "Rede", r"^Network:\s*(.+)$"),
    _rule("kernel", "Linha de comando do kernel", r"^Command line:\s*(.+)$"),
    _rule("diagnostico", "Versao do formato de bugreport", r"^Bugreport format version:\s*(.+)$"),
    _rule("diagnostico", "Inicio do dumpstate", r"^Dumpstate info:\s*(.+)$"),
    _rule("diagnostico", "Data do dump", r"^==\s*dumpstate:\s*(.+?)\s*==$"),
    _rule("diagnostico", "Uptime", r"^Uptime:\s*(.+)$"),
    _rule("diagnostico", "Uptime", r"^\s*up time:\s*(.+?),\s*idle time", re.IGNORECASE),
    _rule("diagnostico", "Memoria livre (topo)", r"^Memory:\s*(.+)$"),

    # /proc/cpuinfo
    _rule("cpu", "Hardware (cpuinfo)", r"^Hardware\s*:\s*(.+)$"),
    _rule("cpu", "Modelo", r"^model name\s*:\s*(.+)$"),
    _rule("cpu", "Implementador da CPU", r"^CPU implementer\s*:\s*(.+)$"),
    _rule("cpu", "Arquitetura", r"^CPU architecture\s*:\s*(.+)$"),
    _rule("cpu", "Variante", r"^CPU variant\s*:\s*(.+)$"),
    _rule("cpu", "Part", r"^CPU part\s*:\s*(.+)$"),
    _rule("cpu", "Revisao", r"^(?:CPU )?[Rr]evision\s*:\s*(.+)$"),
    _rule("cpu", "Features", r"^Features\s*:\s*(.+)$"),
    _rule("cpu", "BogoMIPS", r"^BogoMIPS\s*:\s*(.+)$"),

    # /proc/meminfo
    _rule("memoria", "Memoria total", r"^MemTotal:\s*(.+)$"),
    _rule("memoria", "Memoria livre", r"^MemFree:\s*(.+)$"),
    _rule("memoria", "Memoria disponivel", r"^MemAvailable:\s*(.+)$"),
    _rule("memoria", "Buffers", r"^Buffers:\s*(.+)$"),
    _rule("memoria", "Cache", r"^Cached:\s*(.+)$"),
    _rule("memoria", "Swap total", r"^SwapTotal:\s*(.+)$"),
    _rule("memoria", "Swap livre", r"^SwapFree:\s*(.+)$"),
    _rule("memoria", "ZRAM em uso", r"^\s*zram:\s*(.+)$"),

    # Bateria (dumpsys battery)
    _rule("bateria", "Nivel", r"^\s*level:\s*(\d+)\s*$"),
    _rule("bateria", "Escala", r"^\s*scale:\s*(\d+)\s*$"),
    _rule("bateria", "Tensao (mV)", r"^\s*voltage:\s*(\d+)\s*$"),
    _rule("bateria", "Temperatura (0,1 C)", r"^\s*temperature:\s*(-?\d+)\s*$"),
    _rule("bateria", "Tecnologia", r"^\s*technology:\s*(.+)$"),
    _rule("bateria", "Saude", r"^\s*health:\s*(.+)$"),
    _rule("bateria", "Status", r"^\s*status:\s*(.+)$"),
    _rule("bateria", "Fonte de energia", r"^\s*(?:AC|USB|Wireless) powered:\s*(.+)$"),
    _rule("bateria", "Corrente instantanea (uA)", r"^\s*Charge counter:\s*(.+)$"),
    _rule("bateria", "Capacidade de carga", r"^\s*charge counter:\s*(.+)$"),

    # Tela (dumpsys display / SurfaceFlinger)
    _rule("tela", "Resolucao fisica", r"width=(\d+),\s*height=(\d+)"),
    _rule("tela", "Densidade", r"density(?:Dpi)?=(\d+)"),
    _rule("tela", "Taxa de atualizacao", r"(?:refreshRate|fps)=([\d.]+)"),
    _rule("tela", "Estado da tela", r"^\s*mScreenState=(\w+)"),

    # Armazenamento (df / dumpsys diskstats)
    _rule("armazenamento", "Espaco em /data", r"^\s*Data-Free:\s*(.+)$"),
    _rule("armazenamento", "Espaco em /cache", r"^\s*Cache-Free:\s*(.+)$"),
    _rule("armazenamento", "Espaco em /system", r"^\s*System-Free:\s*(.+)$"),
    _rule("armazenamento", "Tamanho de /data", r"^\s*Data-Size:\s*(.+)$"),

    # Rede
    _rule("rede", "Endereco MAC do Wi-Fi", r"\bmac(?:_address|Address)?[=:\s]+((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})"),
    _rule("rede", "SSID conectado", r"\bSSID:\s*\"?([^\",]+)\"?"),
    _rule("rede", "Endereco IPv4", r"\bip_address[=:\s]+(\d{1,3}(?:\.\d{1,3}){3})"),

    # Telefonia
    _rule("telefonia", "Estado do servico", r"^\s*mServiceState=(.+)$"),
    _rule("telefonia", "Tipo de rede de dados", r"\bdataNetworkType[=:\s]+(\w+)"),
    _rule("telefonia", "Intensidade do sinal", r"\bmSignalStrength=([^,\]]+)"),
    # dumpsys iphonesubinfo / telephony registry - varia por versao do Android.
    _rule("telefonia", "IMEI", r"^\s*Device ID(?:\s*\(slot \d+\))?\s*[:=]\s*(\d{14,17})\s*$"),
    _rule("telefonia", "IMEI", r"\bimei(?:\[\d+\])?\s*[:=]\s*(\d{14,17})\b", re.IGNORECASE),
)

# Alguns valores so fazem sentido uma vez (o primeiro visto); outros valem a
# pena acumular como lista distinta (ex: pacotes de app).
_MULTI_LABELS = frozenset({"Features", "SSID conectado"})

# A maioria das linhas de um dump grande e logcat puro, e rodar as ~50 regras
# acima em cada uma domina o tempo de varredura. Dentro de uma mensagem de
# logcat so vale procurar o punhado de coisas que de fato aparecem la (linhas
# de tombstone/DEBUG e do bootloader).
IN_MESSAGE_RULES = tuple(
    r for r in LINE_RULES
    if r[1] in ("Fingerprint", "Versao do kernel", "Revisao",
                "Endereco MAC do Wi-Fi", "SSID conectado", "Endereco IPv4",
                "Tipo de rede de dados", "Intensidade do sinal")
)

# Pre-filtro barato: so vale rodar as regras de problema se a mensagem contiver
# uma destas palavras. Evita 7 buscas de regex por linha de log.
_PROBLEM_HINTS = ("FATAL", "ANR", "*** ***", "signal", "WATCHDOG", "Watchdog",
                  "OutOfMemory", "lowmemorykiller", "Out of memory",
                  "StrictMode", "boot completed", "Android system server")

_SECTION_RE = re.compile(r"^-{3,}\s*([A-Z0-9][^-]*?)\s*-{3,}\s*$")
_PROP_RE = re.compile(r"^\[([\w.\-]+)\]:\s*\[(.*)\]\s*$")
_PROP_EQ_RE = re.compile(r"^([a-z][\w.\-]{3,}?)=(.*)$")
_PKG_RE = re.compile(
    r"^\s*(?:Package \[|versionName=|versionCode=)"
)
_PKG_NAME_RE = re.compile(r"^\s*Package \[([\w.]+)\]")
_PKG_VER_RE = re.compile(r"^\s*versionName=(\S+)")

# Sinais de problema procurados nas mensagens de logcat.
_PROBLEM_PATTERNS = (
    ("crash", re.compile(r"FATAL EXCEPTION|AndroidRuntime.*(?:FATAL|Shutting down VM)")),
    ("anr", re.compile(r"\bANR in\b|Reason: Input dispatching timed out")),
    ("nativecrash", re.compile(r"\*\*\* \*\*\* \*\*\*|signal \d+ \(SIG\w+\)")),
    ("watchdog", re.compile(r"\bWATCHDOG\b|Watchdog.*(?:killing|blocked)")),
    ("oom", re.compile(r"\bOutOfMemoryError\b|lowmemorykiller|Out of memory")),
    ("strictmode", re.compile(r"\bStrictMode\b")),
    ("reboot", re.compile(r"\bboot completed\b|SystemServer.*Entered the Android system server", re.IGNORECASE)),
)


class _Collector:
    def __init__(self):
        self.data = {cid: {} for cid, _, _ in CATEGORIES}
        self.sources = {}

    def add(self, category, label, value, source):
        if value is None:
            return
        value = str(value).strip().strip("'\"")
        if not value or value in ("[]", "unknown", "null"):
            return
        if len(value) > MAX_VALUE_LEN:
            value = value[:MAX_VALUE_LEN] + "..."
        bucket = self.data.get(category)
        if bucket is None:
            return
        if label in bucket:
            if label in _MULTI_LABELS or bucket[label] == value:
                return
            # Guarda variantes divergentes sem sobrescrever a primeira leitura.
            alt = f"{label} (alt.)"
            if alt not in bucket and len(bucket) < MAX_ITEMS_PER_CATEGORY:
                bucket[alt] = value
                self.sources[(category, alt)] = source
            return
        if len(bucket) >= MAX_ITEMS_PER_CATEGORY:
            return
        bucket[label] = value
        self.sources[(category, label)] = source


def _apply_line_rules(collector, line, rules=LINE_RULES):
    for category, label, pattern in rules:
        m = pattern.search(line)
        if not m:
            continue
        if len(m.groups()) >= 2 and label == "Resolucao fisica":
            collector.add(category, label, f"{m.group(1)} x {m.group(2)}", "dumpsys")
        else:
            collector.add(category, label, m.group(1), "log")


def analyze_file(path, encoding, max_lines=DEFAULT_MAX_LINES, log_format=None):
    """Percorre o arquivo uma unica vez coletando propriedades, dados de /proc,
    secoes de dumpsys, pacotes e estatisticas do proprio log."""
    collector = _Collector()
    sections = []
    packages = {}
    pending_pkg = None

    lines_total = 0
    lines_logcat = 0
    level_counts = {}
    tag_counts = {}
    pid_counts = {}
    problems = {name: 0 for name, _ in _PROBLEM_PATTERNS}
    first_ts = None
    last_ts = None
    truncated = False

    with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
        for i, raw in enumerate(f):
            if i >= max_lines:
                truncated = True
                break
            lines_total += 1
            line = raw.rstrip("\n").rstrip("\r")
            if not line:
                continue

            parsed = parse_logcat_line(line, log_format)
            if parsed:
                lines_logcat += 1
                lvl = parsed["level"]
                if lvl:
                    level_counts[lvl] = level_counts.get(lvl, 0) + 1
                if parsed["tag"]:
                    tag_counts[parsed["tag"]] = tag_counts.get(parsed["tag"], 0) + 1
                if parsed["pid"]:
                    pid_counts[parsed["pid"]] = pid_counts.get(parsed["pid"], 0) + 1
                if parsed["time"]:
                    if first_ts is None:
                        first_ts = parsed["time"]
                    last_ts = parsed["time"]
                body = parsed["msg"] or ""
                if any(hint in body for hint in _PROBLEM_HINTS):
                    for name, pattern in _PROBLEM_PATTERNS:
                        if pattern.search(body):
                            problems[name] += 1
                # Dentro de logcat ainda cabem propriedades (ex: linhas de
                # DEBUG com o fingerprint do build depois de um crash nativo),
                # mas so o punhado que realmente aparece la.
                stripped = body.strip()
                if stripped:
                    _apply_line_rules(collector, stripped, IN_MESSAGE_RULES)
                continue

            stripped = line.strip()
            if not stripped:
                continue

            first = stripped[0]

            if first == "[":
                m = _PROP_RE.match(stripped)
                if m:
                    key, value = m.group(1), m.group(2)
                    mapped = PROP_MAP.get(key)
                    if mapped:
                        collector.add(mapped[0], mapped[1], value, "getprop")
                    elif _looks_like_identity_prop(key):
                        collector.add("identificacao", key, value, "getprop")
                    continue

            if first == "-":
                m = _SECTION_RE.match(stripped)
                if m:
                    name = m.group(1).strip()
                    if name and len(sections) < 400 and name not in sections:
                        sections.append(name)
                    continue

            if "=" in stripped and first.islower():
                m = _PROP_EQ_RE.match(stripped)
                if m:
                    key = m.group(1)
                    mapped = PROP_MAP.get(key)
                    if mapped:
                        collector.add(mapped[0], mapped[1], m.group(2), "build.prop")
                        continue
                    if _looks_like_identity_prop(key):
                        collector.add("identificacao", key, m.group(2), "build.prop")
                        continue

            if "Package [" in stripped:
                m = _PKG_NAME_RE.match(stripped)
                if m:
                    pending_pkg = m.group(1)
                    packages.setdefault(pending_pkg, "")
                    continue
            if pending_pkg and "versionName=" in stripped:
                m = _PKG_VER_RE.match(stripped)
                if m:
                    packages[pending_pkg] = m.group(1)
                    pending_pkg = None
                    continue

            _apply_line_rules(collector, stripped)

    stats = {
        "lines_total": lines_total,
        "lines_logcat": lines_logcat,
        "truncated": truncated,
        "level_counts": level_counts,
        "first_timestamp": first_ts,
        "last_timestamp": last_ts,
        "top_tags": sorted(tag_counts.items(), key=lambda kv: -kv[1])[:25],
        "top_pids": sorted(pid_counts.items(), key=lambda kv: -kv[1])[:25],
        "problems": problems,
        "packages": sorted(packages.items())[:200],
    }
    return collector, sections, stats


def _fill_diagnostics(collector, stats, sections, file_label, size, log_format):
    add = collector.add
    add("diagnostico", "Arquivo", file_label, "viewer")
    if size is not None:
        add("diagnostico", "Tamanho do arquivo", _fmt_size(size), "viewer")
    add("diagnostico", "Formato de logcat detectado", log_format or "nao identificado", "viewer")
    add("diagnostico", "Linhas analisadas", f"{stats['lines_total']:,}".replace(",", "."), "viewer")
    add("diagnostico", "Linhas reconhecidas como logcat",
        f"{stats['lines_logcat']:,}".replace(",", "."), "viewer")
    if stats["truncated"]:
        add("diagnostico", "Analise truncada", "sim (limite de linhas atingido)", "viewer")
    if stats["first_timestamp"]:
        add("diagnostico", "Primeiro timestamp", stats["first_timestamp"], "log")
    if stats["last_timestamp"]:
        add("diagnostico", "Ultimo timestamp", stats["last_timestamp"], "log")
    if sections:
        add("diagnostico", "Secoes de bugreport encontradas", str(len(sections)), "viewer")

    levels = stats["level_counts"]
    if levels:
        resumo = "  ".join(f"{k}:{v}" for k, v in sorted(levels.items()))
        add("diagnostico", "Distribuicao por nivel", resumo, "viewer")

    rotulos = {
        "crash": "Crashes Java (FATAL EXCEPTION)",
        "anr": "ANRs",
        "nativecrash": "Crashes nativos (tombstone)",
        "watchdog": "Ocorrencias de watchdog",
        "oom": "Falta de memoria / OOM",
        "strictmode": "Violacoes de StrictMode",
        "reboot": "Marcos de boot",
    }
    for key, label in rotulos.items():
        count = stats["problems"].get(key, 0)
        if count:
            add("diagnostico", label, str(count), "log")


def _fmt_size(n):
    if n is None:
        return None
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024.0
    return f"{n:.1f}GB"


def build_report(collector, sections, stats, file_label, size, log_format):
    _fill_diagnostics(collector, stats, sections, file_label, size, log_format)

    if stats["packages"]:
        for name, version in stats["packages"][:MAX_ITEMS_PER_CATEGORY]:
            collector.add("apps", name, version or "(versao nao informada)", "dumpsys package")

    categories = []
    for cid, label, icon in CATEGORIES:
        items = [
            {"label": k, "value": v, "source": collector.sources.get((cid, k), "log")}
            for k, v in collector.data[cid].items()
        ]
        if not items:
            continue
        categories.append({"id": cid, "label": label, "icon": icon, "items": items})

    return {
        "categories": categories,
        "sections": sections,
        "top_tags": [{"tag": t, "count": c} for t, c in stats["top_tags"]],
        "top_pids": [{"pid": p, "count": c} for p, c in stats["top_pids"]],
        "level_counts": stats["level_counts"],
        "lines_total": stats["lines_total"],
        "lines_logcat": stats["lines_logcat"],
        "truncated": stats["truncated"],
        "format": log_format,
    }


def analyze(path, encoding, max_lines=DEFAULT_MAX_LINES, log_format=None, file_label=None):
    """Analisa um unico arquivo e devolve o relatorio pronto para a UI."""
    max_lines = max(1000, min(max_lines, MAX_MAX_LINES))
    collector, sections, stats = analyze_file(path, encoding, max_lines, log_format)
    try:
        size = os.path.getsize(path)
    except OSError:
        size = None
    return build_report(collector, sections, stats,
                        file_label or os.path.basename(path), size, log_format)


def analyze_many(entries, max_lines=DEFAULT_MAX_LINES):
    """Consolida varios arquivos (ex: main + events + radio + dumpstate de uma
    mesma captura) em um unico relatorio de dispositivo.

    `entries` e uma lista de (rel_path, full_path, encoding, log_format)."""
    max_lines = max(1000, min(max_lines, MAX_MAX_LINES))
    collector = _Collector()
    sections = []
    merged = {
        "lines_total": 0, "lines_logcat": 0, "truncated": False,
        "level_counts": {}, "first_timestamp": None, "last_timestamp": None,
        "top_tags": [], "top_pids": [],
        "problems": {name: 0 for name, _ in _PROBLEM_PATTERNS},
        "packages": [],
    }
    tag_totals, pid_totals, packages = {}, {}, {}
    used = []
    per_line_budget = max(1000, max_lines // max(1, len(entries)))

    for rel, full, encoding, log_format in entries:
        try:
            c, secs, stats = analyze_file(full, encoding, per_line_budget, log_format)
        except (OSError, UnicodeError):
            continue
        used.append(rel)
        for cid, bucket in c.data.items():
            for label, value in bucket.items():
                collector.add(cid, label, value, c.sources.get((cid, label), "log"))
        for s in secs:
            if s not in sections and len(sections) < 400:
                sections.append(s)
        merged["lines_total"] += stats["lines_total"]
        merged["lines_logcat"] += stats["lines_logcat"]
        merged["truncated"] = merged["truncated"] or stats["truncated"]
        for lvl, count in stats["level_counts"].items():
            merged["level_counts"][lvl] = merged["level_counts"].get(lvl, 0) + count
        for name, count in stats["problems"].items():
            merged["problems"][name] = merged["problems"].get(name, 0) + count
        for tag, count in stats["top_tags"]:
            tag_totals[tag] = tag_totals.get(tag, 0) + count
        for pid, count in stats["top_pids"]:
            pid_totals[pid] = pid_totals.get(pid, 0) + count
        for name, version in stats["packages"]:
            packages.setdefault(name, version)
        if stats["first_timestamp"] and (
            merged["first_timestamp"] is None
            or stats["first_timestamp"] < merged["first_timestamp"]
        ):
            merged["first_timestamp"] = stats["first_timestamp"]
        if stats["last_timestamp"] and (
            merged["last_timestamp"] is None
            or stats["last_timestamp"] > merged["last_timestamp"]
        ):
            merged["last_timestamp"] = stats["last_timestamp"]

    merged["top_tags"] = sorted(tag_totals.items(), key=lambda kv: -kv[1])[:25]
    merged["top_pids"] = sorted(pid_totals.items(), key=lambda kv: -kv[1])[:25]
    merged["packages"] = sorted(packages.items())[:200]

    label = f"{len(used)} arquivo(s)" if used else "nenhum arquivo lido"
    report = build_report(collector, sections, merged, label, None, None)
    report["files_used"] = used
    return report
