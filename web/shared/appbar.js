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
 * GET `path` and its JSON, both within `timeoutMs` (a server that answers but then stalls mid-body gives up too).
 * A network failure, a timeout or an error status becomes an Error (in plain words for the first two).
 */
export async function getJson(path, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(path, { signal: ctl.signal });
    } catch {
      throw new Error(NOT_ANSWERING);
    }
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    try {
      return await res.json();
    } catch (err) {
      throw ctl.signal.aborted ? new Error(NOT_ANSWERING) : err;
    }
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
    return { long: 'Not sending to the lights', short: 'Not sending', title: 'Nothing is sent to the lights: Send DMX is off in Settings, or Test mode is on.' };
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
 * first answer puts everything back. Nothing is read while the tab is hidden; a read (its answer's body too)
 * gives up after 4 s, so reads never pile up. `onState(state)` runs on each answer (by default it shows the
 * problem pill; a mistake in it is the page's, never a lost connection); `onLost()` when the server stops
 * answering; `onBack()` when it answers again after that. Gives `refresh()`, to read again now (after a change
 * the state shows, such as Send DMX), or as soon as the read under way is done.
 */
export function watchState({ pill, offline, onState, onLost, onBack }) {
  const QUICK = 2000, SLOWEST = 30000;
  let delay = QUICK, timer = 0, busy = false, connected = true, again = false;
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
    again = false;
    let state = null;
    try {
      state = await getJson('/api/state', 4000);
      setConnected(true);
      delay = QUICK;
    } catch {
      setConnected(false);
      delay = Math.min(SLOWEST, delay * 2);
    }
    try {
      if (state && onState) await onState(state);
      else if (state) showProblem(pill, state);
    } catch (err) {
      console.error('The page could not show the live state:', err);
    } finally {
      busy = false;
      if (again && !document.hidden) read();
      else schedule();
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
  return {
    refresh() {
      if (busy) again = true;
      else if (!document.hidden) {
        clearTimeout(timer);
        read();
      }
    },
  };
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
