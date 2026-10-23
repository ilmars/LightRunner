// The launcher window: shows what the main process sends (main.js view()) and asks it for actions.
// Everything goes through window.launcher (preload.js); the page has no other way out.

/** @type {any} */
const api = /** @type {any} */ (window).launcher;
const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

/** @type {any} */
let current = null;
/** The port typed but not yet changed: a new view doesn't overwrite it. */
let portDirty = false;
/** The action under way ('fix', 'stop'): its button waits, whatever a new view says. */
let busy = '';
/** The parts folded open or shut by hand. Add is open by itself only on the very first start. */
let addOpen = null;
let optionsOpen = false;
let stepsOpen = false;

/** @param {HTMLElement} el @param {string} text */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** @param {any} v */
function render(v) {
  current = v;
  if (addOpen === null) addOpen = !!v.firstStart;
  $('testPill').hidden = !v.testPill;

  // How it is.
  const status = $('status');
  status.className = `status ${v.tone}`;
  setText($('line'), v.line);
  const problem = !!(v.sentence || v.fix || (v.lines && v.lines.length));
  $('problem').hidden = !problem;
  setText($('sentence'), v.sentence ?? '');
  $('sentence').hidden = !v.sentence;
  setText($('detail'), v.detail ?? '');
  $('lines').hidden = !(v.lines && v.lines.length);
  setText($('lines'), (v.lines ?? []).join('\n'));
  const fix = $('fix');
  fix.hidden = !v.fix;
  if (v.fix) setText(fix, v.fix.kind === 'network' && stepsOpen ? 'Hide the steps' : v.fix.label);
  fix.disabled = busy === 'fix';
  const retry = $('retry');
  retry.hidden = !v.retry;
  retry.disabled = busy === 'fix';
  // The steps for a Public network go with whichever says so: the status line's Fix it, or the note in Add.
  const stepsBy = v.fix?.kind === 'network' ? 'status' : v.firewallNote === 'public' && addOpen ? 'add' : null;
  if (!stepsBy) stepsOpen = false;
  const steps = $('steps');
  const home = stepsBy === 'add' ? $('blocked') : $('problem');
  if (steps.previousElementSibling !== home) home.after(steps);
  steps.hidden = !stepsOpen;

  // The three things people come for.
  const reachable = v.status === 'running' || v.status === 'running-elsewhere';
  $('openOperator').disabled = !reachable;
  $('openSettings').disabled = !reachable;
  $('addDevice').setAttribute('aria-expanded', String(addOpen));

  // Adding an iPad.
  $('add').hidden = !addOpen;
  setText($('url'), v.url);
  $('url').classList.toggle('dim', !reachable);
  // The code only while it leads somewhere.
  $('qr').hidden = !(v.qr && v.address && reachable);
  if (v.qr) {
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.qr)}`;
    if ($('qr').getAttribute('src') !== src) $('qr').setAttribute('src', src);
  }
  const pick = $('pick');
  $('pickRow').hidden = v.addresses.length < 2;
  const options = v.addresses.map((/** @type {any} */ a) => `${a.address}|${a.name}`).join(',');
  if (pick.dataset.options !== options) {
    pick.dataset.options = options;
    pick.replaceChildren(...v.addresses.map((/** @type {any} */ a) => new Option(`${a.name} · ${a.address}`, a.address)));
  }
  if (v.address && pick.value !== v.address) pick.value = v.address;
  $('noNetwork').hidden = v.addresses.length > 0;
  $('firewall').hidden = v.firewallNote !== 'ask';
  // Said once: not here when the status line already says it.
  $('blocked').hidden = v.firewallNote !== 'public' || v.fix?.kind === 'network';
  setText($('howTo'), stepsOpen ? 'Hide the steps' : 'How to fix it');

  // The foot.
  const stop = $('stop');
  stop.hidden = !v.bottom;
  setText(stop, busy === 'stop' ? 'Stopping…' : v.bottom === 'stop-elsewhere' ? 'Stop it' : 'Stop');
  stop.disabled = busy === 'stop';
  $('optionsToggle').setAttribute('aria-expanded', String(optionsOpen));
  $('options').hidden = !optionsOpen;
  setText($('version'), `Version ${v.version}`);
  $('newer').hidden = !v.newer;
  if (v.newer) setText($('newer'), `Version ${v.newer} is available`);

  // Options.
  const port = $('port');
  if (!portDirty && document.activeElement !== port) port.value = String(v.configPort);
  port.disabled = !v.canChange;
  // After the port was taken, Change starts it again on the same port too.
  $('applyPort').disabled = !v.canChange || (!portDirty && v.status !== 'failed');
  const login = $('startAtLogin');
  login.checked = v.startAtLogin;
  login.disabled = !v.canSetLogin;
  login.closest('label').classList.toggle('off', !v.canSetLogin);
  login.closest('label').title = v.canSetLogin ? '' : 'Only the installed Light Runner can start with the computer';
  const test = $('testMode');
  test.checked = v.testMode;
  test.disabled = !v.canChange;
  test.closest('label').classList.toggle('off', !v.canChange);
  $('saveError').hidden = !v.saveError;
  setText($('saveError'), v.saveError ?? '');
}

/** @param {string} action @param {unknown} [value] */
async function act(action, value) {
  const result = await api.act(action, value);
  return result ?? {};
}

/**
 * Run an action with its button waiting; afterwards the view as it is now decides what the buttons are.
 * @param {string} which @param {string} action @param {unknown} [value]
 */
async function withButton(which, action, value) {
  if (busy) return;
  busy = which;
  if (current) render(current);
  try {
    await act(action, value);
  } finally {
    busy = '';
    render(await api.view());
  }
}

/** @param {string} text */
function portNote(text) {
  $('portNote').hidden = !text;
  setText($('portNote'), text);
}

function openOptionsAtPort() {
  optionsOpen = true;
  if (current) render(current);
  const port = $('port');
  $('options').scrollIntoView({ block: 'end' });
  port.focus({ preventScroll: true });
  port.select();
}

$('fix').addEventListener('click', () => {
  const kind = current?.fix?.kind;
  if (kind === 'start') void withButton('fix', 'start');
  else if (kind === 'settings') void act('open-send-dmx');
  else if (kind === 'port') openOptionsAtPort();
  else if (kind === 'network') {
    stepsOpen = !stepsOpen;
    render(current);
  }
});
$('howTo').addEventListener('click', () => {
  stepsOpen = !stepsOpen;
  render(current);
  if (stepsOpen) $('steps').scrollIntoView({ block: 'nearest' });
});
$('openOperator').addEventListener('click', () => void act('open-operator'));
$('openSettings').addEventListener('click', () => void act('open-settings'));
$('addDevice').addEventListener('click', () => {
  addOpen = !addOpen;
  render(current);
  if (addOpen) $('add').scrollIntoView({ block: 'nearest' });
});
$('optionsToggle').addEventListener('click', () => {
  optionsOpen = !optionsOpen;
  render(current);
  if (optionsOpen) $('options').scrollIntoView({ block: 'nearest' });
});
$('retry').addEventListener('click', () => void withButton('fix', 'start'));
// Stop asks first; "Stopping…" only once the answer is Stop.
$('stop').addEventListener('click', async () => {
  if (busy) return;
  const action = current?.bottom === 'stop-elsewhere' ? 'stop-elsewhere' : 'stop';
  const { ok } = await act('confirm-stop', action);
  if (ok) await withButton('stop', action, 'confirmed');
});
$('pick').addEventListener('change', (/** @type {Event} */ e) => void act('address', /** @type {HTMLSelectElement} */ (e.target).value));
$('port').addEventListener('input', () => {
  portDirty = $('port').value.trim() !== String(current?.configPort ?? '');
  $('applyPort').disabled = !portDirty && current?.status !== 'failed';
  portNote('');
});
$('port').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
  if (e.key === 'Escape') {
    portDirty = false;
    $('port').value = String(current?.configPort ?? '');
    $('applyPort').disabled = true;
    portNote('');
  }
});
$('portForm').addEventListener('submit', async (/** @type {Event} */ e) => {
  e.preventDefault();
  const result = await act('port', $('port').value);
  if (result.error) {
    portNote(result.error);
    return;
  }
  portDirty = false;
  portNote('');
  $('port').blur();
  render(await api.view());
});
$('startAtLogin').addEventListener('change', (/** @type {Event} */ e) => void act('start-at-login', /** @type {HTMLInputElement} */ (e.target).checked));
$('testMode').addEventListener('change', (/** @type {Event} */ e) => void act('test-mode', /** @type {HTMLInputElement} */ (e.target).checked));
$('newer').addEventListener('click', (/** @type {Event} */ e) => {
  e.preventDefault();
  void act('open-release');
});

api.onChange(render);
render(await api.view());
// The window takes the height of what it shows.
const page = /** @type {HTMLElement} */ (document.querySelector('.lr'));
new ResizeObserver(() => api.fit(Math.ceil(page.getBoundingClientRect().height))).observe(page);
