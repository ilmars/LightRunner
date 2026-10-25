#!/bin/sh
# Stop the Light Runner service and remove it.   sudo deploy/linux/uninstall.sh
set -e
systemctl disable --now light-runner.service 2>/dev/null || true
rm -f /etc/systemd/system/light-runner.service
systemctl daemon-reload
echo "Light Runner service removed. Your show and settings in data/ are kept."
