// The launcher's own settings (launcher.json in the data folder): the port, Start when the computer starts,
// Test mode and the address chosen for the iPads. The show and its settings stay the server's.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @typedef {{ port: number, startAtLogin: boolean, testMode: boolean, address: string | null }} LauncherConfig
 */

/** @type {Readonly<LauncherConfig>} */
export const DEFAULT_CONFIG = Object.freeze({ port: 8080, startAtLogin: true, testMode: false, address: null });

/**
 * Keep the settings that make sense; anything else gets its default.
 * @param {unknown} value
 * @returns {LauncherConfig}
 */
function normalise(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
  const port = v.port;
  return {
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    startAtLogin: typeof v.startAtLogin === 'boolean' ? v.startAtLogin : DEFAULT_CONFIG.startAtLogin,
    testMode: typeof v.testMode === 'boolean' ? v.testMode : DEFAULT_CONFIG.testMode,
    address: typeof v.address === 'string' && v.address ? v.address : DEFAULT_CONFIG.address,
  };
}

/**
 * Read the settings; a missing or broken file gives the defaults.
 * @param {string} file
 * @returns {LauncherConfig}
 */
export function loadConfig(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  return normalise(parsed);
}

/**
 * Save the settings: written next to the old file and renamed over it, so a crash never leaves half a file.
 * @param {string} file
 * @param {Partial<LauncherConfig>} config
 */
export function saveConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalise(config), null, 2)}\n`);
  // 'r+', not 'r': Windows refuses to flush a file opened read-only (EPERM).
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
