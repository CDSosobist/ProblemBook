#!/usr/bin/env bash
# Локальный сервер для ProblemBook: ./serve.sh [порт]
set -euo pipefail
PORT="${1:-8000}"
cd "$(dirname "$0")"
echo "ProblemBook → http://127.0.0.1:${PORT}/  (Ctrl+C — остановить)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
