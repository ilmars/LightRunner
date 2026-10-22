// One server per data folder. A running server keeps `server.json` in its data folder: its pid, its port, a secret
// token (the launcher's key to stop it) and when it started. A second server on the same folder finds the first
// answering there and refuses, before it starts an engine that would also send to the lights.

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

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
    const m = JSON.parse(readFileSync(markerPath(dataDir), 'utf8').replace(/^﻿/, '')) as Partial<Marker> | null;
    if (!m || typeof m !== 'object') return null;
    if (!Number.isInteger(m.pid) || !Number.isInteger(m.port) || typeof m.token !== 'string' || typeof m.startedAt !== 'string') return null;
    return { pid: m.pid!, port: m.port!, token: m.token, startedAt: m.startedAt };
  } catch {
    return null;
  }
}

/** Write the marker atomically, readable only by this user where the system allows it (the token is a key). */
export function writeMarker(dataDir: string, marker: Marker): void {
  const path = markerPath(dataDir);
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600 });
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
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
 */
export function probePort(port: number, timeoutMs = 1500): Promise<PortAnswer> {
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
 * (its process is gone, or its port has nothing or another program on it). A server that is there but doesn't
 * answer in time counts as running: two engines on one show must never happen.
 */
export async function liveMarker(dataDir: string, probe: (port: number) => Promise<PortAnswer> = probePort): Promise<Marker | null> {
  const marker = readMarker(dataDir);
  if (!marker || marker.pid <= 0 || !processAlive(marker.pid)) return null;
  const answer = await probe(marker.port);
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
