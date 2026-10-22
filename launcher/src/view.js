// What the launcher window says about the server, in plain words, and the check of a port typed into it.
// No Electron here, so it is tested on its own.

/** @typedef {import('./server-process.js').Snapshot} Snapshot */
/**
 * @typedef {{
 *   headline: string,
 *   notice: { tone: 'quiet' | 'warn', text: string, detail: string | null } | null,
 *   showLines: boolean,
 *   button: 'start' | 'stop' | null,
 *   canStart: boolean,
 *   stopElsewhere: boolean,
 *   canChange: boolean,
 * }} Words
 */

export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

/**
 * A port typed into the window: a whole number from 1024 to 65535 (lower ones need an administrator on some systems
 * and are taken by other services).
 * @param {unknown} text
 * @returns {{ port: number, error?: undefined } | { port?: undefined, error: string }}
 */
export function checkPort(text) {
  const t = String(text ?? '').trim();
  const port = /^\d{1,5}$/.test(t) ? Number(t) : NaN;
  if (!(port >= PORT_MIN && port <= PORT_MAX)) return { error: `The port is a number from ${PORT_MIN} to ${PORT_MAX}, for example 8080` };
  return { port };
}

/**
 * How to end the server by hand on this system.
 * @param {string} platform
 * @param {number | null | undefined} pid its process number, when known
 */
function endByHand(platform, pid) {
  if (platform === 'darwin') return pid ? `open Activity Monitor and quit "node" with the PID ${pid}.` : 'open Activity Monitor and quit "node".';
  if (platform === 'win32') {
    return pid ? `open Task Manager (Ctrl+Shift+Esc) and, on its Details page, end node.exe with the PID ${pid}.` : 'open Task Manager (Ctrl+Shift+Esc) and end "Node.js JavaScript Runtime".';
  }
  return pid ? `end the "node" process ${pid}.` : 'end the "node" process.';
}

/**
 * The window's words for the server's status.
 * @param {Snapshot} s
 * @param {{ platform: string, answering?: boolean, pid?: number | null }} context `answering`: the running server
 *   answers this window's reads; `pid`: the process of a server that isn't answering, when known
 * @returns {Words}
 */
export function describe(s, { platform, answering = true, pid = null }) {
  const port = s.port ?? 0;
  /** @type {Words} */
  const w = { headline: '', notice: null, showLines: false, button: null, canStart: true, stopElsewhere: false, canChange: true };
  switch (s.status) {
    case 'running':
      w.headline = 'Running';
      w.button = 'stop';
      if (!answering) w.notice = { tone: 'warn', text: "Light Runner isn't answering.", detail: 'If this goes on, stop it and start it again.' };
      break;
    case 'starting':
      w.headline = 'Starting…';
      w.button = 'stop';
      break;
    case 'stopped':
      w.headline = 'Stopped';
      w.button = 'start';
      w.notice = { tone: 'quiet', text: "The iPads can't reach Light Runner until you start it.", detail: s.message };
      break;
    case 'running-elsewhere':
      w.headline = 'Already running';
      w.stopElsewhere = true;
      w.canChange = false;
      w.notice = {
        tone: 'quiet',
        text: `Light Runner is already running on this computer (port ${port}).`,
        detail: s.message ?? 'To change its port or Test mode here, stop it first.',
      };
      break;
    case 'failed':
    default:
      w.button = 'start';
      if (s.code === 'port-in-use') {
        w.headline = 'Not running';
        w.notice = { tone: 'warn', text: `${s.message ?? `Port ${port} is already in use`}.`, detail: `Choose another port below, for example ${port >= PORT_MAX ? 8081 : port + 1}.` };
      } else if (s.code === 'not-answering') {
        w.headline = 'Not answering';
        w.canStart = false;
        w.canChange = false;
        w.notice = {
          tone: 'warn',
          text: `Light Runner is already running on this computer (port ${port}) but isn't answering.`,
          detail: `It has to be ended by hand: ${endByHand(platform, pid)} This window notices when it has gone.`,
        };
      } else if (s.code === 'stop-failed') {
        w.headline = 'Not stopped';
        w.notice = { tone: 'warn', text: `${s.message ?? 'Light Runner could not be stopped'}.`, detail: `End it by hand: ${endByHand(platform, pid)}` };
      } else if (s.code === 'crashed') {
        w.headline = 'Stopped';
        w.showLines = true;
        w.notice = { tone: 'warn', text: `${s.message ?? 'Light Runner stopped unexpectedly'}.`, detail: 'It was started again once by itself. Press Start to try again.' };
      } else {
        w.headline = 'Not running';
        w.showLines = true;
        w.notice = { tone: 'warn', text: `Light Runner couldn't start: ${s.message ?? 'no reason given'}.`, detail: null };
      }
  }
  return w;
}
