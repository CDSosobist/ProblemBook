#!/usr/bin/env bash
# Устанавливает проблембук как системный сервис (нужен root).
#   sudo ./server/install-service.sh [порт]
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "нужен root: sudo $0 ${1:-8443}" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8443}"
UNIT=/etc/systemd/system/problembook.service
sed -e "s#/home/kra/Projects/ProblemBook#${ROOT}#g" \
    -e "s#--port 8443#--port ${PORT}#" \
    -e "s#^User=kra#User=${SUDO_USER:-root}#" \
    -e "s#^Group=kra#Group=${SUDO_USER:-root}#" \
    "${ROOT}/server/problembook.service" > "${UNIT}"
mkdir -p "${ROOT}/data" "${ROOT}/certs"
chown -R "${SUDO_USER:-root}:" "${ROOT}/data" "${ROOT}/certs"
systemctl daemon-reload
systemctl enable --now problembook.service
sleep 1
systemctl --no-pager --lines=5 status problembook.service || true
echo
echo "Готово. Открыть: https://$(hostname -I | awk '{print $1}'):${PORT}/"
echo "Учётку администратора создайте командой:"
echo "  cd ${ROOT} && python3 server/manage.py adduser <имя> --role admin"
echo "Порт ${PORT} должен быть открыт только во внутренней сети:"
echo "  sudo ufw allow from <ваша_подсеть> to any port ${PORT} proto tcp"
