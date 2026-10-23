# One-file install: design

Date: 22 Oct 2026. Status: agreed with Ilmārs (22 Oct).

## Why

Today Light Runner needs Node 24, a terminal, `npm install`, a start command and sometimes environment variables. A volunteer can't do that, and nor can another church that wants to try it. The owner wants it to install from one file and just work, "like Companion" (Bitfocus Companion: an installer per system, a small launcher window, runs in the background).

## Goals

- **One download per system, nothing else to install first** (Node, the MIDI add-on and everything else are inside):
  - **Mac**: a `.dmg`; drag Light Runner into Applications. Apple Silicon and Intel.
  - **Windows**: `Light Runner Setup.exe`; next, next, finish.
  - **Raspberry Pi** (64-bit Raspberry Pi OS): one install command pasted into the Pi's terminal, as Companion's Pi install does. It installs Light Runner as a service that starts when the Pi starts; no screen needed.
- **A launcher window on Mac and Windows**, like Companion's:
  - Status: running or stopped, and whether it is sending to the lights (the same plain words as the operator page's pill).
  - The address for the iPads in big text (`http://<this computer>:8080`), with a QR code, and the network it is on (a choice when the computer has more than one).
  - Buttons: Open the operator page, Open Settings, Stop / Start.
  - Settings: the port; **Start when the computer starts** (on by default); **Test mode: don't send to the lights** (replaces `LIGHT_RUNNER_OUTPUT=none`).
  - Closing the window keeps Light Runner running in the menu bar (Mac) or system tray (Windows); Quit is in that menu, and asks first ("The lights stop following the iPads").
  - The version, and a quiet "Version X is available" line with a link when GitHub has a newer release (no automatic update).
- **No environment variables, no terminal, no npm** for the person installing. The show, backups, runtime state and fixture database live in the system's usual place for app data (Mac `~/Library/Application Support/Light Runner`, Windows `%APPDATA%\Light Runner`, Pi `/var/lib/light-runner` or the service user's home). The first start loads the demo rig, as today.
- **Updates are a manual install** of the new version over the old one; the show, backups and settings stay.
- **The releases are built by GitHub** (a workflow on a version tag) for all three systems, so nobody packages by hand. The repository and `npm start` keep working for development exactly as now.

## Non-goals

- Automatic updates; an App Store or Microsoft Store listing; code signing and notarisation beyond what's needed to open the app (see open questions); a Pi desktop launcher; changing what the server does.

## Anti-goals

- An install that can silently send to the lights before someone has chosen to (the demo rig plus Send DMX as it is today is fine; nothing new may switch output on by itself).
- Two copies of Light Runner running on one computer writing the same data (the launcher must refuse to start a second one and show the running one instead).

## Constraints

- Node 24 with `.ts` run by type stripping (no build step today); the optional `@julusian/midi` native add-on per system and CPU; the DMX worker thread; serial (ENTTEC USB) support.
- Ports and the firewall: Windows asks to allow the network on first start; the launcher says what to choose.
- Works offline (already true: Inter and the icon are served by Light Runner).

## Left to the builder

- How to bundle (for example an Electron or Tauri launcher that starts the server as a child process with a bundled Node 24, or a single Node executable plus a small native launcher), as long as the goals hold and the dev workflow stays the same.
- The tray/menu-bar details, the QR library (or a small built-in encoder), the GitHub workflow and how the Pi install script is hosted (a release asset is enough).

## Decided by the owner

1. **Ship unsigned first.** The Mac's "unidentified developer" and Windows' SmartScreen warnings on first open are accepted; the README says in one line how to open it the first time. Signing can come later.
2. **No import from the old folder.** The owner moves the church's show by Settings › Export show file and importing it into the installed version.
