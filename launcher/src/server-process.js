// Runs the Light Runner server as a child process on the bundled Node, and tells the window how it is doing.
//
// The child is the unchanged server (`server/src/main.ts`). Over its IPC channel it says `{ type: 'ready', port }`
// when it is listening, or `{ type: 'error', code: 'port-in-use' | 'already-running' | 'start-failed', message }`
// before exiting with 2; `{ type: 'shutdown' }` asks it to save the stage and stop (on Windows kill() is forceful,
// so this is the clean way). While it runs, it keeps `server.json` in the data folder (see marker.js).

import { spawn as childSpawn } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { processAlive, readMarker } from './marker.js';

/** @typedef {'starting' | 'running' | 'running-elsewhere' | 'stopped' | 'failed'} Status */
/** @typedef {'port-in-use' | 'not-answering' | 'start-failed' | 'crashed' | 'stop-failed'} FailCode */
/** @typedef {{ status: Status, code: FailCode | null, message: string | null, port: number | null }} Snapshot */
/** @typedef {'light-runner' | 'other' | 'busy' | 'none'} PortAnswer */

const KEEP_LINES = 30;
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Who answers on this port on this computer, asked with `GET /api/state`:
 * - 'light-runner': it says so in its `x-light-runner` header (an older one is known by the shape of its state);
 * - 'other': another program (it answers otherwise, or takes the connection and drops it);
 * - 'busy': something took the connection but didn't answer in time;
 * - 'none': nothing is listening.
 * With `pid`, only the Light Runner whose `x-light-runner-pid` header is that pid counts (the one in a marker; a
 * pid can be used again): another Light Runner is 'other'.
 * @param {number} port
 * @param {{ host?: string, timeoutMs?: number, pid?: number }} [options]
 * @returns {Promise<PortAnswer>}
 */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 1500, pid } = {}) {
  return new Promise((resolve) => {
    let connected = false;
    let done = false;
    /** @param {PortAnswer} answer */
    const finish = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };
    const req = request({ host, port, path: '/api/state', method: 'GET', headers: { accept: 'application/json' } }, (res) => {
      if (pid !== undefined) return finish(res.headers['x-light-runner'] && res.headers['x-light-runner-pid'] === String(pid) ? 'light-runner' : 'other');
      if (res.headers['x-light-runner']) return finish('light-runner');
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) finish('other');
      });
      res.on('end', () => finish(res.statusCode === 200 && looksLikeLightRunner(body) ? 'light-runner' : 'other'));
      res.on('error', () => finish('other'));
    });
    req.on('socket', (socket) => socket.once('connect', () => (connected = true)));
    req.on('error', () => finish(connected ? 'other' : 'none'));
    const timer = setTimeout(() => finish(connected ? 'busy' : 'none'), timeoutMs);
    req.end();
  });
}

/** @param {string} body */
function looksLikeLightRunner(body) {
  try {
    const state = JSON.parse(body);
    return !!state && typeof state === 'object' && 'look' in state && typeof state.master === 'number'
      && !!state.groups && typeof state.groups === 'object';
  } catch {
    return false;
  }
}

/**
 * Ask the Light Runner on this port to stop, with its marker's token (sent in a header, never shown or logged).
 * @param {number} port
 * @param {string} token
 * @returns {Promise<number>} the HTTP status
 */
function askToStop(port, token) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/launcher/stop', method: 'POST', headers: { authorization: `Bearer ${token}` }, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', reject);
    req.end();
  });
}

export class ServerProcess {
  /**
   * @param {{
   *   nodePath: string, appDir: string, dataDir: string,
   *   spawn?: typeof childSpawn,
   *   probe?: (port: number, options?: { pid?: number }) => Promise<PortAnswer>,
   *   env?: NodeJS.ProcessEnv,
   *   stopTimeoutMs?: number,
   *   killWaitMs?: number,
   *   restartDelayMs?: number,
   *   stableMs?: number,
   *   now?: () => number,
   * }} options
   *   `nodePath` is the bundled Node 24, `appDir` holds `server/`, `packages/`, `web/`; `dataDir` is the show's folder.
   *   `stopTimeoutMs`: how long a stop waits before it ends the server; `killWaitMs`: how long after that it gives up.
   *   `stableMs`: a server that ran this long before a crash gets its one restart back.
   */
  constructor({
    nodePath, appDir, dataDir, spawn = childSpawn, probe = probePort, env = process.env,
    stopTimeoutMs = 5000, killWaitMs = 2000, restartDelayMs = 1000, stableMs = 10 * 60_000, now = Date.now,
  }) {
    this.nodePath = nodePath;
    this.appDir = appDir;
    this.dataDir = dataDir;
    this.spawnChild = spawn;
    this.probe = probe;
    this.env = env;
    this.stopTimeoutMs = stopTimeoutMs;
    this.killWaitMs = killWaitMs;
    this.restartDelayMs = restartDelayMs;
    this.stableMs = stableMs;
    this.now = now;
    /** @type {Status} */
    this.status = 'stopped';
    /** Why it failed: `port-in-use`, `not-answering` (a Light Runner on this data folder that doesn't answer),
     * `start-failed`, `crashed` or `stop-failed`; null otherwise. @type {FailCode | null} */
    this.code = null;
    /** Plain words for a failure (the server's own, or the launcher's). @type {string | null} */
    this.message = null;
    /** The port it runs (or was asked to run) on. @type {number | null} */
    this.port = null;
    /** The last lines the server wrote (both outputs) and the launcher's notes about it. @type {string[]} */
    this.lastLines = [];
    /** @type {Set<(s: Snapshot) => void>} */
    this.listeners = new Set();
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** Resolves when the current child has ended. @type {(() => void) | null} */
    this.childEnded = null;
    /** @type {{ port: number, testMode: boolean } | null} */
    this.options = null;
    /** Restarts done by itself since the last start() (or since a crash after a long, good run). */
    this.restarts = 0;
    /** When the current child said it was ready. @type {number | null} */
    this.readyAt = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.restartTimer = null;
    /** Bumped by start() and stop(), so a port check that ends late doesn't act on an old request. */
    this.generation = 0;
    /** Keep what the current child wrote without a line end. @type {(() => void)[]} */
    this.flushers = [];
    /** stop() asked the running child to stop. */
    this.stopping = false;
    /** What the child said before it exited, when it couldn't start. @type {{ code: string, message: string, port?: number } | null} */
    this.failure = null;
  }

  /**
   * Hear about every change of status (or of its message). Returns a function that stops listening.
   * @param {(s: Snapshot) => void} cb
   */
  onChange(cb) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /**
   * Start the server, unless one is starting or running already, here or elsewhere. A Light Runner already
   * running on this data folder (its marker answers) or on the port (left by an earlier launcher, or started by
   * hand) is reported as `running-elsewhere` and left alone; another program on the port is `failed` with
   * `port-in-use`, and nothing is started.
   * @param {{ port: number, testMode: boolean }} options
   */
  async start({ port, testMode }) {
    if (this.child || this.status === 'starting' || this.status === 'running' || this.status === 'running-elsewhere') return;
    const generation = ++this.generation;
    this.options = { port, testMode };
    this.restarts = 0;
    this.set('starting', null, null, port);

    const marker = readMarker(this.dataDir);
    if (marker && processAlive(marker.pid)) {
      const answer = await this.probe(marker.port, { pid: marker.pid });
      if (generation !== this.generation) return;
      if (answer === 'light-runner') return this.elsewhere(marker.port);
      if (answer === 'busy') {
        return this.set('failed', 'not-answering', `Light Runner is already running on port ${marker.port} but is not answering`, marker.port);
      }
    }

    const answer = await this.probe(port);
    if (generation !== this.generation) return;
    if (answer === 'light-runner') this.elsewhere(port);
    else if (answer === 'other') this.set('failed', 'port-in-use', `Port ${port} is already in use by another program`, port);
    else if (answer === 'busy') this.set('failed', 'port-in-use', `Port ${port} is in use by a program that is not answering`, port);
    else this.run();
  }

  /**
   * While a Light Runner this launcher didn't start runs (or one on this data folder isn't answering), ask its port
   * again: when nothing answers there any more it has gone (`stopped`); one that answers again is `running-elsewhere`.
   * Call it every few seconds. Does nothing in any other status.
   */
  async recheck() {
    if (this.child || (this.status !== 'running-elsewhere' && this.code !== 'not-answering')) return;
    const generation = this.generation;
    const port = /** @type {number} */ (this.port);
    const answer = await this.probe(port);
    if (generation !== this.generation || this.child) return;
    if (this.status !== 'running-elsewhere' && this.code !== 'not-answering') return;
    if (answer === 'none') {
      this.note(`The Light Runner on port ${port} has stopped`);
      this.set('stopped', null, null, port);
    } else if (answer === 'light-runner' && this.status !== 'running-elsewhere') {
      this.elsewhere(port);
    }
  }

  /** @param {number} port */
  elsewhere(port) {
    this.note(`Light Runner is already running on this computer (port ${port})`);
    this.set('running-elsewhere', null, null, port);
  }

  /**
   * Ask the server to save the stage and stop; end it after `stopTimeoutMs` if it hasn't, and give up after
   * `killWaitMs` more (`failed`, `stop-failed`). Resolves when it has stopped or been given up on.
   * A server this launcher didn't start (`running-elsewhere`) is left running: see stopElsewhere().
   */
  async stop() {
    this.generation++;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) {
      if (this.status === 'starting') this.set('stopped', null, null, this.port);
      return;
    }
    this.stopping = true;
    const ended = new Promise((resolve) => {
      const previous = this.childEnded;
      this.childEnded = () => { previous?.(); resolve(undefined); };
    });
    const hasEnded = () => child.exitCode !== null || child.signalCode !== null;
    if (hasEnded()) {
      this.finish(child, child.exitCode, child.signalCode);
      return;
    }
    const kill = () => {
      try {
        child.kill();
      } catch (e) {
        this.note(`Light Runner could not be ended: ${/** @type {Error} */ (e).message}`);
      }
    };
    const killTimer = setTimeout(() => {
      if (this.child !== child) return;
      if (hasEnded()) return this.finish(child, child.exitCode, child.signalCode);
      this.note(`Light Runner did not stop within ${Math.round(this.stopTimeoutMs / 1000)} s; ending it`);
      kill();
    }, this.stopTimeoutMs);
    const giveUpTimer = setTimeout(() => {
      if (this.child !== child) return;
      if (hasEnded()) return this.finish(child, child.exitCode, child.signalCode);
      this.child = null;
      this.stopping = false;
      this.note('Light Runner could not be stopped');
      this.set('failed', 'stop-failed', `Light Runner could not be stopped (process ${child.pid})`, this.port);
      this.endChild();
    }, this.stopTimeoutMs + this.killWaitMs);
    if (child.connected) {
      try {
        child.send({ type: 'shutdown' }, () => {});
      } catch {
        kill();
      }
    } else {
      kill();
    }
    await ended;
    clearTimeout(killTimer);
    clearTimeout(giveUpTimer);
  }

  /**
   * Ask the server to save the stage and stop, without waiting: for when the computer is shutting down and there
   * is no time to wait. Returns whether the request could be sent.
   */
  requestStop() {
    const child = this.child;
    if (!child || !child.connected) return false;
    this.stopping = true;
    try {
      child.send({ type: 'shutdown' }, () => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop the Light Runner running on this data folder that this launcher didn't start: with the token from its
   * marker (server.json), and only after checking it answers as Light Runner; then wait until its port is quiet.
   * Returns whether it stopped; when it didn't, `message` says why and the status stays as it was.
   * @param {{ waitMs?: number }} [options]
   */
  async stopElsewhere({ waitMs = 10_000 } = {}) {
    /** @param {string} message */
    const refuse = (message) => {
      this.note(message);
      this.set(this.status, this.code, message, this.port);
      return false;
    };
    if (this.child) return refuse('This launcher is running Light Runner itself; use Stop');
    const marker = readMarker(this.dataDir);
    const another = `The Light Runner on port ${this.port} was started for another data folder, so it can't be stopped from here`;
    if (!marker) return refuse(another);
    const answer = await this.probe(marker.port, { pid: marker.pid });
    if (answer !== 'light-runner') {
      // The marker is left from an earlier server; the one running is another (or none answers at all).
      if (answer === 'other' && (await this.probe(this.port ?? marker.port)) === 'light-runner') return refuse(another);
      return refuse(`Light Runner on port ${marker.port} is not answering`);
    }
    let status;
    try {
      status = await askToStop(marker.port, marker.token);
    } catch {
      return refuse(`Light Runner on port ${marker.port} did not answer`);
    }
    if (status !== 202) return refuse(`Light Runner on port ${marker.port} refused to stop`);
    const deadline = Date.now() + waitMs;
    while ((await this.probe(marker.port)) !== 'none') {
      if (Date.now() >= deadline) return refuse(`Light Runner on port ${marker.port} did not stop within ${Math.round(waitMs / 1000)} s`);
      await sleep(200);
    }
    this.note(`Stopped the Light Runner that was running on port ${marker.port}`);
    this.set('stopped', null, null, marker.port);
    return true;
  }

  /** Spawn the server for the current options. */
  run() {
    const { port, testMode } = /** @type {{ port: number, testMode: boolean }} */ (this.options);
    const env = { ...this.env, PORT: String(port), LIGHT_RUNNER_DATA: this.dataDir };
    // The launcher's Test mode is the only switch: off means the server may send, as `npm start` does.
    delete env.LIGHT_RUNNER_OUTPUT;
    if (testMode) env.LIGHT_RUNNER_OUTPUT = 'none';
    this.stopping = false;
    this.failure = null;
    this.readyAt = null;
    this.set('starting', null, null, port);
    const child = this.spawnChild(this.nodePath, [join(this.appDir, 'server', 'src', 'main.ts')], {
      cwd: this.appDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      // Its own process (group), so it keeps the lights running if the launcher crashes; the next launcher finds it.
      detached: true,
    });
    this.child = child;
    this.childEnded = null;
    const flushers = [this.lines(child.stdout), this.lines(child.stderr)];
    this.flushers = flushers;
    child.on('message', (/** @type {any} */ m) => {
      if (this.child !== child || !m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        this.readyAt = this.now();
        this.set('running', null, null, typeof m.port === 'number' ? m.port : port);
      } else if (m.type === 'error') {
        const code = m.code === 'port-in-use' || m.code === 'already-running' ? m.code : 'start-failed';
        this.failure = { code, message: typeof m.message === 'string' ? m.message : code, port: typeof m.port === 'number' ? m.port : undefined };
      }
    });
    child.on('error', (err) => {
      if (this.child !== child) return;
      this.note(`Light Runner: ${err.message ?? err}`);
      // No pid: the bundled Node couldn't be run at all (a close may or may not follow). Otherwise a failed send
      // or kill, and the close says the rest.
      if (child.pid === undefined) {
        this.failure = { code: 'start-failed', message: String(err.message ?? err) };
        this.finish(child, null, null);
      }
    });
    child.once('close', (code, signal) => this.finish(child, code, signal));
  }

  /**
   * The child has ended (once per child; later news of it is ignored).
   * @param {import('node:child_process').ChildProcess} child
   * @param {number | null} code
   * @param {NodeJS.Signals | string | null} signal
   */
  finish(child, code, signal) {
    if (this.child !== child) return;
    for (const flush of this.flushers ?? []) flush();
    this.child = null;
    this.exited(code, signal);
    this.endChild();
  }

  endChild() {
    const ended = this.childEnded;
    this.childEnded = null;
    ended?.();
  }

  /**
   * @param {number | null} code
   * @param {NodeJS.Signals | string | null} signal
   */
  exited(code, signal) {
    const port = this.port;
    if (this.stopping) {
      this.stopping = false;
      this.set('stopped', null, null, port);
    } else if (this.failure?.code === 'already-running') {
      // Another server already runs on this data folder (it started between our check and this one).
      this.elsewhere(this.failure.port ?? port ?? 0);
    } else if (this.failure) {
      // The server said why it couldn't start: starting it again would only say the same.
      this.set('failed', /** @type {FailCode} */ (this.failure.code), this.failure.message, port);
    } else if (code === 0) {
      // Stopped cleanly by someone else (a signal, or the launcher stop of another launcher).
      this.note('Light Runner was stopped');
      this.set('stopped', null, null, port);
    } else {
      const how = signal ? `was ended (${signal})` : `stopped unexpectedly (exit code ${code})`;
      // A server that ran well for a while gets its restart back; one that keeps crashing gets one in all.
      if (this.readyAt !== null && this.now() - this.readyAt >= this.stableMs) this.restarts = 0;
      if (this.restarts < 1) {
        this.restarts++;
        this.note(`Light Runner ${how}; starting it again`);
        this.set('starting', null, null, port);
        const generation = this.generation;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (generation === this.generation) this.run();
        }, this.restartDelayMs);
      } else {
        this.note(`Light Runner ${how} again; not starting it by itself`);
        this.set('failed', 'crashed', `Light Runner ${how}`, port);
      }
    }
  }

  /**
   * Collect whole lines from one of the child's outputs; returns a function that keeps what is left without a line end.
   * @param {import('node:stream').Readable | null} stream
   */
  lines(stream) {
    let rest = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (/** @type {string} */ chunk) => {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const line of parts) this.note(line);
    });
    return () => {
      if (rest) this.note(rest);
      rest = '';
    };
  }

  /** @param {string} line */
  note(line) {
    this.lastLines.push(line);
    if (this.lastLines.length > KEEP_LINES) this.lastLines.splice(0, this.lastLines.length - KEEP_LINES);
  }

  /**
   * @param {Status} status
   * @param {FailCode | null} code
   * @param {string | null} message
   * @param {number | null} port
   */
  set(status, code, message, port) {
    const changed = status !== this.status || code !== this.code || message !== this.message || port !== this.port;
    this.status = status;
    this.code = code;
    this.message = message;
    this.port = port;
    if (!changed) return;
    const snapshot = { status, code, message, port };
    for (const cb of [...this.listeners]) {
      try {
        cb(snapshot);
      } catch (e) {
        console.error('Light Runner launcher: a status listener failed', e);
      }
    }
  }
}
