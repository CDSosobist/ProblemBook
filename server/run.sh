#!/usr/bin/env bash
# Запуск проблембука как локального сервера:
#   ./server/run.sh              # 0.0.0.0:8443
#   ./server/run.sh 9443         # другой порт
#   PB_HOST=127.0.0.1 ./server/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-${PB_PORT:-8443}}"
shift || true
export PYTHONDONTWRITEBYTECODE=1
exec python3 server/problembook.py --host "${PB_HOST:-0.0.0.0}" --port "${PORT}" "$@"
