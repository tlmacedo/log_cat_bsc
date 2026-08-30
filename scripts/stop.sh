#!/usr/bin/env bash
# Para o container do Log Viewer.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose down
echo "Log Viewer parado."
