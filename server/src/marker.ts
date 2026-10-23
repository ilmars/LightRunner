// One server per data folder. A running server keeps `server.json` in its data folder: its pid, its port, a secret
// token (the launcher's key to stop it) and when it started. A second server on the same folder finds the first
// answering there and refuses, before it starts an engine that would also send to the lights.

import { readFileSync, renameSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { writeAtomic } from './store.ts';

export interface Marker {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export const MARKER_FILE = 'server.json';

/** Who answers on a port on this computer. */
export type PortAnswer = 'light-runner' | 'other' | 'busy' | 'none';

export function markerPath(dataDir: string): string {
  return join(dataDir, MARKER_FILE);
}

/** The marker in this data folder, or null when there is none or it can't be read. */
export function readMarker(dataDir: string): Marker | null {
  try {
    const m = JSON.parse(readFileSync(markerPath(dataDir), 'utf8').replace(/^\uFEFF/, '')) as Partial<Marker> | null;
    if (!m || typeof m !== 'object') return null;
    if (!Number.isInteger(m.pid) || !Number.isInteger(m.port) || typeof m.token !== 'string' || typeof m.startedAt !== 'string') return null;
    return { pid: m.pid!, port: m.port!, token: m.token, startedAt: m.startedAt };
  } catch {
    return null;
  }
}

/**
 * Write the marker atomically, readable only by this user where the system allows it (the token is a key).
 * `rename` is for tests.
 */
export function writeMarker(dataDir: string, marker: Marker, rename: (from: string, to: string) => void = renameSync): void {
  writeAtomic(markerPath(dataDir), JSON.stringify(marker), { mode: 0o600, rename });
}

/** Remove the marker, if it is still this server's. */
export function removeMarker(dataDir: string, token: string): void {
  if (readMarker(dataDir)?.token === token) rmSync(markerPath(dataDir), { force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it is there, but another user's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ask `GET /api/state` on this computer's port. Light Runner says so in its `x-light-runner` header (an older one
 * is known by the shape of its state). Nothing listening is 'none'; a connection that doesn't answer in time 'busy'.
 * With `pid`, only the Light Runner whose `x-light-runner-pid` header is that pid counts: another one is 'other'.
 */
export function probePort(port: number, { timeoutMs = 1500, pid }: { timeoutMs?: number; pid?: number } = {}): Promise<PortAnswer> {
  return new Promise((resolve) => {
    let connected = false;
    let done = false;
    const finish = (answer: PortAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };
    const req = request({ host: '127.0.0.1', port, path: '/api/state', method: 'GET' }, (res) => {
      if (pid !== undefined) return finish(res.headers['x-light-runner'] && res.headers['x-light-runner-pid'] === String(pid) ? 'light-runner' : 'other');
      if (res.headers['x-light-runner']) return finish('light-runner');
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; if (body.length > 1_000_000) finish('other'); });
      res.on('end', () => finish(res.statusCode === 200 && looksLikeState(body) ? 'light-runner' : 'other'));
      res.on('error', () => finish('other'));
    });
    req.on('socket', (s) => s.once('connect', () => (connected = true)));
    req.on('error', () => finish(connected ? 'other' : 'none'));
    const timer = setTimeout(() => finish(connected ? 'busy' : 'none'), timeoutMs);
    req.end();
  });
}

function looksLikeState(body: string): boolean {
  try {
    const s = JSON.parse(body);
    return !!s && typeof s === 'object' && 'look' in s && typeof s.master === 'number' && !!s.groups && typeof s.groups === 'object';
  } catch {
    return false;
  }
}

/**
 * The marker of a server still running on this data folder, or null when there is none or it was left behind
 * (its process is gone, or its port has nothing, another program or another Light Runner on it: the pid it gives
 * must be the marker's, as a pid can be used again). A server that is there but doesn't answer in time counts as
 * running: two engines on one show must never happen.
 */
export async function liveMarker(
  dataDir: string,
  probe: (port: number, options: { pid: number }) => Promise<PortAnswer> = (port, options) => probePort(port, options),
): Promise<Marker | null> {
  const marker = readMarker(dataDir);
  if (!marker || marker.pid <= 0 || !processAlive(marker.pid)) return null;
  const answer = await probe(marker.port, { pid: marker.pid });
  return answer === 'light-runner' || answer === 'busy' ? marker : null;
}

/** Thrown by App.start() when another server already runs on its data folder. */
export class AlreadyRunning extends Error {
  readonly code = 'ALREADY_RUNNING';
  readonly port: number;
  constructor(port: number) {
    super(`Light Runner is already running on this computer (port ${port}), with the same data folder`);
    this.port = port;
  }
}
