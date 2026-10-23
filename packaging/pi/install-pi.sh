#!/usr/bin/env bash
# Installs (or updates) Light Runner on a Raspberry Pi, as a service that starts when the Pi starts.
#
#   curl -fsSL https://github.com/ilmars/LightRunner/releases/latest/download/install-pi.sh | sudo bash
#
# Run it again to update: the show, backups and settings in /var/lib/light-runner stay as they are.
# If an update goes wrong half way, the previous version stays (or is put back) and is started again.
#
# For testing and offline installs:
#   LR_TARBALL=/path/light-runner-linux-arm64.tar.gz   use this file instead of downloading
#   LR_ROOT=/some/folder                               a dry run: every path is put under this (existing) folder,
#                                                      and nothing is changed on the computer itself (no users,
#                                                      no apt, no systemctl). Normal people never set it.
#
# Everything is inside main(), which is called on the last line: a download that stops half way runs nothing.

set -euo pipefail

REPO="ilmars/LightRunner"
INSTALL_URL="https://github.com/${REPO}/releases/latest/download/install-pi.sh"
SERVICE="light-runner"
RUN_USER="lightrunner"
PORT=8080

# Set by init_paths.
ROOT=""
DRY=0
INSTALL_DIR=""
NEW_DIR=""
OLD_DIR=""
DATA_DIR=""
UNIT_FILE=""

# What has happened so far, so that cleanup can undo a half-finished update.
TMP=""
WAS_ACTIVE=0   # the service was running before the update
MOVED_OLD=0    # the old version was moved aside to /opt/light-runner.old
DONE=0         # the new version is in place and the service was started

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

die() {
  printf '\nThe install did not finish.\n%s\n' "$*" >&2
  exit 1
}

# True when the folder holds an install that can run.
usable_install() {
  [ -x "$1/node" ] && [ -f "$1/app/server/src/main.ts" ]
}

# Runs on every exit, including Ctrl-C and a failure. If the update stopped half way, the old version stays or comes
# back, and if it was running it is started again.
cleanup() {
  set +e
  trap - EXIT
  local restored=0
  if [ "$MOVED_OLD" = 1 ] && [ "$DONE" = 0 ] && [ -d "$OLD_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    if mv "$OLD_DIR" "$INSTALL_DIR"; then restored=1; fi
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
  if [ "$DONE" = 0 ] && [ -n "$NEW_DIR" ] && [ -d "$NEW_DIR" ]; then rm -rf "$NEW_DIR"; fi
  if [ "$DONE" = 0 ] && [ "$WAS_ACTIVE" = 1 ] && usable_install "$INSTALL_DIR"; then
    if [ "$restored" = 1 ]; then
      printf '\nThe update stopped, so the previous version of Light Runner is back.\n' >&2
    else
      printf '\nThe update stopped. The previous version of Light Runner is still installed.\n' >&2
    fi
    if [ "$DRY" = 1 ]; then
      say "  (dry run) would start ${SERVICE} again" >&2
    else
      systemctl reset-failed "$SERVICE" </dev/null 2>/dev/null
      if systemctl start "$SERVICE" </dev/null; then
        printf 'The old version is running again, and the lights are as they were.\n' >&2
      else
        printf 'It could not be started again. To see why, run: journalctl -u %s -n 50\n' "$SERVICE" >&2
      fi
    fi
  fi
  return 0
}

# Runs a command that changes the computer itself; a dry run only says what it would do.
run() {
  if [ "$DRY" = 1 ]; then
    say "  (dry run) would run: $*"
  else
    "$@"
  fi
}

# With LR_ROOT every path goes under that folder. It must be a real folder, never the whole computer.
init_paths() {
  if [ "${LR_ROOT+set}" = set ]; then
    if [ -z "$LR_ROOT" ] || [ ! -d "$LR_ROOT" ]; then
      die "LR_ROOT must be an existing folder (it is for dry runs). It is '${LR_ROOT}'."
    fi
    ROOT="$(cd "$LR_ROOT" && pwd -P)"
    if [ -z "$ROOT" ] || [ "$ROOT" = "/" ]; then
      die "LR_ROOT can't be the whole computer ('/'). It is for a dry run in a folder of its own."
    fi
    DRY=1
  fi
  INSTALL_DIR="${ROOT}/opt/light-runner"
  NEW_DIR="${ROOT}/opt/light-runner.new"
  OLD_DIR="${ROOT}/opt/light-runner.old"
  DATA_DIR="${ROOT}/var/lib/light-runner"
  UNIT_FILE="${ROOT}/etc/systemd/system/${SERVICE}.service"
}

write_unit() {
  cat > "$UNIT_FILE" <<'LIGHT_RUNNER_UNIT'
[Unit]
Description=Light Runner
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=lightrunner
Group=lightrunner
WorkingDirectory=/var/lib/light-runner
Environment=LIGHT_RUNNER_DATA=/var/lib/light-runner
Environment=PORT=8080
ExecStart=/opt/light-runner/node /opt/light-runner/app/server/src/main.ts
Restart=on-failure
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
LIGHT_RUNNER_UNIT
}

check_computer() {
  if [ "$DRY" = 0 ] && [ "$(id -u)" -ne 0 ]; then
    die "It needs to run as the administrator. Run it with sudo:
  curl -fsSL ${INSTALL_URL} | sudo bash"
  fi

  if [ ! -r /etc/debian_version ] || ! command -v dpkg >/dev/null 2>&1; then
    die "Light Runner's Pi install works on Raspberry Pi OS (or Debian or Ubuntu). This computer is something else."
  fi

  # A Pi can run a 64-bit kernel with a 32-bit system, so ask the system's packages, not the kernel.
  local arch
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    arm64) ARCH="arm64" ;;
    amd64) ARCH="x64" ;;
    *) die "Light Runner needs the 64-bit Raspberry Pi OS. This one is '${arch}' (32-bit).
Install \"Raspberry Pi OS (64-bit)\" on the SD card with Raspberry Pi Imager, then run this command again." ;;
  esac

  if [ "$DRY" = 0 ] && [ ! -d /run/systemd/system ]; then
    die "Light Runner starts itself with systemd, and this computer is not running it. Raspberry Pi OS does."
  fi
}

fetch_tarball() {
  TMP="$(mktemp -d)"
  if [ -n "${LR_TARBALL:-}" ]; then
    [ -r "$LR_TARBALL" ] || die "Can't read ${LR_TARBALL}."
    TARBALL="$LR_TARBALL"
    say "Using ${TARBALL}"
    return
  fi
  command -v curl >/dev/null 2>&1 || die "It needs curl to download Light Runner. Install it with: sudo apt-get install -y curl"
  local url="https://github.com/${REPO}/releases/latest/download/light-runner-linux-${ARCH}.tar.gz"
  TARBALL="${TMP}/light-runner.tar.gz"
  say "Downloading ${url}"
  curl -fSL --retry 3 -o "$TARBALL" "$url" || die "The download failed. Check that the Pi is on the internet, then run the command again."
}

unpack() {
  rm -rf "$NEW_DIR"
  mkdir -p "$NEW_DIR"
  chmod 755 "$NEW_DIR"
  tar -xzf "$TARBALL" -C "$NEW_DIR" --no-same-owner || die "The download could not be unpacked. It may be damaged; run the command again."
  if [ ! -f "$NEW_DIR/app/server/src/main.ts" ] || [ ! -f "$NEW_DIR/node" ]; then
    die "That file is not a Light Runner download for the Pi."
  fi
  chmod 755 "$NEW_DIR/node"
  "$NEW_DIR/node" --version >/dev/null 2>&1 || die "The Node that comes with Light Runner does not run on this computer (it is built for ${ARCH}).
Is this the 64-bit Raspberry Pi OS?"
  VERSION="unknown"
  if [ -r "$NEW_DIR/VERSION" ]; then VERSION="$(head -n 1 "$NEW_DIR/VERSION")"; fi
}

make_user() {
  if [ "$DRY" = 1 ]; then
    say "  (dry run) would make the user ${RUN_USER} (groups audio and dialout), if it is not there yet"
    return
  fi
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    # A group of that name left behind (by an earlier install) is used as it is.
    if getent group "$RUN_USER" >/dev/null 2>&1; then
      useradd --system --gid "$RUN_USER" --home-dir /var/lib/light-runner --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
    else
      useradd --system --user-group --home-dir /var/lib/light-runner --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
    fi
    say "Made the user ${RUN_USER}"
  fi
  # audio: MIDI controllers. dialout: USB DMX boxes (ENTTEC). Adding a user again to a group is harmless.
  local group
  for group in audio dialout; do
    if getent group "$group" >/dev/null 2>&1; then usermod -aG "$group" "$RUN_USER"; fi
  done
}

make_data_dir() {
  if [ -d "$DATA_DIR" ]; then
    say "Keeping ${DATA_DIR} (the show, backups and settings) as it is"
  else
    mkdir -p "$DATA_DIR"
    chmod 750 "$DATA_DIR"
    say "Made ${DATA_DIR}"
  fi
  # Only who owns it changes, never what is in it: a folder copied in with sudo, or left by a trial run as root,
  # would otherwise keep Light Runner from saving anything.
  run chown -R "${RUN_USER}:${RUN_USER}" "$DATA_DIR"
}

# MIDI controllers need ALSA's library. Light Runner works without it, so a failure here only warns.
check_alsa() {
  local libs
  libs="$(ldconfig -p 2>/dev/null || true)"
  case "$libs" in
    *libasound.so.2*) return ;;
  esac
  say "Adding the sound library that MIDI controllers need (libasound2)"
  if [ "$DRY" = 1 ]; then
    say "  (dry run) would run: apt-get update, then apt-get install -y libasound2t64 (or libasound2)"
    return
  fi
  # Nothing may read from the script that is being piped in, so apt gets no input.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq </dev/null >/dev/null 2>&1 || true
  if ! apt-get install -y libasound2t64 </dev/null && ! apt-get install -y libasound2 </dev/null; then
    say "Warning: could not add the sound library libasound2, so MIDI controllers (like the APC mini) won't work."
    say "Everything else will. To add it later, run: sudo apt-get install libasound2t64"
  fi
}

check_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    say "Warning: Python 3 is not installed. Everything works except \"Compare with a Lightkey file\" in Settings."
    say "To add it, run: sudo apt install python3"
  fi
}

# Always stopped, even when it looks stopped or is in a crash loop that would start it again in the middle of the swap.
stop_service() {
  if [ "$DRY" = 1 ]; then
    say "  (dry run) would stop ${SERVICE}"
    return
  fi
  if systemctl is-active --quiet "$SERVICE"; then
    WAS_ACTIVE=1
    say "Stopping the running Light Runner (it saves the stage first)"
  fi
  systemctl stop "$SERVICE" </dev/null 2>/dev/null || true
}

# A leftover /opt/light-runner.old (from an update that was killed) goes before the service is stopped, so
# nothing deletes it while the swap is under way. If the install itself is gone, the leftover is put back.
tidy_leftover() {
  [ -e "$OLD_DIR" ] || return 0
  if usable_install "$INSTALL_DIR"; then
    rm -rf "$OLD_DIR"
  elif usable_install "$OLD_DIR"; then
    say "An earlier update was cut short: putting the previous version back first"
    rm -rf "$INSTALL_DIR"
    mv "$OLD_DIR" "$INSTALL_DIR"
  else
    rm -rf "$OLD_DIR"
  fi
  [ ! -e "$OLD_DIR" ] || die "Could not remove ${OLD_DIR}. Remove it by hand: sudo rm -rf /opt/light-runner.old"
}

swap_in() {
  if [ -d "$INSTALL_DIR" ]; then
    mv "$INSTALL_DIR" "$OLD_DIR"
    MOVED_OLD=1
  fi
  mv "$NEW_DIR" "$INSTALL_DIR" || die "Could not put the new version in /opt/light-runner."
}

install_service() {
  mkdir -p "$(dirname "$UNIT_FILE")"
  write_unit
  chmod 644 "$UNIT_FILE"
  run systemctl daemon-reload
  # A start-limit failure from an earlier run must not keep the restart from happening.
  run systemctl reset-failed "$SERVICE" || true
  run systemctl enable "$SERVICE"
  run systemctl restart "$SERVICE"
}

# Light Runner is up when the service is running and the program answering on the port is that very process
# (the server names its process in a header). READY is up, other (another program has the port) or none.
wait_for_server() {
  READY=none
  UNIT_STATE=active
  if [ "$DRY" = 1 ]; then
    say "  (dry run) would wait for http://127.0.0.1:${PORT}/ to answer"
    READY=up
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    READY=unchecked
    return
  fi
  local deadline=$((SECONDS + 15)) headers got pid
  while [ "$SECONDS" -lt "$deadline" ]; do
    READY=none
    headers="$(curl -sS -D - -o /dev/null --connect-timeout 1 --max-time 2 "http://127.0.0.1:${PORT}/api/state" 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$headers" ]; then
      got="$(printf '%s\n' "$headers" | awk -F': *' 'tolower($1) == "x-light-runner-pid" { print $2 }' | head -n 1 || true)"
      pid="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)"
      if [ -n "$got" ] && [ "$got" = "$pid" ] && [ "$pid" != "0" ] && systemctl is-active --quiet "$SERVICE"; then
        READY=up
        return
      fi
      READY=other
    fi
    sleep 1
  done
  UNIT_STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
}

print_summary() {
  local a name ips="" others=""
  for a in $(hostname -I 2>/dev/null || true); do
    case "$a" in
      172.17.*) others="${others} ${a}" ;;   # Docker's own network, not the one the iPads are on
      *.*.*.*) ips="${ips} ${a}" ;;
    esac
  done
  if [ -z "$ips" ]; then ips="$others"; fi
  name="$(hostname)"

  case "$READY" in
    up | unchecked)
      printf '\nLight Runner %s is installed and running.\n' "$VERSION"
      say ""
      say "Open this on the iPads:"
      for a in $ips; do say "  http://${a}:${PORT}/operator/"; done
      say "  http://${name}.local:${PORT}/operator/"
      say ""
      say "Settings (for the programmer) are at /settings/ on the same address."
      say "Light Runner starts by itself when the Pi starts. Nothing is sent to the lights until someone"
      say "turns on Send DMX in Settings, as on any first start (it begins with the demo rig, with Send DMX off)."
      ;;
    other)
      printf '\nLight Runner %s is installed, but it could not start: Port %s is used by another program.\n' "$VERSION" "$PORT"
      say "Stop that program (or move it to another port), then run: sudo systemctl restart ${SERVICE}"
      ;;
    *)
      case "$UNIT_STATE" in
        failed | activating)
          printf '\nLight Runner %s is installed, but it stopped with an error.\n' "$VERSION"
          ;;
        *)
          printf '\nLight Runner %s is installed, but it did not answer within 15 seconds.\n' "$VERSION"
          ;;
      esac
      ;;
  esac
  if [ "$READY" != up ] && [ "$READY" != unchecked ] && [ -d "$OLD_DIR" ]; then
    say "The previous version is kept at /opt/light-runner.old."
  fi
  say ""
  say "To read its log:        journalctl -u ${SERVICE} -f"
  say "To update Light Runner: run the same install command again. The show and backups stay."
}

main() {
  umask 022
  init_paths
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  if [ "$DRY" = 1 ]; then say "Dry run: nothing on this computer is changed. Files go under ${ROOT}"; fi

  step "Checking this computer"
  check_computer

  step "Getting Light Runner"
  fetch_tarball

  step "Unpacking"
  unpack

  step "Setting up"
  mkdir -p "${ROOT}/opt"
  make_user
  make_data_dir
  check_alsa
  check_python

  step "Installing"
  tidy_leftover
  stop_service
  swap_in
  install_service
  DONE=1
  say "Installed Light Runner ${VERSION} in /opt/light-runner"

  step "Starting"
  wait_for_server
  # The previous version goes only once the new one answers.
  if [ "$READY" = up ] || [ "$READY" = unchecked ]; then rm -rf "$OLD_DIR"; fi
  print_summary
}

main "$@"
