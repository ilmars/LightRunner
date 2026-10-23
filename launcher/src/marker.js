// The server's marker in its data folder (server.json, written by server/src/marker.ts while it runs): its pid,
// its port and the token that lets this computer's launcher stop it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {{ pid: number, port: number, token: string, startedAt: string }} Marker */

export const MARKER_FILE = 'server.json';

/**
 * The marker in this data folder, or null when there is none or it can't be read.
 * @param {string} dataDir
 * @returns {Marker | null}
 */
export function readMarker(dataDir) {
  try {
    const m = JSON.parse(readFileSync(join(dataDir, MARKER_FILE), 'utf8').replace(/^\uFEFF/, ''));
    if (!m || typeof m !== 'object') return null;
    if (!Number.isInteger(m.pid) || !Number.isInteger(m.port) || typeof m.token !== 'string' || typeof m.startedAt !== 'string') return null;
    return { pid: m.pid, port: m.port, token: m.token, startedAt: m.startedAt };
  } catch {
    return null;
  }
}

/**
 * Is this process still there? (EPERM: it is, but another user's.)
 * @param {number} pid
 */
export function processAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}
