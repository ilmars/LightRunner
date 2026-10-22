// Runs the Light Runner server as a child process on the bundled Node, and tells the window how it is doing.
//
// The child is the unchanged server (`server/src/main.ts`). Over its IPC channel it says `{ type: 'ready', port }`
// when it is listening, or `{ type: 'error', code: 'port-in-use' | 'start-failed', message }` before exiting with 2;
// `{ type: 'shutdown' }` asks it to save the stage and stop (on Windows kill() is forceful, so this is the clean way).

import { spawn as childSpawn } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';

/** @typedef {'starting' | 'running' | 'running-elsewhere' | 'stopped' | 'failed'} Status */
/** @typedef {'port-in-use' | 'start-failed' | 'crashed'} FailCode */
/** @typedef {{ status: Status, code: FailCode | null, message: string | null, port: number | null }} Snapshot */
/** @typedef {'light-runner' | 'other' | 'none'} PortAnswer */

const KEEP_LINES = 30;

/**
 * Who answers on this port on this computer: a Light Runner (its `GET /api/state` looks like ours), another program
 * speaking HTTP, or nothing that answers (free, or a program that isn't a web server: the server finds that out itself).
 * @param {number} port
 * @param {{ host?: string, timeoutMs?: number }} [options]
 * @returns {Promise<PortAnswer>}
 */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
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
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) finish('other');
      });
      res.on('end', () => finish(res.statusCode === 200 && looksLikeLightRunner(body) ? 'light-runner' : 'other'));
      res.on('error', () => finish('other'));
    });
    // Not answering in time, refused, or not speaking HTTP: nothing here we can recognise.
    const timer = setTimeout(() => finish('none'), timeoutMs);
    req.on('error', () => finish('none'));
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

export class ServerProcess {
  /**
   * @param {{
   *   nodePath: string, appDir: string, dataDir: string,
   *   spawn?: typeof childSpawn,
   *   probe?: (port: number) => Promise<PortAnswer>,
   *   env?: NodeJS.ProcessEnv,
   *   stopTimeoutMs?: number,
   *   restartDelayMs?: number,
   * }} options
   *   `nodePath` is the bundled Node 24, `appDir` holds `server/`, `packages/`, `web/`; `dataDir` is the show's folder.
   */
  constructor({ nodePath, appDir, dataDir, spawn = childSpawn, probe = probePort, env = process.env, stopTimeoutMs = 5000, restartDelayMs = 1000 }) {
    this.nodePath = nodePath;
    this.appDir = appDir;
    this.dataDir = dataDir;
    this.spawnChild = spawn;
    this.probe = probe;
    this.env = env;
    this.stopTimeoutMs = stopTimeoutMs;
    this.restartDelayMs = restartDelayMs;
    /** @type {Status} */
    this.status = 'stopped';
    /** Why it failed: `port-in-use`, `start-failed` or `crashed`; null otherwise. @type {FailCode | null} */
    this.code = null;
    /** The server's own words for a failure, or the launcher's. @type {string | null} */
    this.message = null;
    /** The port it runs (or was asked to run) on. @type {number | null} */
    this.port = null;
    /** The last lines the server wrote (both outputs) and the launcher's notes about it. @type {string[]} */
    this.lastLines = [];
    /** @type {Set<(s: Snapshot) => void>} */
    this.listeners = new Set();
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {{ port: number, testMode: boolean } | null} */
    this.options = null;
    /** Restarts done by itself since the last start(). */
    this.restarts = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.restartTimer = null;
    /** Bumped by start() and stop(), so a port check that ends late doesn't act on an old request. */
    this.generation = 0;
    /** stop() asked the running child to stop. */
    this.stopping = false;
    /** What the child said before it exited, when it couldn't start. @type {{ code: FailCode, message: string } | null} */
    this.failure = null;
  }

  /**
   * Hear about every change of status. Returns a function that stops listening.
   * @param {(s: Snapshot) => void} cb
   */
  onChange(cb) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /**
   * Start the server, unless one is starting or running already. A Light Runner already answering on the port
   * (left running by an earlier launcher, or started by hand) is reported as `running-elsewhere` and left alone;
   * another program answering there is `failed` with `port-in-use`.
   * @param {{ port: number, testMode: boolean }} options
   */
  async start({ port, testMode }) {
    if (this.child || this.status === 'starting' || this.status === 'running') return;
    const generation = ++this.generation;
    this.options = { port, testMode };
    this.restarts = 0;
    this.set('starting', null, null, port);
    const answer = await this.probe(port);
    if (generation !== this.generation) return;
    if (answer === 'light-runner') {
      this.note(`Light Runner is already running on port ${port}`);
      this.set('running-elsewhere', null, null, port);
    } else if (answer === 'other') {
      this.set('failed', 'port-in-use', `Port ${port} is already in use by another program`, port);
    } else {
      this.run();
    }
  }

  /**
   * Ask the server to save the stage and stop; end it after the wait if it hasn't. Resolves when it has stopped.
   * A server this launcher didn't start (`running-elsewhere`) is left running.
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
    const closed = new Promise((resolve) => child.once('close', resolve));
    const timer = setTimeout(() => {
      this.note(`Light Runner did not stop within ${Math.round(this.stopTimeoutMs / 1000)} s; ending it`);
      child.kill();
    }, this.stopTimeoutMs);
    if (child.connected) {
      try {
        child.send({ type: 'shutdown' }, () => {});
      } catch {
        child.kill();
      }
    } else {
      child.kill();
    }
    await closed;
    clearTimeout(timer);
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
    const flushers = [this.lines(child.stdout), this.lines(child.stderr)];
    child.on('message', (/** @type {any} */ m) => {
      if (this.child !== child || !m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        this.set('running', null, null, typeof m.port === 'number' ? m.port : port);
      } else if (m.type === 'error') {
        const code = m.code === 'port-in-use' ? 'port-in-use' : 'start-failed';
        this.failure = { code, message: typeof m.message === 'string' ? m.message : code };
      }
    });
    child.on('error', (err) => {
      if (this.child !== child) return;
      this.note(`Light Runner: ${err.message ?? err}`);
      // No pid: the bundled Node couldn't be run at all (a close may or may not follow). Otherwise a failed send
      // or kill, and the close says the rest.
      if (child.pid === undefined) {
        this.child = null;
        this.failure = { code: 'start-failed', message: String(err.message ?? err) };
        this.exited(null, null);
      }
    });
    child.once('close', (code, signal) => {
      if (this.child !== child) return;
      for (const flush of flushers) flush();
      this.child = null;
      this.exited(code, signal);
    });
  }

  /**
   * @param {number | null} code
   * @param {NodeJS.Signals | null} signal
   */
  exited(code, signal) {
    const port = this.port;
    if (this.stopping) {
      this.stopping = false;
      this.set('stopped', null, null, port);
    } else if (this.failure) {
      // The server said why it couldn't start: starting it again would only say the same.
      this.set('failed', this.failure.code, this.failure.message, port);
    } else if (code === 0) {
      // Stopped cleanly by someone else (Activity Monitor, Task Manager's End task sends no clean stop, a signal does).
      this.note('Light Runner was stopped');
      this.set('stopped', null, null, port);
    } else {
      const how = signal ? `was ended (${signal})` : `stopped unexpectedly (exit code ${code})`;
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
    const changed = status !== this.status || code !== this.code || port !== this.port;
    this.status = status;
    this.code = code;
    this.message = message;
    this.port = port;
    if (!changed) return;
    const snapshot = { status, code, message, port };
    for (const cb of [...this.listeners]) cb(snapshot);
  }
}
