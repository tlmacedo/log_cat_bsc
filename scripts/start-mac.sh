#!/usr/bin/env bash
# Sobe o Log Viewer em container. Serve para macOS e Linux.
#
#   ./scripts/start-mac.sh [pasta-de-logs] [outras-pastas...]
#
# Sem argumento, usa a pasta log/ do repositorio. A pasta de logs, a sua pasta
# de usuario e o que mais for passado ficam visiveis no botao "Procurar...",
# com o mesmo caminho de dentro do container e somente leitura.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
PORT="${HOST_PORT:-5057}"

info()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- Docker ---------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die \
  "Docker nao encontrado. Instale o Docker Desktop: https://www.docker.com/products/docker-desktop"
docker info >/dev/null 2>&1 || die \
  "O Docker esta instalado mas nao esta rodando. Abra o Docker Desktop e tente de novo."
docker compose version >/dev/null 2>&1 || die \
  "Este Docker nao tem o 'docker compose'. Atualize o Docker Desktop."
ok "Docker pronto"

# --- Pastas ---------------------------------------------------------------
LOG_DIR="${1:-$REPO/log}"
mkdir -p "$LOG_DIR" 2>/dev/null || true
[ -d "$LOG_DIR" ] || die "Pasta de logs nao encontrada: $LOG_DIR"
LOG_DIR="$(cd "$LOG_DIR" && pwd)"
CAPTURE_DIR="$REPO/capturas"
mkdir -p "$CAPTURE_DIR"
CONFIG_DIR="$REPO/config"
mkdir -p "$CONFIG_DIR"
ok "Logs:     $LOG_DIR  (aparece como /logs no app)"
ok "Capturas: $CAPTURE_DIR"
ok "Config:   $CONFIG_DIR  (filtros salvos — mesmo arquivo da versao desktop, se rodada neste Mac)"

# Pastas visiveis para o botao "Procurar...". Cada uma e montada com o MESMO
# caminho de dentro do container, para que o que voce ve no Finder seja o que o
# app mostra. Sao somente leitura.
shift || true
EXTRA=("$LOG_DIR" "$HOME")
for arg in "$@"; do
  [ -d "$arg" ] && EXTRA+=("$(cd "$arg" && pwd)")
done

# Override gerado: o compose principal nao tem como montar uma lista variavel.
{
  echo "# Gerado por scripts/start-mac.sh — nao edite a mao."
  echo "# Pastas do host visiveis dentro do container, com o mesmo caminho e"
  echo "# somente leitura."
  echo "services:"
  echo "  logviewer:"
  echo "    volumes:"
} > docker-compose.override.yml

# Descarta repetidos e caminhos ja contidos em outro da lista.
SEEN=""
for dir in "${EXTRA[@]}"; do
  skip=""
  for other in $SEEN; do
    case "$dir" in "$other"|"$other"/*) skip=1;; esac
  done
  [ -n "$skip" ] && continue
  SEEN="$SEEN $dir"
  printf '      - "%s:%s:ro"\n' "$dir" "$dir" >> docker-compose.override.yml
done
ok "Visiveis:$SEEN"

# --- adb do host ----------------------------------------------------------
# O container nao enxerga a USB; ele conversa com o adb desta maquina.
ADB_BIN=""
for cand in adb "$HOME/Library/Android/sdk/platform-tools/adb" \
            "$HOME/Android/Sdk/platform-tools/adb" /usr/local/bin/adb /opt/homebrew/bin/adb; do
  if command -v "$cand" >/dev/null 2>&1; then ADB_BIN="$cand"; break; fi
done

ADB_HOST_VALUE="host.docker.internal"
if [ -n "$ADB_BIN" ]; then
  # -a faz o servidor aceitar conexoes de fora do localhost, que e o caso do container.
  "$ADB_BIN" -a -P 5037 start-server >/dev/null 2>&1 || \
    "$ADB_BIN" start-server >/dev/null 2>&1 || true
  DEVS="$("$ADB_BIN" devices 2>/dev/null | sed '1d' | grep -c 'device$' || true)"
  ok "adb encontrado ($ADB_BIN) — ${DEVS:-0} aparelho(s) conectado(s)"
else
  ADB_HOST_VALUE=""
  warn "adb nao encontrado. O app sobe normalmente, mas a aba de aparelhos USB"
  warn "ficara indisponivel. Para habilitar, instale as platform-tools do Android."
fi

# --- Sobe --------------------------------------------------------------------
cat > .env <<ENV
LOG_DIR=$LOG_DIR
CAPTURE_DIR=$CAPTURE_DIR
CONFIG_DIR=$CONFIG_DIR
HOST_PORT=$PORT
ADB_HOST=$ADB_HOST_VALUE
ADB_PORT=5037
ENV

info "Construindo a imagem (a primeira vez demora alguns minutos)..."
docker compose build
info "Subindo o container..."
docker compose up -d

# Espera o servidor responder antes de abrir o navegador.
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then break; fi
  sleep 1
done

URL="http://127.0.0.1:$PORT"
if curl -fsS "$URL/api/config" >/dev/null 2>&1; then
  ok "Log Viewer no ar em $URL"
  command -v open >/dev/null 2>&1 && open "$URL" || true
else
  warn "O container subiu mas o servidor nao respondeu. Veja: docker compose logs -f"
fi

echo
echo "  parar:    docker compose down"
echo "  logs:     docker compose logs -f"
echo "  reiniciar: ./scripts/start-mac.sh \"$LOG_DIR\""
