#!/bin/sh
# Stop the Light Runner service and remove it from launchd.
#   deploy/macos/uninstall.sh            (or: sudo deploy/macos/uninstall.sh --system)
LABEL=org.lightrunner.server
if [ "$1" = "--system" ]; then
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  rm -f "/Library/LaunchDaemons/$LABEL.plist"
else
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
fi
echo "Light Runner service removed. Your show and settings in data/ are kept."
