// The launcher's own settings (launcher.json in the data folder): the port, Start when the computer starts,
// Test mode, the address chosen for the iPads and whether an iPad has reached it yet. The show and its settings
// stay the server's.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @typedef {{ port: number, startAtLogin: boolean, testMode: boolean, address: string | null, ipadSeen: boolean }} LauncherConfig
 */

/** The ports Light Runner can be given (lower ones need an administrator on some systems and belong to other services). */
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

/** @type {Readonly<LauncherConfig>} */
export const DEFAULT_CONFIG = Object.freeze({ port: 8080, startAtLogin: true, testMode: false, address: null, ipadSeen: false });

/**
 * Keep the settings that make sense; anything else gets its default.
 * @param {unknown} value
 * @returns {LauncherConfig}
 */
function normalise(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
  const port = v.port;
  return {
    port: typeof port === 'number' && Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX ? port : DEFAULT_CONFIG.port,
    startAtLogin: typeof v.startAtLogin === 'boolean' ? v.startAtLogin : DEFAULT_CONFIG.startAtLogin,
    testMode: typeof v.testMode === 'boolean' ? v.testMode : DEFAULT_CONFIG.testMode,
    address: typeof v.address === 'string' && v.address ? v.address : DEFAULT_CONFIG.address,
    ipadSeen: typeof v.ipadSeen === 'boolean' ? v.ipadSeen : DEFAULT_CONFIG.ipadSeen,
  };
}

/**
 * Read the settings; a missing or broken file gives the defaults. A damaged file (not a JSON object) is kept as
 * `<file>.bad`, so the defaults saved later don't destroy what was in it.
 * @param {string} file
 * @returns {LauncherConfig}
 */
export function loadConfig(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return normalise(null);
  }
  let parsed = null;
  try {
    // Notepad saves with a byte order mark.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    try {
      renameSync(file, `${file}.bad`);
    } catch {}
    return normalise(null);
  }
  return normalise(parsed);
}

/** @param {number} ms */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Save the whole settings (one that doesn't make sense is saved as its default): written next to the old file and
 * renamed over it, so a crash never leaves half a file. Throws an error in plain words when it can't.
 * @param {string} file
 * @param {LauncherConfig} config
 */
export function saveConfig(file, config) {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(normalise(config), null, 2)}\n`);
    // 'r+', not 'r': Windows refuses to flush a file opened read-only (EPERM).
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Windows can refuse a rename for a moment while something (a virus scanner, a backup) has the file open.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file);
        break;
      } catch (e) {
        const code = /** @type {NodeJS.ErrnoException} */ (e).code;
        if (attempt >= 2 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
        pause(100);
      }
    }
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {}
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    throw new Error(`Couldn't save the Light Runner settings in ${dirname(file)} (${err.code ?? err.message})`, { cause: e });
  }
}
