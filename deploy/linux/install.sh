#!/bin/sh
# Run Light Runner as a Linux service (systemd), e.g. on a Raspberry Pi:
# started at boot and restarted if it ever stops.
#
#   sudo deploy/linux/install.sh
#
# Logs: journalctl -u light-runner -f    Remove: sudo deploy/linux/uninstall.sh
set -e

if [ "$(id -u)" != 0 ]; then echo "Run with sudo." >&2; exit 1; fi
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
RUN_AS=${SUDO_USER:-$(stat -c %U "$ROOT")}
PORT=${PORT:-8080}
NODE=$(sudo -u "$RUN_AS" sh -lc 'command -v node' 2>/dev/null || command -v node || true)
if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "Node.js 24 or newer is needed. On a Raspberry Pi:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  exit 1
fi

mkdir -p "$ROOT/data"
chown -R "$RUN_AS" "$ROOT/data"

cat > /etc/systemd/system/light-runner.service <<UNIT
[Unit]
Description=Light Runner lighting controller
Wants=network-online.target
After=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$ROOT
Environment=PORT=$PORT
ExecStart=$NODE $ROOT/server/src/supervise.ts
Restart=always
RestartSec=2
# A little priority so DMX frames stay on time while the Pi is busy.
Nice=-5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now light-runner.service
systemctl restart light-runner.service

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Light Runner is running as a service."
echo "Operator page: http://${IP:-localhost}:$PORT/operator/"
echo "Logs: journalctl -u light-runner -f"
echo "Using an ENTTEC USB interface? Add $RUN_AS to the dialout group: sudo usermod -aG dialout $RUN_AS"
