"""Aparelhos Android ligados na USB, via adb.

Lista o que esta conectado, le as propriedades que identificam cada aparelho e
captura os logs para uma pasta propria. Cada aparelho tem a sua pasta, nomeada
pelo serial, para que dois aparelhos do mesmo modelo nunca se misturem.

Nada aqui monta linha de comando a partir de texto do usuario: o serial e
sempre conferido contra a lista que o proprio adb devolveu.
"""

import os
import re
import shutil
import subprocess
import time

# Onde o adb costuma estar quando nao esta no PATH.
ADB_CANDIDATES = (
    "adb",
    os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"),
    os.path.expanduser("~/Android/Sdk/platform-tools/adb"),
    "/usr/local/bin/adb",
    "/opt/homebrew/bin/adb",
    "/usr/lib/android-sdk/platform-tools/adb",
)

# Serial de aparelho Android: alfanumerico, hifen, dois-pontos e ponto (o
# ultimo par cobre os alvos de rede, do tipo 192.168.0.10:5555).
SERIAL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")

LIST_TIMEOUT = 15
PROP_TIMEOUT = 30
CAPTURE_TIMEOUT = 300
BUGREPORT_TIMEOUT = 900

# Onde as capturas sao gravadas. Dentro do container aponta para o volume
# montado do host, senao a captura sumiria junto com o container.
DEFAULT_CAPTURE_ROOT = os.environ.get(
    "CAPTURE_ROOT") or os.path.expanduser("~/logviewer-capturas")

# Servidor adb a usar. No container o adb daqui e so o cliente: quem enxerga a
# USB e o adb da maquina do usuario, porque o Docker Desktop no Mac e no
# Windows roda numa VM sem acesso as portas USB.
ADB_HOST = os.environ.get("ADB_HOST") or None
ADB_PORT = os.environ.get("ADB_PORT") or None

# Propriedades que identificam o aparelho na lista. A ordem e a da exibicao.
IDENTITY = (
    ("modelo", "ro.boot.em.model", ("ro.product.model", "ro.product.vendor.model")),
    ("serial", "ro.boot.serialno", ("ro.serialno",)),
    ("revisao", "ro.boot.revision", ()),
    ("android", "ro.build.version.release", ("ro.build.version.release_or_codename",)),
    ("operadora", "ro.boot.sales_code", ("ro.csc.sales_code", "persist.audio.sales_code")),
    ("activatedid", "ro.boot.activatedid", ("persist.sys.prev_activatedid",)),
    ("build", "ro.bootimage.build.type", ("ro.build.type",)),
    ("release_oficial", "ro.build.official.release", ()),
)

IDENTITY_LABELS = {
    "modelo": "Modelo",
    "serial": "Serial",
    "revisao": "Revisao (ro.boot.revision)",
    "android": "Android",
    "operadora": "Operadora (sales code)",
    "activatedid": "Activated ID",
    "build": "Tipo de build",
    "release_oficial": "Release oficial",
}

_PROP_LINE = re.compile(r"^\[([^\]]+)\]:\s*\[(.*)\]$")


class AdbError(RuntimeError):
    pass


def _server_reachable(timeout=2):
    """O container so alcanca a USB atraves do adb do host; sem esse servidor
    de pe, a mensagem precisa dizer isso em vez de 'nenhum aparelho'."""
    import socket
    try:
        with socket.create_connection((ADB_HOST, int(ADB_PORT or 5037)), timeout):
            return True
    except OSError:
        return False


def adb_path():
    """Caminho do adb, ou None se nao houver."""
    for candidate in ADB_CANDIDATES:
        found = shutil.which(candidate) if os.sep not in candidate else (
            candidate if os.access(candidate, os.X_OK) else None)
        if found:
            return found
    return None


def _adb_cmd(args):
    """Linha de comando completa do adb, ja com o servidor configurado."""
    adb = adb_path()
    if not adb:
        raise AdbError("adb nao encontrado. Instale as platform-tools do Android "
                       "ou coloque o adb no PATH.")
    prefix = []
    if ADB_HOST:
        prefix += ["-H", ADB_HOST]
    if ADB_PORT:
        prefix += ["-P", str(ADB_PORT)]
    return [adb] + prefix + args


def _run(args, timeout):
    adb = adb_path()
    if not adb:
        raise AdbError("adb nao encontrado. Instale as platform-tools do Android "
                       "ou coloque o adb no PATH.")
    if ADB_HOST and not _server_reachable():
        raise AdbError(
            f"Nao consegui falar com o servidor adb em {ADB_HOST}:{ADB_PORT or 5037}. "
            "Rode 'adb start-server' na sua maquina (fora do container) e "
            "confirme que ha um aparelho conectado.")
    prefix = []
    if ADB_HOST:
        prefix += ["-H", ADB_HOST]
    if ADB_PORT:
        prefix += ["-P", str(ADB_PORT)]
    try:
        proc = subprocess.run(
            [adb] + prefix + args, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise AdbError(f"adb {' '.join(args[:2])} demorou demais e foi interrompido.")
    except OSError as e:
        raise AdbError(f"Falha executando o adb: {e}")
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip() or "erro desconhecido"
        raise AdbError(f"adb: {err}")
    return proc.stdout.decode("utf-8", "replace")


def list_devices():
    """Aparelhos conectados, com o estado que o adb reporta.

    Estados diferentes de 'device' (unauthorized, offline, ...) tambem voltam,
    porque o usuario precisa saber que o aparelho esta la mas nao responde."""
    out = _run(["devices", "-l"], LIST_TIMEOUT)
    devices = []
    for line in out.splitlines()[1:]:
        line = line.strip()
        if not line or line.startswith("*"):
            continue
        parts = line.split()
        serial, state = parts[0], parts[1] if len(parts) > 1 else "unknown"
        if not SERIAL_RE.match(serial):
            continue
        extra = {}
        for token in parts[2:]:
            if ":" in token:
                k, v = token.split(":", 1)
                extra[k] = v
        devices.append({
            "serial": serial,
            "state": state,
            "usb": extra.get("usb"),
            "model_hint": extra.get("model"),
            "product": extra.get("product"),
            "transport": extra.get("transport_id"),
        })
    return devices


def _known_serial(serial):
    """So aceita serial que o adb acabou de listar — nada vindo do cliente entra
    numa linha de comando sem passar por aqui."""
    if not serial or not SERIAL_RE.match(serial):
        raise AdbError("Serial invalido.")
    for dev in list_devices():
        if dev["serial"] == serial:
            return dev
    raise AdbError(f"Aparelho {serial} nao esta conectado.")


def read_props(serial):
    """Todas as propriedades do aparelho, como dicionario."""
    _known_serial(serial)
    out = _run(["-s", serial, "shell", "getprop"], PROP_TIMEOUT)
    props = {}
    for line in out.splitlines():
        m = _PROP_LINE.match(line.strip())
        if m:
            props[m.group(1)] = m.group(2)
    return props


def identity_from_props(props):
    """Os campos que identificam o aparelho, com as alternativas usadas quando
    a propriedade principal vem vazia (varia entre fabricantes e versoes)."""
    out = {}
    for key, primary, fallbacks in IDENTITY:
        value = props.get(primary, "").strip()
        source = primary
        if not value:
            for alt in fallbacks:
                value = props.get(alt, "").strip()
                if value:
                    source = alt
                    break
        out[key] = {"value": value or None, "prop": source if value else primary}
    return out


def describe(serial):
    """Aparelho + identificacao, pronto para a lista da UI."""
    dev = _known_serial(serial)
    if dev["state"] != "device":
        return {**dev, "identity": None,
                "error": _state_message(dev["state"])}
    props = read_props(serial)
    return {**dev, "identity": identity_from_props(props), "props_count": len(props)}


def _state_message(state):
    return {
        "unauthorized": "Aparelho conectado mas nao autorizado. Confirme a "
                        "depuracao USB na tela do aparelho.",
        "offline": "Aparelho offline. Reconecte o cabo.",
        "recovery": "Aparelho em modo recovery.",
        "sideload": "Aparelho em modo sideload.",
        "no permissions": "Sem permissao para acessar o dispositivo USB.",
    }.get(state, f"Aparelho em estado '{state}'.")


def _slug(text, fallback="aparelho"):
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", (text or "").strip()).strip("-")
    return slug or fallback


def capture_dir(serial, props, root=None):
    """Pasta da captura: uma por aparelho, uma subpasta por captura.

    O nome leva modelo e serial justamente para que dois aparelhos iguais nao
    se confundam na arvore de arquivos."""
    ident = identity_from_props(props)
    model = ident["modelo"]["value"] or props.get("ro.product.model") or "modelo"
    base = os.path.join(root or DEFAULT_CAPTURE_ROOT,
                        f"{_slug(model)}_{_slug(serial)}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(base, stamp)
    os.makedirs(path, exist_ok=True)
    return path


# Buffers de logcat capturados por padrao, cada um no seu arquivo.
LOG_BUFFERS = (
    ("main", "logcat_main.txt"),
    ("events", "logcat_events.txt"),
    ("radio", "logcat_radio.txt"),
    ("system", "logcat_system.txt"),
    ("crash", "logcat_crash.txt"),
)


def capture(serial, root=None, with_bugreport=False, buffers=None):
    """Despeja os buffers de logcat e as propriedades numa pasta do aparelho.

    Devolve o caminho da pasta e o que foi escrito. O bugreport e opcional
    porque leva minutos e gera dezenas de MB."""
    dev = _known_serial(serial)
    if dev["state"] != "device":
        raise AdbError(_state_message(dev["state"]))

    props = read_props(serial)
    path = capture_dir(serial, props, root)
    written = []

    with open(os.path.join(path, "getprop.txt"), "w", encoding="utf-8") as f:
        for key in sorted(props):
            f.write(f"[{key}]: [{props[key]}]\n")
    written.append("getprop.txt")

    wanted = set(buffers) if buffers else {name for name, _ in LOG_BUFFERS}
    for name, filename in LOG_BUFFERS:
        if name not in wanted:
            continue
        try:
            out = _run(["-s", serial, "logcat", "-d", "-b", name, "-v", "threadtime"],
                       CAPTURE_TIMEOUT)
        except AdbError:
            continue   # buffer ausente no aparelho nao impede o resto
        if not out.strip():
            continue
        with open(os.path.join(path, filename), "w", encoding="utf-8") as f:
            f.write(out)
        written.append(filename)

    if with_bugreport:
        target = os.path.join(path, "bugreport.zip")
        try:
            _run(["-s", serial, "bugreport", target], BUGREPORT_TIMEOUT)
            if os.path.exists(target):
                written.append("bugreport.zip")
        except AdbError:
            pass   # o resto da captura continua valendo

    return {
        "path": path,
        "files": written,
        "serial": serial,
        "identity": identity_from_props(props),
    }


# ---------------------------------------------------------------------------
# Coleta ao vivo
# ---------------------------------------------------------------------------
# Uma sessao por aparelho: o adb escreve o logcat direto num arquivo, que a
# interface abre como qualquer outro. Assim a analise ao vivo e a mesma de um
# log parado — filtros, buscas e destaques valem igual.

import signal   # noqa: E402  (usado so pela coleta ao vivo)

_sessions = {}

# O filtro vai para a linha de comando do adb, entao aceita apenas o formato de
# filterspec do logcat (TAG:nivel), sem espaco para nada mais.
FILTERSPEC_RE = re.compile(r"^[A-Za-z0-9_.*:\-]+$")


def _session_state(entry):
    proc = entry["proc"]
    if proc.poll() is not None:
        return "encerrada"
    return entry["state"]


def live_status(serial=None):
    out = []
    for key, entry in list(_sessions.items()):
        if serial and key != serial:
            continue
        size = 0
        try:
            size = os.path.getsize(entry["file"])
        except OSError:
            pass
        out.append({
            "serial": key,
            "state": _session_state(entry),
            "file": entry["file"],
            "dir": os.path.dirname(entry["file"]),
            "filter": entry["filter"],
            "buffers": entry["buffers"],
            "started": entry["started"],
            "size": size,
        })
    return out


def live_start(serial, filterspec=None, buffers=None, root=None):
    """Comeca a gravar o logcat do aparelho num arquivo que cresce."""
    dev = _known_serial(serial)
    if dev["state"] != "device":
        raise AdbError(_state_message(dev["state"]))

    live_stop(serial)   # so uma sessao por aparelho

    args = ["-s", serial, "logcat", "-v", "threadtime"]
    wanted = [b for b in (buffers or ["main"]) if b in {n for n, _ in LOG_BUFFERS}]
    for b in wanted or ["main"]:
        args += ["-b", b]

    spec = (filterspec or "").strip()
    if spec:
        for token in spec.split():
            if not FILTERSPEC_RE.match(token):
                raise AdbError(f"Filtro invalido: {token!r}. Use o formato do "
                               "logcat, por exemplo 'ActivityManager:I *:S'.")
            args.append(token)

    props = read_props(serial)
    path = capture_dir(serial, props, root)
    target = os.path.join(path, "logcat_live.txt")

    handle = open(target, "wb")
    try:
        proc = subprocess.Popen(_adb_cmd(args), stdout=handle,
                                stderr=subprocess.DEVNULL)
    except OSError as e:
        handle.close()
        raise AdbError(f"Falha iniciando a coleta: {e}")

    _sessions[serial] = {
        "proc": proc, "handle": handle, "file": target,
        "filter": spec, "buffers": wanted or ["main"],
        "started": time.strftime("%Y-%m-%d %H:%M:%S"),
        "state": "coletando",
        "identity": identity_from_props(props),
    }
    return live_status(serial)[0]


def _session(serial):
    entry = _sessions.get(serial)
    if not entry:
        raise AdbError("Nao ha coleta ao vivo para este aparelho.")
    return entry


def live_pause(serial):
    """Suspende o processo do adb.

    O aparelho continua produzindo log no proprio buffer circular; se a pausa
    for longa, o que estourar esse buffer se perde. Retomar volta de onde o
    buffer estiver."""
    entry = _session(serial)
    if entry["proc"].poll() is None and entry["state"] == "coletando":
        entry["proc"].send_signal(signal.SIGSTOP)
        entry["state"] = "pausada"
    return live_status(serial)[0]


def live_resume(serial):
    entry = _session(serial)
    if entry["proc"].poll() is None and entry["state"] == "pausada":
        entry["proc"].send_signal(signal.SIGCONT)
        entry["state"] = "coletando"
    return live_status(serial)[0]


def live_stop(serial):
    """Encerra a coleta. O arquivo gravado ate aqui continua onde esta."""
    entry = _sessions.pop(serial, None)
    if not entry:
        return None
    proc = entry["proc"]
    if proc.poll() is None:
        # Um processo pausado ignora o terminate ate voltar a rodar.
        if entry["state"] == "pausada":
            proc.send_signal(signal.SIGCONT)
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    try:
        entry["handle"].close()
    except OSError:
        pass
    return {"serial": serial, "file": entry["file"], "state": "encerrada"}
