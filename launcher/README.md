# The Light Runner launcher

The window people see when they install Light Runner on a Mac or a Windows PC: it starts the server, shows the address for the iPads (with a code for the camera), and keeps Light Runner running in the menu bar (Mac) or the tray (Windows) when the window is closed. It is an Electron app of its own; the root `package.json` doesn't depend on it, and `npm start` / `npm test` in the root work without it.

The server is the same `server/src/main.ts` as `npm start`, run as a child process on a Node 24 that comes inside the app (the build machine's own). The launcher passes it the data folder, the port and Test mode:

| | Mac | Windows |
| --- | --- | --- |
| Data folder (the show, backups, `launcher.json`) | `~/Library/Application Support/Light Runner` | `%APPDATA%\Light Runner` |
| Installer | `Light Runner <version> <arch>.dmg` (the build machine's processor) | `Light Runner Setup <version>.exe` (x64, for this user, no questions) |

## Building

On the system you are building for (a Mac makes the `.dmg`, Windows the `Setup.exe`), with the official Node 24 from nodejs.org (Homebrew's Node needs Homebrew's libraries and won't run on another Mac; the build says so and stops):

```bash
npm install                 # in the repository root: the server's packages, with the MIDI and serial add-ons for this machine
cd launcher
npm install                 # Electron, electron-builder and qrcode, for the launcher only
npm run dist                # the installer for this system, in launcher/dist
npm run dist -- --win --dir # Windows: only the unpacked app (launcher/dist/win-unpacked), quicker to try
```

`npm run dist` first runs `scripts/stage-app.mjs`, which copies into `launcher/build/app` what the installed app runs: `server/`, `packages/`, `web/`, `shows/`, the Lightkey importer, the root `package.json`, the production `node_modules` and `node` (`node.exe`). electron-builder puts that folder in the app as `resources/lightrunner`, outside the asar, so the bundled Node can read it. The version is the root `package.json`'s. Nothing is signed yet: Windows' SmartScreen and the Mac's Gatekeeper ask once (the Mac build has an ad-hoc signature, so Apple Silicon runs it).

electron-builder downloads its own tools the first time (Electron for the target, NSIS on Windows) into its cache.

## Trying it while developing

```bash
cd launcher
npm start   # copies the design system files for the window, then opens it on the repository's own server
```

While developing the launcher runs the repository's server on the `node` on the PATH (or `LIGHT_RUNNER_NODE`), with the data folder above, or `LIGHT_RUNNER_DATA` if it is set. It never adds itself to the login items then; only the installed app does.

## How it behaves

- One per computer: a second launch shows the first one's window. A Light Runner already running on the same data folder (started by hand, or left by a launcher that crashed) is shown as running, with **Stop it**; one that doesn't answer has to be ended by hand, and the window says how. Another program on the port: the window says so and offers another port.
- Closing the window keeps it running in the tray / menu bar. **Quit** (in that menu, or Cmd+Q on the Mac) asks first, then saves the stage and stops the server.
- **Start when the computer starts** (on after the first start) puts it in the login items; it then starts hidden, with the server running.
- `Light Runner --quit` stops a running Light Runner on this computer (the launcher and its server, saving the stage) and returns when they have gone. The Windows installer and uninstaller run it before they replace or remove the files (`resources/installer.nsh`); the uninstaller also takes it out of the login items.
- Once a day at most, it asks GitHub for the latest release and shows "Version X is available" when there is a newer one (nothing when offline).

## Files

| Path | What |
| --- | --- |
| `main.js` | The Electron main process: window, tray, menus, login item, quitting, the version check |
| `preload.js`, `ui/` | The window (plain HTML, CSS and JS; `ui/shared/` is copied from `web/shared` and not in git) |
| `src/` | The parts without Electron, tested in `test/`: settings, addresses, the server process, the window's words |
| `electron-builder.yml`, `resources/` | The installers: config, icons, the NSIS additions |
| `assets/` | The tray and menu bar icons |
| `scripts/` | `stage-app.mjs`, `dist.mjs`, and `make-icons.mjs` (draws the icons from `web/shared/icon*.svg`: `npm run icons`) |
