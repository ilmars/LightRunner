// The top bar of the programmer pages (Patch and Settings): the clock, an amber pill while something is
// wrong with the lights, a quiet "Not connected" while the server doesn't answer, and requests that say
// so in plain words.

/** What a page says when the server can't be reached. */
export const NOT_ANSWERING = "Light Runner isn't answering. Check that it's running.";

/**
 * `fetch`, but a network failure (or no answer within `timeoutMs`, when given) becomes an Error in plain
 * words instead of the browser's "Failed to fetch".
 */
export async function request(path, init = {}, timeoutMs = 0) {
  const ctl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    return await fetch(path, { ...init, signal: ctl.signal });
  } catch {
    throw new Error(NOT_ANSWERING);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the pill says for the live state's output (`{ long, short, title }`), or null when nothing is wrong.
 * The same words as the operator page's problem pill (`problemWords` in web/operator/app.js): change both together.
 */
export function problemWords(state) {
  if (!state) return null;
  if (state.output === 'off') {
    return { long: 'Not sending to the lights', short: 'Not sending', title: 'DMX output is off: Send DMX is off, or this server was started with output forced off.' };
  }
  if (state.output !== 'lost') return null;
  if (state.outputProblemKind === 'other-desk') {
    return { long: 'Another desk is sending', short: 'Another desk', title: state.outputProblem ?? 'Another desk is also sending to the lights.' };
  }
  return { long: 'Lights not answering', short: 'Not answering', title: state.outputProblem ?? 'The lighting network box is not answering.' };
}

/** Write text only when it changes, so a role="status" element isn't announced again for nothing. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** Show the problem pill for `state` (hidden when nothing is wrong, or when `state` is null). */
export function showProblem(pill, state) {
  const words = problemWords(state);
  if (pill.hidden !== !words) pill.hidden = !words;
  if (!words) return;
  setText(pill.querySelector('.long'), words.long);
  setText(pill.querySelector('.short'), words.short);
  if (pill.title !== words.title) pill.title = words.title;
}

/**
 * Read the live state every 2 s for the top bar. While the server doesn't answer, the problem pill goes
 * (it would be stale), "Not connected" shows, and the reads slow down (4, 8, 16, then every 30 s); the
 * first answer puts everything back. Nothing is read while the tab is hidden; a read gives up after 4 s,
 * so reads never pile up. `onState(state)` runs on each answer (by default it shows the problem pill);
 * `onLost()` when the server stops answering; `onBack()` when it answers again after that.
 */
export function watchState({ pill, offline, onState, onLost, onBack }) {
  const QUICK = 2000, SLOWEST = 30000;
  let delay = QUICK, timer = 0, busy = false, connected = true;
  const setConnected = (on) => {
    if (on === connected) return;
    connected = on;
    offline.hidden = on;
    if (!on) {
      showProblem(pill, null);
      onLost?.();
    } else {
      onBack?.();
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = document.hidden ? 0 : setTimeout(read, delay);
  };
  const read = async () => {
    timer = 0;
    if (busy || document.hidden) return;
    busy = true;
    try {
      const res = await request('/api/state', {}, 4000);
      if (!res.ok) throw new Error(`state ${res.status}`);
      const state = await res.json();
      setConnected(true);
      delay = QUICK;
      if (onState) await onState(state);
      else showProblem(pill, state);
    } catch {
      setConnected(false);
      delay = Math.min(SLOWEST, delay * 2);
    } finally {
      busy = false;
      schedule();
    }
  };
  // Back on the tab: read at once; hidden: stop until it is shown again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      timer = 0;
    } else if (!busy) {
      read();
    }
  });
  read();
}

/** Keep the clock (hours:minutes) up to date. */
export function startClock(el) {
  const tick = () => {
    const d = new Date();
    setText(el, `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
  };
  tick();
  setInterval(tick, 5000);
}
