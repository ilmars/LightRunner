# One-file install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light Runner installs from one file on Mac and Windows (with a Companion-like launcher) and from one command on a Raspberry Pi (as a service), with no environment variables, terminal or npm for the person installing.

**Architecture:** A small Electron launcher (`launcher/`, its own package, never pulled in by the root `npm install`) shows the window, tray/menu-bar icon and settings, and runs the unchanged server as a child process on a **bundled official Node 24** (so type stripping and the `@julusian/midi` prebuilds work as today), passing the data folder, port and test mode to it. electron-builder makes the `.dmg` and the NSIS `Setup.exe`; a tarball plus `install-pi.sh` and a systemd unit cover the Pi. A GitHub workflow builds all of them.

**Tech Stack:** Node 24 (server, unchanged), Electron + electron-builder (launcher only), `qrcode` (launcher only), plain JS ESM in the launcher (like `web/`), node:test, bash + systemd on the Pi, GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-10-22-installer-design.md](../specs/2026-10-22-installer-design.md)

## Global Constraints

- Branch `installer` (already created from main); main checkout, no worktree; never push or tag — the controller asks the owner before any push.
- The server and `npm start` / `npm test` / dev workflow stay exactly as today; the root `package.json` gains no Electron dependency.
- Nothing new may switch output on by itself: a fresh install starts with the demo rig exactly as `npm start` does today.
- One copy per computer: a second launcher shows the running one (Electron single-instance lock), and a busy port is reported in plain words, never a second server on the same data.
- Data folder: Electron `app.getPath('userData')` (Mac `~/Library/Application Support/Light Runner`, Windows `%APPDATA%\Light Runner`); Pi `/var/lib/light-runner`.
- Launcher defaults: port 8080, Start when the computer starts **on**, Test mode **off**.
- Plain words, sentence case, the design-system look (`web/shared/theme.css` tokens, Inter, the icon) in the launcher window; 44 px targets.
- Downloads: only npm packages (Electron, electron-builder, qrcode) — the controller gets the owner's OK before the first `npm install` in `launcher/`. The Node 24 binary is taken from the build machine (`process.execPath`), never downloaded by hand.
- `npm test`, `npm run typecheck`, `npm run jump-check` pass before every commit.

## Review Focus

1. Quitting the launcher (or the computer shutting down) saves the stage like Ctrl+C does today — no lost runtime or half-written show. (Task 1 test; Task 3 check.)
2. The port is already taken (another Light Runner started by hand, Companion on 8080…): the launcher says so in plain words and offers to change the port; it never loops restarting. (Task 2 test.)
3. The computer has several networks (Wi-Fi + Ethernet, a VPN): the iPad address shows the right one and lets the user pick. (Task 2 test.)
4. The server child crashes: the launcher shows "Stopped" with the last lines of its log and a Start button; it restarts it at most once by itself. (Task 2 test.)
5. Start at login launches hidden to the tray/menu bar and starts the server, without a window popping up in front of the service. (Task 3 check.)

---

### Task 1: The server runs well under a launcher

**Files:** Modify `server/src/main.ts`. Test: `server/test/launcher-child.test.ts` (new).

- A child started with an IPC channel shuts down cleanly on the message `{ type: 'shutdown' }` (the same `shutdown()` path as SIGINT/SIGTERM, which matter little on Windows where `kill()` is forceful).
- When it is listening, it sends `{ type: 'ready', port }` over IPC (only if `process.send` exists); if listening fails (port in use), it sends `{ type: 'error', code: 'port-in-use' | 'start-failed', message }` and exits with code 2.
- [ ] Test (spawn `node server/src/main.ts` with `stdio: ['ignore','pipe','pipe','ipc']`, a temp `LIGHT_RUNNER_DATA`, `LIGHT_RUNNER_OUTPUT=none`, a free `PORT`): `ready` arrives with the port; after a command changes the stage, `shutdown` makes it exit 0 and `runtime.json` holds that stage; a second child on the same port reports `port-in-use` and exits 2.
- [ ] Implement; run checks; commit "Server: a launcher can start it, hear when it is ready and stop it cleanly".

### Task 2: Launcher core (no Electron)

**Files:** Create `launcher/package.json` (name `light-runner-launcher`, private, `"type": "module"`, version read from the root `package.json` at build time), `launcher/src/config.js`, `launcher/src/net.js`, `launcher/src/version.js`, `launcher/src/server-process.js`; tests `launcher/test/*.test.js`; add `"launcher/test/*.test.js"` to the root `test` script.

**Interfaces — Produces:**
- `loadConfig(file) → { port: number, startAtLogin: boolean, testMode: boolean, address: string | null }` (defaults 8080 / true / false / null; bad or missing file → defaults); `saveConfig(file, config)` (atomic write).
- `lanAddresses(interfaces = os.networkInterfaces()) → { name: string, address: string }[]` — IPv4, not internal, not link-local 169.254.x; Ethernet and Wi-Fi first; `pickAddress(list, saved)`.
- `newerVersion(current: string, latestTag: string) → string | null` (`'v0.3.0'` vs `'0.2.1'` → `'0.3.0'`; equal/older/garbage → null).
- `class ServerProcess` (constructor `{ nodePath, appDir, dataDir, spawn = child_process.spawn }`): `start({ port, testMode })`, `stop()` (IPC shutdown, then kill after 5 s), `status` (`'starting' | 'running' | 'stopped' | 'failed'`), `lastLines` (last 30 log lines), `onChange(cb)`; passes `PORT`, `LIGHT_RUNNER_DATA`, `LIGHT_RUNNER_OUTPUT=none` only in test mode; restarts once after an unexpected exit, then stays `failed`; `port-in-use` → `failed` with that code, no restart.
- [ ] Tests first (fake spawn for ServerProcess; Review Focus 2–4 each a test); implement; run checks; commit "Launcher: settings, addresses, version check and the server process".

### Task 3: The launcher app (Electron)

**Files:** Create `launcher/main.js`, `launcher/preload.js`, `launcher/ui/index.html`, `launcher/ui/launcher.js`, `launcher/ui/launcher.css` (uses `web/shared/theme.css` tokens and fonts, copied at build), `launcher/electron-builder.yml`, `launcher/scripts/stage-app.mjs`; `launcher/README.md` (how to build).

- Window as the spec's "launcher window": status (running/stopped/starting, and the operator page's problem words from `GET /api/state`), the iPad address in big text with a QR code (`qrcode`) and an address picker when there are several, Open the operator page / Open Settings (default browser), Stop / Start, Port, Start when the computer starts (`app.setLoginItemSettings`), Test mode (restarts the server), version + "Version X is available" link (GitHub `releases/latest`, at most once a day, silent when offline).
- Windows: the first start shows a one-line note under the address, "If Windows asks, allow Light Runner on private networks, so the iPads can reach it", until the first iPad has connected.
- Single instance (`requestSingleInstanceLock`: the second launch focuses the first). Closing the window hides it to the tray (Windows) / menu bar (Mac); the tray menu has Open window, Open operator page, Quit (asks: "The lights stop following the iPads. Quit Light Runner?"). Started at login → hidden, server started.
- `stage-app.mjs` copies into `launcher/build/app/`: `server/`, `packages/`, `web/`, `shows/`, root `package.json`, production `node_modules` (incl. the MIDI and serial prebuilds for this machine), and `node`/`node.exe` from `process.execPath`; electron-builder takes it as `extraResources` (not in asar, so the child Node can read it). Mac: `dmg` for the build machine's arch; Windows: `nsis` x64, per-user install, desktop shortcut.
- [ ] Implement; build a Windows unpacked app locally (`npm run dist -- --win --dir`) and check by hand: first start shows the demo rig on 8080, the QR code opens the operator page from a phone on the same network, Stop/Start, change port, Test mode, close-to-tray and Quit (stage saved), a second launch focuses the first, port taken by a dev server shows the plain message; screenshots.
- [ ] Run checks; commit "Launcher: the Light Runner window, tray and the Mac and Windows installers".

### Task 4: Raspberry Pi

**Files:** Create `packaging/pi/install-pi.sh`, `packaging/pi/light-runner.service`, `launcher/scripts/pack-linux.mjs` (tarball `light-runner-linux-<arch>.tar.gz`: the same app files + `node`).

- `install-pi.sh` (run as `curl -fsSL https://github.com/ilmars/LightRunner/releases/latest/download/install-pi.sh | sudo bash`): checks 64-bit Raspberry Pi OS / Debian arm64 (refuses anything else in plain words), creates user `lightrunner` (in `audio` and `dialout` for MIDI and USB DMX), installs to `/opt/light-runner` (replacing the old version, keeping `/var/lib/light-runner`), installs and starts the service, prints the address for the iPads. Re-running it updates.
- The unit: `ExecStart=/opt/light-runner/node /opt/light-runner/app/server/src/main.ts`, `Environment=LIGHT_RUNNER_DATA=/var/lib/light-runner` and `PORT=8080`, `Restart=on-failure`, `KillSignal=SIGINT`, `User=lightrunner`.
- [ ] `bash -n` and `shellcheck` (if available) pass; a dry run against a temp root (`LR_ROOT=…`) in WSL or Git Bash if available, else say so; commit "Raspberry Pi: one install command and a service".

### Task 5: Releases on GitHub

**Files:** Create `.github/workflows/release.yml`.

- Triggers: tag `v*` (builds and publishes a GitHub release with every asset and `install-pi.sh`) and `workflow_dispatch` (builds and uploads workflow artifacts only, no release).
- Matrix: `macos-14` (arm64 dmg), `macos-13` (x64 dmg), `windows-latest` (x64 Setup.exe), `ubuntu-24.04-arm` (linux-arm64 tarball), `ubuntu-latest` (linux-x64 tarball); each: setup-node 24, `npm ci`, `npm test`, `npm ci --omit=dev`, `cd launcher && npm ci && npm run dist` (or `pack-linux`).
- [ ] `actionlint` if available, else a careful read; commit "Releases: GitHub builds the Mac, Windows and Pi downloads".

### Task 6: Docs

**Files:** `README.md` (an Install section first: the downloads, the one-line first-open note for Mac "right-click › Open" and Windows "More info › Run anyway", the Pi command; Running from source stays below), `docs/running-a-service.md` (start = open Light Runner; no Terminal), `.claude/skills/light-runner-service/SKILL.md` (the installed app first, the terminal only for source installs), `docs/STATUS.md` (Not built yet item 1 done on Mac/Windows/Pi; the unsigned warning as a known issue), `docs/DECISIONS.md` (Electron launcher + bundled Node; unsigned first; no import from the old folder).
- [ ] Commit "Docs: installing Light Runner from one file".
