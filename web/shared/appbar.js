// The top bar of the programmer pages (Patch and Settings): the clock, and an amber pill while something
// is wrong with the lights, in the operator page's words.

/** What the pill says for the live state's output (`{ long, short, title }`), or null when nothing is wrong. */
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

/** Show the problem pill for `state` (hidden when nothing is wrong). */
export function showProblem(pill, state) {
  const words = problemWords(state);
  pill.hidden = !words;
  if (!words) return;
  pill.querySelector('.long').textContent = words.long;
  pill.querySelector('.short').textContent = words.short;
  pill.title = words.title;
}

/** Keep the clock (hours:minutes) up to date. */
export function startClock(el) {
  const tick = () => {
    const d = new Date();
    el.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 5000);
}
