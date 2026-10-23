#!/usr/bin/env bash
# Installs (or updates) Light Runner on a Raspberry Pi, as a service that starts when the Pi starts.
#
#   curl -fsSL https://github.com/ilmars/LightRunner/releases/latest/download/install-pi.sh | sudo bash
#
# Run it again to update: the show, backups and settings in /var/lib/light-runner stay as they are.
#
# For testing and offline installs:
#   LR_TARBALL=/path/light-runner-linux-arm64.tar.gz   use this file instead of downloading
#   LR_ROOT=/some/folder                               a dry run: every path is put under this folder, and
#                                                      nothing is changed on the computer itself (no users,
#                                                      no apt, no systemctl). Normal people never set it.
#
# Everything is inside main(), which is called on the last line: a download that stops half way runs nothing.

set -euo pipefail

REPO="ilmars/LightRunner"
INSTALL_URL="https://github.com/${REPO}/releases/latest/download/install-pi.sh"
SERVICE="light-runner"
RUN_USER="lightrunner"
PORT=8080

ROOT="${LR_ROOT:-}"
DRY=0
if [ -n "$ROOT" ]; then DRY=1; fi

INSTALL_DIR="${ROOT}/opt/light-runner"
NEW_DIR="${ROOT}/opt/light-runner.new"
OLD_DIR="${ROOT}/opt/light-runner.old"
DATA_DIR="${ROOT}/var/lib/light-runner"
UNIT_FILE="${ROOT}/etc/systemd/system/${SERVICE}.service"
TMP=""

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

die() {
  printf '\nLight Runner was not installed.\n%s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
  # Only there if something went wrong before the new version was put in place.
  if [ -d "$NEW_DIR" ]; then rm -rf "$NEW_DIR"; fi
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

write_unit() {
  cat > "$UNIT_FILE" <<'LIGHT_RUNNER_UNIT'
[Unit]
Description=Light Runner
After=network-online.target
Wants=network-online.target

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
    useradd --system --user-group --home-dir /var/lib/light-runner --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
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
    return
  fi
  mkdir -p "$DATA_DIR"
  chmod 750 "$DATA_DIR"
  run chown "${RUN_USER}:${RUN_USER}" "$DATA_DIR"
  say "Made ${DATA_DIR}"
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
    say "  (dry run) would run: apt-get install -y libasound2t64 (or libasound2)"
    return
  fi
  # Nothing may read from the script that is being piped in, so apt gets no input.
  export DEBIAN_FRONTEND=noninteractive
  if ! apt-get install -y libasound2t64 </dev/null && ! apt-get install -y libasound2 </dev/null; then
    say "Warning: could not add the sound library libasound2, so MIDI controllers (like the APC mini) won't work."
    say "Everything else will. To add it later, run: sudo apt-get install libasound2t64"
  fi
}

stop_service() {
  if [ "$DRY" = 1 ]; then
    say "  (dry run) would stop ${SERVICE} if it is running"
    return
  fi
  if systemctl is-active --quiet "$SERVICE"; then
    say "Stopping the running Light Runner (it saves the stage first)"
    systemctl stop "$SERVICE"
  fi
}

swap_in() {
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$OLD_DIR"
    mv "$INSTALL_DIR" "$OLD_DIR"
  fi
  if ! mv "$NEW_DIR" "$INSTALL_DIR"; then
    if [ -d "$OLD_DIR" ]; then mv "$OLD_DIR" "$INSTALL_DIR"; fi
    die "Could not put the new version in ${INSTALL_DIR}. The old one is back where it was."
  fi
  rm -rf "$OLD_DIR"
  say "Installed Light Runner ${VERSION} in /opt/light-runner"
}

install_service() {
  mkdir -p "$(dirname "$UNIT_FILE")"
  write_unit
  chmod 644 "$UNIT_FILE"
  run systemctl daemon-reload
  run systemctl enable "$SERVICE"
  run systemctl restart "$SERVICE"
}

wait_for_server() {
  ANSWERED=0
  if [ "$DRY" = 1 ]; then
    say "  (dry run) would wait for http://127.0.0.1:${PORT}/ to answer"
    ANSWERED=1
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    ANSWERED=1
    return
  fi
  local i
  for i in $(seq 1 15); do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
      ANSWERED=1
      return
    fi
    sleep 1
  done
}

print_summary() {
  local ip="" a name
  for a in $(hostname -I 2>/dev/null || true); do
    case "$a" in
      *.*.*.*) ip="$a"; break ;;
    esac
  done
  name="$(hostname)"

  if [ "$ANSWERED" = 1 ]; then
    printf '\nLight Runner %s is installed and running.\n' "$VERSION"
  else
    printf '\nLight Runner %s is installed, but it did not answer within 15 seconds.\n' "$VERSION"
    say "It may still be starting. To see what it says, run:"
    say "  journalctl -u ${SERVICE} -f"
  fi
  say ""
  say "Open this on the iPads:"
  if [ -n "$ip" ]; then say "  http://${ip}:${PORT}/operator/"; fi
  say "  http://${name}.local:${PORT}/operator/"
  say ""
  say "Settings (for the programmer) are at /settings/ on the same address."
  say "Light Runner starts by itself when the Pi starts. Nothing is sent to the lights until someone"
  say "turns on Send DMX in Settings, as on any first start (it begins with the demo rig, with Send DMX off)."
  say ""
  say "To read its log:        journalctl -u ${SERVICE} -f"
  say "To update Light Runner: run the same install command again. The show and backups stay."
}

main() {
  umask 022
  trap cleanup EXIT

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

  step "Installing"
  stop_service
  swap_in
  install_service

  step "Starting"
  wait_for_server
  print_summary
}

main "$@"
