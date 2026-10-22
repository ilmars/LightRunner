// The Light Runner launcher (Electron main process): one window with the address for the iPads, a tray icon
// (Windows) or menu bar icon (Mac), and the server running as a child process on the bundled Node 24.
//
// `Light Runner --hidden` starts in the tray (the login item does this); `Light Runner --quit` stops a running
// Light Runner on this computer (the launcher and its server, saving the stage) and exits: the Windows installer
// runs it before it replaces the files.

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, powerMonitor, shell } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { loadConfig, saveConfig } from './src/config.js';
import { processAlive, readMarker } from './src/marker.js';
import { lanAddresses, pickAddress } from './src/net.js';
import { ServerProcess } from './src/server-process.js';
import { fetchLatestTag, latestTag, newerVersion } from './src/version.js';
import { checkPort, describe } from './src/view.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The window's page. */
const pageUrl = pathToFileURL(join(here, 'ui', 'index.html')).href;
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const RELEASES_PAGE = 'https://github.com/ilmars/LightRunner/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/ilmars/LightRunner/releases/latest';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// The server's files and the Node that runs it: inside the app when installed (resources/lightrunner, outside the
// asar so that Node can read them), the repository and the Node on the PATH while developing.
const appDir = app.isPackaged ? join(process.resourcesPath, 'lightrunner') : resolve(here, '..');
const nodePath = app.isPackaged ? join(appDir, isWindows ? 'node.exe' : 'node') : (process.env.LIGHT_RUNNER_NODE || 'node');

// The show, its backups and the launcher's settings (Mac ~/Library/Application Support/Light Runner, Windows
// %APPDATA%\Light Runner). The window's own browser data goes in a folder of its own inside it. While developing,
// LIGHT_RUNNER_DATA can point it at another folder, as it does for `npm start`.
if (!app.isPackaged && process.env.LIGHT_RUNNER_DATA) app.setPath('userData', resolve(process.env.LIGHT_RUNNER_DATA));
const dataDir = app.getPath('userData');
app.setPath('sessionData', join(dataDir, 'Launcher window'));
const configFile = join(dataDir, 'launcher.json');
const pidFile = join(dataDir, 'launcher.pid');
const updateFile = join(dataDir, 'Launcher window', 'update-check.json');

function readVersion() {
  try {
    const v = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v ? v : 'dev';
  } catch {
    return 'dev';
  }
}
const version = readVersion();

const server = new ServerProcess({ nodePath, appDir, dataDir, stopTimeoutMs: 4500, killWaitMs: 1500 });

// ---- Stopping it all: `--quit` ----

/**
 * Wait (at most `ms`) until this process has gone.
 * @param {number} pid
 * @param {number} ms
 */
async function waitForExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (pid > 0 && processAlive(pid) && Date.now() < deadline) await sleep(200);
}

/**
 * For --quit while another launcher runs: it has been asked to quit, and stops the server it started. Wait for it,
 * then stop a server it was only showing (one running elsewhere on this data folder), so nothing of Light Runner is
 * left running for the installer.
 */
async function quitOtherLauncher() {
  let launcherPid = 0;
  try {
    launcherPid = Number(readFileSync(pidFile, 'utf8').trim()) || 0;
  } catch {}
  // Taken now: the file goes when its server stops, the process may take a moment longer.
  const serverPid = readMarker(dataDir)?.pid ?? 0;
  await waitForExit(launcherPid, 12_000);
  await stopLeftServer();
  await waitForExit(serverPid, 3_000);
}

/** For --quit: stop a server still running on this data folder without its launcher (with its marker's token). */
async function stopLeftServer() {
  const marker = readMarker(dataDir);
  if (!marker || !processAlive(marker.pid)) return;
  server.port = marker.port;
  await server.stopElsewhere();
  await waitForExit(marker.pid, 5_000);
}

// ---- The launcher ----

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let stoppingForQuit = false;
let serverDone = false;
let config = loadConfig(configFile);
/** The last save that failed, in plain words; null after one that worked. @type {string | null} */
let saveError = null;
/** What the running server last said: its output's state, and whether it answers. */
let live = { answering: true, /** @type {any} */ state: null };
/** The words of the operator page's problem pill (web/shared/appbar.js), loaded from the server's own files. */
let problemWords = (/** @type {any} */ _state) => /** @type {{ long: string, title: string } | null} */ (null);
/** @type {{ version: string } | null} */
let newer = null;
/** @type {{ url: string, svg: string } | null} */
let qr = null;
/** One change at a time (Start, Stop, a new port …). */
let queue = Promise.resolve();

/** @param {() => Promise<unknown> | unknown} job */
function serial(job) {
  const next = queue.then(job, job);
  queue = next.then(() => {}, () => {});
  return next;
}

/** @param {Partial<import('./src/config.js').LauncherConfig>} change */
function save(change) {
  const next = { ...config, ...change };
  try {
    saveConfig(configFile, next);
    config = next;
    saveError = null;
    return true;
  } catch (e) {
    saveError = /** @type {Error} */ (e).message;
    return false;
  }
}

async function main() {
  const firstStart = !existsQuietly(configFile);
  app.on('second-instance', (_event, argv, data) => {
    if ((data && /** @type {any} */ (data).quit) || argv.includes('--quit')) {
      quitting = true;
      app.quit();
    } else {
      showWindow();
    }
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (serverDone) return;
    event.preventDefault();
    if (stoppingForQuit) return;
    stoppingForQuit = true;
    // Save the stage and stop the server (it is ended after a few seconds if it doesn't), then quit. After a change
    // under way (a new port restarts the server), so that no server is started after this stop.
    void Promise.race([serial(() => server.stop()), sleep(6500)]).finally(() => {
      serverDone = true;
      try {
        rmSync(pidFile, { force: true });
      } catch {}
      app.quit();
    });
  });
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(signal, () => app.quit());
  // Mac and Linux: the computer is shutting down or logging out. Ask the server to save and stop now, then quit.
  powerMonitor.on('shutdown', (/** @type {Electron.Event} */ e) => {
    e.preventDefault();
    server.requestStop();
    quitting = true;
    app.quit();
  });
  if (isMac) app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {});

  await app.whenReady();
  if (isWindows) app.setAppUserModelId('com.github.ilmars.lightrunner');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(pidFile, String(process.pid));
  } catch {}
  try {
    const appbar = await import(pathToFileURL(join(appDir, 'web', 'shared', 'appbar.js')).href);
    problemWords = appbar.problemWords;
  } catch {}

  // The first start writes the settings. Every start puts Light Runner in the login items, or takes it out, as the
  // setting says: after a reinstall, or a change in Task Manager or System Settings, the box still tells the truth.
  if (firstStart) save({});
  setLoginItem(config.startAtLogin);
  const startHidden = startedAtLogin();

  // Only the window's own page may ask: not another frame, not a page it was somehow sent to.
  const fromWindow = (/** @type {Electron.IpcMainInvokeEvent} */ event) => {
    const frame = event.senderFrame;
    if (!win || !frame || frame !== win.webContents.mainFrame) return false;
    try {
      const url = new URL(frame.url);
      url.hash = '';
      url.search = '';
      return url.href === pageUrl;
    } catch {
      return false;
    }
  };
  ipcMain.handle('launcher:view', (event) => {
    if (!fromWindow(event)) throw new Error('not the launcher window');
    return view();
  });
  ipcMain.handle('launcher:act', (event, action, value) => {
    if (!fromWindow(event)) throw new Error('not the launcher window');
    return act(String(action), value);
  });
  server.onChange(() => push());

  setMenus();
  createTray();
  createWindow(!startHidden);
  if (startHidden && isMac) app.dock?.hide();
  // Started at login and it can't run (the port is taken, another one isn't answering ...): show why, so it is seen
  // before the service rather than during it.
  if (startHidden) {
    const off = server.onChange((s) => {
      if (s.status === 'running' || s.status === 'running-elsewhere') off();
      else if (s.status === 'failed') {
        off();
        showWindow();
      }
    });
  }

  await server.start({ port: config.port, testMode: config.testMode });
  setInterval(readLive, 2000);
  // A Light Runner this launcher didn't start: notice when it goes (or one that wasn't answering comes back).
  setInterval(() => void server.recheck().catch(() => {}), 5000);
  // Networks come and go (Wi-Fi, a cable, a VPN).
  setInterval(() => push(), 10_000);
  setTimeout(checkForUpdate, 10_000);
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
}

/** @param {string} file */
function existsQuietly(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

// ---- Login item ----

/** @param {boolean} on */
function setLoginItem(on) {
  // Only the installed app goes in the login items, never Electron itself while developing.
  if (!app.isPackaged) return;
  if (isWindows) app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: ['--hidden'], name: 'Light Runner' });
  // The Mac's login items take no arguments; openAsHidden still works before macOS 13.
  else app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
}

/**
 * Was this start the login item's (so the window stays hidden)? Windows passes --hidden. The Mac says so with
 * wasOpenedAtLogin, which macOS 13 and later may not set for a login item; then, with the login item on, a start in
 * the first three minutes after the computer started is taken as the login one. A wrong guess only hides the
 * window: opening Light Runner again (Finder, the Dock, the menu bar icon) shows it.
 */
function startedAtLogin() {
  if (process.argv.includes('--hidden')) return true;
  if (!isMac || !app.isPackaged) return false;
  const login = app.getLoginItemSettings();
  if (login.wasOpenedAtLogin || login.wasOpenedAsHidden) return true;
  return config.startAtLogin && uptime() < 180;
}

// ---- Window, tray, menus ----

/** @param {boolean} show */
function createWindow(show) {
  win = new BrowserWindow({
    width: 600,
    height: 760,
    minWidth: 480,
    minHeight: 560,
    show: false,
    title: 'Light Runner',
    backgroundColor: '#090F1C',
    autoHideMenuBar: true,
    icon: isMac ? undefined : join(here, 'assets', 'icon.png'),
    webPreferences: { preload: join(here, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (!isMac) win.removeMenu();
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    if (quitting) return;
    // Closing the window keeps Light Runner running in the tray / menu bar.
    e.preventDefault();
    win?.hide();
    if (isMac) app.dock?.hide();
  });
  // Windows is logging off or shutting down: there is no time to wait, so ask the server to save and stop now.
  win.on('session-end', () => {
    quitting = true;
    server.requestStop();
  });
  win.on('show', () => push());
  if (show) win.once('ready-to-show', () => win?.show());
  void win.loadURL(pageUrl);
}

function showWindow() {
  if (!win) return;
  if (isMac) void app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function confirmQuit() {
  if (server.status === 'running' || server.status === 'starting') {
    const options = {
      type: /** @type {const} */ ('question'),
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Light Runner',
      message: 'The lights stop following the iPads. Quit Light Runner?',
      detail: 'The stage is saved first. Open Light Runner again to bring them back.',
    };
    const { response } = win && win.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response !== 0) return;
  }
  quitting = true;
  app.quit();
}

function trayImage() {
  const image = nativeImage.createFromPath(join(here, 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) image.setTemplateImage(true);
  return image;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Light Runner');
  // Windows: a click opens the window; the menu is on the right button. Mac: a click opens the menu.
  if (!isMac) tray.on('click', () => showWindow());
  updateTray();
}

function trayStatus() {
  const port = shownPort();
  switch (server.status) {
    case 'running': return `Running on port ${port}`;
    case 'starting': return 'Starting…';
    case 'running-elsewhere': return `Already running on port ${port}`;
    case 'stopped': return 'Stopped';
    default: return 'Not running';
  }
}

let trayShows = '';
function updateTray() {
  if (!tray) return;
  // Built again only when it changes, so an open menu isn't pulled away.
  const shows = `${trayStatus()}|${server.status}`;
  if (shows === trayShows) return;
  trayShows = shows;
  tray.setToolTip(`Light Runner: ${trayStatus()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayStatus(), enabled: false },
    { type: 'separator' },
    { label: 'Open window', click: () => showWindow() },
    { label: 'Open operator page', click: () => void open('operator'), enabled: server.status === 'running' || server.status === 'running-elsewhere' },
    { type: 'separator' },
    { label: 'Quit Light Runner', click: () => void confirmQuit() },
  ]));
}

function setMenus() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Light Runner',
      submenu: [
        { role: 'about', label: 'About Light Runner' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Light Runner' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Light Runner', accelerator: 'Cmd+Q', click: () => void confirmQuit() },
      ],
    },
    { role: 'editMenu' },
    { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Close', accelerator: 'Cmd+W', click: () => win?.close() }] },
  ]));
}

// ---- What the window shows ----

/** The port the server runs on, or (stopped) the one it will start on. */
function shownPort() {
  const on = server.status === 'running' || server.status === 'starting' || server.status === 'running-elsewhere' || server.code === 'not-answering';
  return (on ? server.port : null) ?? config.port;
}

function address() {
  const list = lanAddresses();
  const chosen = pickAddress(list, config.address);
  const port = shownPort();
  const host = chosen?.address ?? 'localhost';
  return { list, chosen: chosen?.address ?? null, url: `http://${host}:${port}`, port };
}

async function qrFor(/** @type {string} */ url) {
  if (qr?.url === url) return qr.svg;
  // Dark squares on a dimmed light ground: phones read it at once, and it doesn't light up the room.
  const svg = await QRCode.toString(`${url}/`, { type: 'svg', margin: 4, errorCorrectionLevel: 'M', color: { dark: '#0B1220', light: '#9DA9BC' } });
  qr = { url, svg };
  return svg;
}

async function view() {
  const a = address();
  const snapshot = { status: server.status, code: server.code, message: server.message, port: server.code === 'port-in-use' ? server.port : shownPort() };
  // The process to end by hand, for a Light Runner on this data folder that isn't answering.
  const stuck = server.code === 'not-answering' ? readMarker(dataDir)?.pid ?? null : null;
  const words = describe(snapshot, { platform: process.platform, answering: live.answering, pid: stuck });
  const running = server.status === 'running' || server.status === 'running-elsewhere';
  const problem = running && live.state ? problemWords(live.state) : null;
  // Test mode is this launcher's: a Light Runner running elsewhere sends (or doesn't) as it was started.
  const ownTest = config.testMode && (server.status === 'running' || server.status === 'starting');
  return {
    ...words,
    status: server.status,
    code: server.code,
    port: snapshot.port,
    configPort: config.port,
    lines: words.showLines ? server.lastLines.slice(-12) : [],
    // A problem with the lights in the operator page's words; Test mode's "not sending" is what was asked for.
    problem: problem && !(ownTest && live.state?.output === 'off') ? { text: problem.long, title: problem.title } : null,
    testMode: config.testMode,
    testPill: ownTest,
    startAtLogin: config.startAtLogin,
    canSetLogin: app.isPackaged,
    addresses: a.list,
    address: a.chosen,
    url: a.url,
    qr: await qrFor(a.url).catch(() => null),
    firewallNote: isWindows && !config.ipadSeen,
    saveError,
    version,
    newer: newer?.version ?? null,
    platform: process.platform,
  };
}

let pushing = false;
let pushAgain = false;
async function push() {
  updateTray();
  if (!win || win.isDestroyed()) return;
  if (pushing) {
    pushAgain = true;
    return;
  }
  pushing = true;
  try {
    do {
      pushAgain = false;
      const v = await view();
      if (win && !win.isDestroyed()) win.webContents.send('launcher:changed', v);
    } while (pushAgain);
  } finally {
    pushing = false;
  }
}

/** Read the running server's live state: its output (for the problem words) and whether an iPad has reached it. */
async function readLive() {
  const running = server.status === 'running' || server.status === 'running-elsewhere';
  if (!running || !server.port) {
    if (live.state || !live.answering) {
      live = { answering: true, state: null };
      void push();
    }
    return;
  }
  let next;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`, { signal: AbortSignal.timeout(3000) });
    const state = await res.json();
    next = { answering: true, state: state && typeof state === 'object' ? { output: state.output, outputProblem: state.outputProblem, outputProblemKind: state.outputProblemKind } : null };
    // The first iPad has reached it: the note about the firewall can go.
    if (!config.ipadSeen && Number(res.headers.get('x-light-runner-remote-pages')) > 0 && save({ ipadSeen: true })) void push();
  } catch {
    next = { answering: false, state: null };
  }
  if (JSON.stringify(next) !== JSON.stringify(live)) {
    live = next;
    void push();
  }
}

// ---- What the window can do ----

/** @param {'operator' | 'settings'} page */
async function open(page) {
  const port = shownPort();
  await shell.openExternal(`http://localhost:${port}/${page}/`);
}

/** Stop the server this launcher runs, and start it again with the settings as they are now. */
async function restart() {
  if (server.status === 'running' || server.status === 'starting') await server.stop();
  await server.start({ port: config.port, testMode: config.testMode });
}

const changeable = () => server.status !== 'running-elsewhere' && server.code !== 'not-answering';

/**
 * @param {string} action
 * @param {unknown} value
 * @returns {Promise<{ error?: string }>}
 */
function act(action, value) {
  return /** @type {Promise<{ error?: string }>} */ (serial(async () => {
    if (quitting) return {};
    switch (action) {
      case 'start':
        if (server.status === 'stopped' || server.status === 'failed') await server.start({ port: config.port, testMode: config.testMode });
        break;
      case 'stop':
        await server.stop();
        break;
      case 'stop-elsewhere':
        if (server.status === 'running-elsewhere') await server.stopElsewhere();
        break;
      case 'port': {
        if (!changeable()) return { error: 'Stop the Light Runner that is running first' };
        const checked = checkPort(value);
        if (checked.error !== undefined) return { error: checked.error };
        if (checked.port === config.port && server.status !== 'failed') break;
        if (!save({ port: checked.port })) break;
        if (server.status !== 'stopped') await restart();
        break;
      }
      case 'test-mode':
        if (!changeable()) return { error: 'Stop the Light Runner that is running first' };
        if (!save({ testMode: value === true })) break;
        if (server.status === 'running' || server.status === 'starting') await restart();
        break;
      case 'start-at-login':
        if (save({ startAtLogin: value === true })) setLoginItem(value === true);
        break;
      case 'address':
        if (typeof value === 'string') save({ address: value });
        break;
      case 'open-operator':
        await open('operator');
        break;
      case 'open-settings':
        await open('settings');
        break;
      case 'open-release':
        await shell.openExternal(RELEASES_PAGE);
        break;
      default:
        return { error: `Unknown action ${action}` };
    }
    void push();
    return {};
  }));
}

// ---- A newer version ----

/** Ask GitHub for the latest release at most once a day (src/version.js); say nothing when offline or when there is none. */
async function checkForUpdate() {
  if (!app.isPackaged) return;
  const latest = await latestTag({ cacheFile: updateFile, fetchLatest: () => fetchLatestTag(fetch, RELEASES_API, `Light Runner launcher ${version}`) });
  const found = latest ? newerVersion(version, latest) : null;
  if (found !== (newer?.version ?? null)) {
    newer = found ? { version: found } : null;
    void push();
  }
}

// ---- One launcher per computer ----

const quitRequest = process.argv.includes('--quit');
// `--quit` shows nothing: no graphics process needed.
if (quitRequest) app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock({ quit: quitRequest })) {
  // Another launcher runs: it has been told (it shows its window, or quits for --quit).
  if (quitRequest) {
    setTimeout(() => app.exit(0), 25_000).unref();
    void quitOtherLauncher().finally(() => app.exit(0));
  } else {
    app.exit(0);
  }
} else if (quitRequest) {
  // No launcher runs, but a server left by one may: stop it with its marker's token.
  setTimeout(() => app.exit(0), 25_000).unref();
  void stopLeftServer().finally(() => app.exit(0));
} else {
  void main();
}
