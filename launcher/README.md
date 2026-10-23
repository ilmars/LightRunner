# The Light Runner launcher

The window people see when they install Light Runner on a Mac or a Windows PC: it starts the server, shows the address for the iPads (with a code for the camera), and keeps Light Runner running in the menu bar (Mac) or the tray (Windows) when the window is closed. It is an Electron app of its own; the root `package.json` doesn't depend on it, and `npm start` / `npm test` in the root work without it.

The server is the same `server/src/main.ts` as `npm start`, run as a child process on a Node 24 that comes inside the app (the build machine's own). The launcher passes it the data folder, the port and Test mode:

| | Mac | Windows |
| --- | --- | --- |
| Data folder (the show, backups, `launcher.json`) | `~/Library/Application Support/Light Runner` | `%APPDATA%\Light Runner` |
| Installer | `Light-Runner-<version>-<arch>.dmg` (the build machine's processor) | `Light-Runner-Setup-<version>.exe` (x64, for this user, no questions) |
| Installed in | Applications (dragged there) | `%LOCALAPPDATA%\Programs\light-runner-launcher` (electron-builder names a one-click per-user install after the package) |

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

electron-builder downloads its own tools the first time (Electron for the target, NSIS on Windows) into its cache. The built app has Electron's fuses set (`electronFuses`): it can't be run as plain Node, takes no `--inspect` or `NODE_OPTIONS`, and loads its code only from its checked asar. electron-builder never copies a `node_modules` at the top of an extra resource, so the server's packages are an entry of their own, and `dist.mjs` fails the build if any are missing from a built app (an unpacked app inside the repository would otherwise find the repository's own and hide it).

## Releases

GitHub builds every download (`.github/workflows/release.yml`): the Mac `.dmg` for Apple Silicon and for Intel, the Windows `Light-Runner-Setup-<version>.exe`, and the Raspberry Pi tarballs for arm64 and x64, each on a computer of its own kind. Nothing is signed (the owner's decision), so the Mac and Windows ask once, as above. To make a release:

1. Change `version` in the root `package.json`, and commit it.
2. Tag that commit `vX.Y.Z` (the same number) and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow stops if the tag and the version differ.
3. When the builds have finished, open the draft release under Releases on GitHub and check the files (three installers, two Pi tarballs, `install-pi.sh`, `SHA256SUMS.txt`).
4. Press **Publish**. The Raspberry Pi install command only finds the files once the release is published.

Before the first tag, run the workflow by hand (Actions › Release › Run workflow) to check the Mac builds; a dmg step that fails with "Resource busy" just needs Re-run. A run by hand builds everything, keeps the files for a few days as that run's downloads, and makes no release (also when run on a tag).

## Trying it while developing

```bash
cd launcher
npm start   # copies the design system files for the window, then opens it on the repository's own server
```

While developing (`electron .` from the repository) the launcher runs the repository's server on the `node` on the PATH (or `LIGHT_RUNNER_NODE`), and uses the repository's own `data/` folder, as `npm start` does, or `LIGHT_RUNNER_DATA` if it is set. It never uses the installed app's data folder then, so developing never touches the installed show, and it never adds itself to the login items; only the installed app does. To try a built app beside the one in use, start it with `--data-dir=<folder>`: it is then one per that folder, and it leaves the login items alone.

"One launcher per computer" is really one per data folder: Electron keys its single-instance lock by the data folder (checked on Windows with two copies on one folder and one on another). A run from the repository therefore doesn't share the lock with the installed app, and neither does a copy started with `--data-dir`. Two launchers on the same port would still collide, so give the second one a port of its own in Options.

## How it behaves

- The window, top to bottom (the owner's order: most people come to open the operator page or Settings): the name and a Test mode pill while it is on; one status line coloured by its state (green running, amber running with a problem, red stopped), with one plain sentence and one **Fix it** for a problem (Send DMX off: Settings at Send DMX; the port taken: the Options at the port; Windows on a Public network: the steps; stopped: **Start**); **Open the operator page**, **Open Settings**, **＋ Add an iPad or phone** (the code, the address and the network; open by itself only on the very first start); and quietly at the foot **Options ›** (port, Start when the computer starts, Test mode), **Stop** (asks first) and the version. The window takes the height of what it shows.
- Windows: the launcher reads (never changes) the network's profile (`Get-NetConnectionProfile`, every half minute). On a Public network Windows' firewall keeps the iPads out, so the window says so, with the steps to make the network Private and allow Node.js JavaScript Runtime (the name Windows gives Light Runner's server) on private networks.
- One per data folder (one per computer in normal use): a second launch shows the first one's window. A Light Runner already running on the same data folder (started by hand, or left by a launcher that crashed) is shown as running, with **Stop it**; one that doesn't answer has to be ended by hand, and the window says how. Another program on the port: the window says so and offers another port.
- Closing the window keeps it running in the tray / menu bar. **Quit** (in that menu, or Cmd+Q on the Mac) asks first, then saves the stage and stops the server.
- **Start when the computer starts** (on after the first start) puts it in the login items, checked again at every start; it then starts hidden, with the server running, and shows the window if the server can't start.
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
