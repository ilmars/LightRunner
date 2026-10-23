// What the launcher window says about the server, in plain words, and the check of a port typed into it.
// No Electron here, so it is tested on its own.

/** @typedef {import('./server-process.js').Snapshot} Snapshot */
/** @typedef {{ kind: 'start' | 'settings' | 'port' | 'network', label: string }} Fix */
/**
 * @typedef {{
 *   tone: 'ok' | 'warn' | 'bad' | 'quiet',
 *   line: string,
 *   sentence: string | null,
 *   detail: string | null,
 *   fix: Fix | null,
 *   showLines: boolean,
 *   bottom: 'stop' | 'stop-elsewhere' | null,
 *   canChange: boolean,
 * }} Status
 *   `fix`: start the server, open Light Runner's Settings at Send DMX, open the Options at the port, or show how to
 *   let the iPads through Windows' firewall; `bottom`: the quiet Stop (or Stop it) at the foot of the window
 */

import { PORT_MAX, PORT_MIN } from './config.js';

export { PORT_MAX, PORT_MIN };

/**
 * A port typed into the window: a whole number from 1024 to 65535 (as the settings file takes).
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
 * The window's status for the server: one line coloured by its tone, at most one plain sentence (and a detail)
 * under it, and at most one button that fixes it.
 * @param {Snapshot} s
 * @param {{
 *   platform: string, answering?: boolean, pid?: number | null, testMode?: boolean,
 *   output?: string | null, outputWords?: { long: string, title: string } | null, publicNetwork?: boolean,
 * }} context
 *   `answering`: the running server answers this window's reads; `pid`: the process of a server that isn't
 *   answering, when known; `output` and `outputWords`: the live state's output and the operator page's words for a
 *   problem with it (web/shared/appbar.js problemWords); `publicNetwork`: Windows has the iPads' network as Public
 * @returns {Status}
 */
export function describe(s, { platform, answering = true, pid = null, testMode = false, output = null, outputWords = null, publicNetwork = false }) {
  const port = s.port ?? 0;
  /** @type {Status} */
  const w = { tone: 'ok', line: '', sentence: null, detail: null, fix: null, showLines: false, bottom: null, canChange: true };
  /** @param {Partial<Status>} more */
  const set = (more) => Object.assign(w, more);
  const start = /** @type {Fix} */ ({ kind: 'start', label: 'Start' });
  switch (s.status) {
    case 'running':
    case 'running-elsewhere': {
      set({ line: 'Running', bottom: s.status === 'running' ? 'stop' : 'stop-elsewhere' });
      if (s.status === 'running-elsewhere') {
        set({ canChange: false, sentence: `It was started outside this window (port ${port}).`, detail: s.message ?? 'To change the Options here, stop it first.' });
      }
      const notSending = outputWords && !(testMode && s.status === 'running' && output === 'off');
      if (!answering) {
        set({ tone: 'warn', line: 'Running · not answering', sentence: "Light Runner isn't answering this window.", detail: 'If this goes on, stop it and start it again.' });
      } else if (notSending && outputWords) {
        set({
          tone: 'warn',
          line: `Running · ${outputWords.long.charAt(0).toLowerCase()}${outputWords.long.slice(1)}`,
          sentence: output === 'off' ? "Nothing goes to the lights: in Light Runner's Settings, Send DMX is off or no output is chosen." : outputWords.title,
          fix: { kind: 'settings', label: 'Fix it' },
        });
      } else if (publicNetwork && platform === 'win32') {
        set({ tone: 'warn', line: 'Running · the iPads are blocked', sentence: "Windows blocks the iPads on this network (it's set to Public).", fix: { kind: 'network', label: 'Fix it' } });
      }
      break;
    }
    case 'starting':
      set({ tone: 'quiet', line: 'Starting…', bottom: 'stop' });
      break;
    case 'stopped':
      set({ tone: 'bad', line: 'Stopped', sentence: "The iPads can't reach Light Runner until you start it.", detail: s.message, fix: start });
      break;
    case 'failed':
    default:
      w.tone = 'bad';
      if (s.code === 'port-in-use') {
        set({
          line: `Stopped · port ${port} is taken`,
          sentence: `${s.message ?? `Port ${port} is already in use`}.`,
          detail: `Choose another port in the Options, for example ${port >= PORT_MAX ? 8081 : port + 1}.`,
          fix: { kind: 'port', label: 'Fix it' },
        });
      } else if (s.code === 'not-answering') {
        set({
          line: 'Not answering',
          sentence: `Light Runner is already running on this computer (port ${port}) but isn't answering.`,
          detail: `It has to be ended by hand: ${endByHand(platform, pid)} This window notices when it has gone.`,
          canChange: false,
        });
      } else if (s.code === 'stop-failed') {
        set({ line: 'Not stopped', sentence: `${s.message ?? 'Light Runner could not be stopped'}.`, detail: `End it by hand: ${endByHand(platform, pid)}`, fix: start });
      } else if (s.code === 'crashed') {
        set({
          line: 'Stopped · it stopped unexpectedly',
          sentence: `${s.message ?? 'Light Runner stopped unexpectedly'}.`,
          detail: 'It was started again once by itself.',
          showLines: true,
          fix: start,
        });
      } else {
        set({ line: "Stopped · it couldn't start", sentence: `Light Runner couldn't start: ${s.message ?? 'no reason given'}.`, showLines: true, fix: start });
      }
  }
  return w;
}

/**
 * What to say about Windows' firewall where an iPad is added: on a Public network it blocks them ('public', also
 * when the status line has a problem of its own to show); otherwise the gentle 'ask' note until the first iPad has
 * come; nothing on other systems.
 * @param {{ platform: string, publicNetwork: boolean, ipadSeen: boolean }} context
 * @returns {'public' | 'ask' | null}
 */
export function firewallNote({ platform, publicNetwork, ipadSeen }) {
  if (platform !== 'win32') return null;
  if (publicNetwork) return 'public';
  return ipadSeen ? null : 'ask';
}
