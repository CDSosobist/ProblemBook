#!/usr/bin/env bash
# Открывает доступ из локальной сети к SSH, RDP и проблембуку на этой машине.
#
#   sudo ./scripts/expose-network.sh                 # подсеть по умолчанию 192.168.198.0/24
#   sudo ./scripts/expose-network.sh --subnet 192.168.0.0/16
#   sudo ./scripts/expose-network.sh --dry-run       # показать, что будет сделано
#
# Скрипт идемпотентен: повторный запуск ничего не ломает.
set -euo pipefail

SUBNET="192.168.198.0/24"
DRY_RUN=0
SSH_PORT=22
RDP_PORT=3389
APP_PORT=8443

while [ $# -gt 0 ]; do
  case "$1" in
    --subnet) SUBNET="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    echo "  $*"
    "$@"
  fi
}

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "нужен root: sudo $0 $*" >&2
  exit 1
fi

echo "== 1. SSH"
if dpkg -s openssh-server >/dev/null 2>&1; then
  echo "  openssh-server уже установлен"
else
  run apt-get install -y --no-install-recommends openssh-server
fi
run systemctl enable --now ssh

echo "== 2. Проблембук (уже слушает $APP_PORT)"
if ss -ltn | grep -q ":$APP_PORT "; then
  echo "  порт $APP_PORT слушается — сервис работает"
else
  echo "  ВНИМАНИЕ: порт $APP_PORT не слушается. Запустите сервис: ./server/run.sh (или systemctl start problembook)"
fi

echo "== 3. RDP ($RDP_PORT, GNOME Remote Desktop)"
if ss -ltn | grep -q ":$RDP_PORT "; then
  echo "  порт $RDP_PORT слушается"
else
  echo "  ВНИМАНИЕ: RDP не слушает. Включите его в сеансе пользователя:"
  echo "    XDG_RUNTIME_DIR=/run/user/1000 grdctl status"
fi

echo "== 4. Межсетевой экран (ufw): разрешаем $SSH_PORT, $RDP_PORT, $APP_PORT только из $SUBNET"
if ! command -v ufw >/dev/null 2>&1; then
  run apt-get install -y ufw
fi

if [ "$DRY_RUN" -eq 0 ]; then
  ufw --force reset >/dev/null 2>&1 || true
fi
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow from "$SUBNET" to any port "$SSH_PORT" proto tcp comment 'SSH из локальной сети'
run ufw allow from "$SUBNET" to any port "$RDP_PORT" proto tcp comment 'RDP из локальной сети'
run ufw allow from "$SUBNET" to any port "$APP_PORT" proto tcp comment 'ProblemBook из локальной сети'
run ufw logging low
run ufw --force enable

echo "== 5. Проверка"
if [ "$DRY_RUN" -eq 0 ]; then
  echo "--- слушающие порты ---"
  ss -ltn | grep -E ":($SSH_PORT|$RDP_PORT|$APP_PORT) " || echo "  ни один из портов не слушается"
  echo "--- правила ufw ---"
  ufw status numbered
  echo
  echo "Готово. Адреса для подключения:"
  IP=$(hostname -I | awk '{print $1}')
  echo "  SSH:        ssh $(id -un)@$IP"
  echo "  RDP:        $IP:$RDP_PORT (пользователь и пароль заданы через grdctl)"
  echo "  Проблембук: https://$IP:$APP_PORT/"
else
  echo "(dry-run: изменения не применялись)"
fi
