#!/bin/sh
# Run Light Runner as a macOS service (launchd), started automatically and
# restarted if it ever stops.
#
#   deploy/macos/install.sh              start when this user logs in (no admin password)
#   sudo deploy/macos/install.sh --system  start at boot, before anyone logs in
#
# Logs: data/logs/light-runner.log    Remove: deploy/macos/uninstall.sh [--system]
set -e

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LABEL=org.lightrunner.server
PORT=${PORT:-8080}
SYSTEM=0
[ "$1" = "--system" ] && SYSTEM=1

# Find Node.js 24+ (Homebrew's node@24 is keg-only, so look there too).
NODE=""
for n in "$(command -v node 2>/dev/null)" /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ] && "$n" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then NODE="$n"; break; fi
done
if [ -z "$NODE" ]; then
  echo "Node.js 24 or newer is needed. Install it with: brew install node@24" >&2
  exit 1
fi

if [ "$SYSTEM" = 1 ]; then
  if [ "$(id -u)" != 0 ]; then echo "Run with sudo for --system." >&2; exit 1; fi
  RUN_AS=${SUDO_USER:-$(stat -f %Su "$ROOT")}
  PLIST=/Library/LaunchDaemons/$LABEL.plist
  DOMAIN=system
  USER_KEY="<key>UserName</key><string>$RUN_AS</string>"
else
  RUN_AS=$(id -un)
  PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
  DOMAIN=gui/$(id -u)
  USER_KEY=""
  mkdir -p "$HOME/Library/LaunchAgents"
fi

mkdir -p "$ROOT/data/logs"
[ "$SYSTEM" = 1 ] && chown -R "$RUN_AS" "$ROOT/data"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server/src/supervise.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>$PORT</string></dict>
  $USER_KEY
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Interactive: macOS must not slow its timers down (DMX frames every 25 ms). -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$ROOT/data/logs/light-runner.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/light-runner.log</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)
echo "Light Runner is running as a service ($PLIST)."
echo "Operator page: http://$IP:$PORT/operator/"
echo "Logs: $ROOT/data/logs/light-runner.log"
echo
echo "For a computer that runs the lights, also turn off sleep:"
echo "  sudo pmset -a sleep 0 disksleep 0 displaysleep 10"
