// The launcher window: shows what the main process sends (main.js view()) and asks it for actions.
// Everything goes through window.launcher (preload.js); the page has no other way out.

/** @type {any} */
const api = /** @type {any} */ (window).launcher;
const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

/** @type {any} */
let current = null;
/** The port typed but not yet changed: a new view doesn't overwrite it. */
let portDirty = false;

/** @param {HTMLElement} el @param {string} text */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** @param {any} v */
function render(v) {
  current = v;
  setText($('headline'), v.headline);
  $('testPill').hidden = !v.testPill;
  $('problem').hidden = !v.problem;
  if (v.problem) {
    setText($('problem'), v.problem.text);
    $('problem').title = v.problem.title ?? '';
  }

  // The address and the code (only while the iPads could reach it there).
  const reachable = v.status === 'running' || v.status === 'running-elsewhere';
  setText($('url'), v.url);
  $('url').classList.toggle('dim', !reachable);
  $('qr').hidden = !(v.qr && reachable && v.address);
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
  $('firewall').hidden = !v.firewallNote;

  // What to know.
  const notice = $('notice');
  notice.hidden = !v.notice;
  if (v.notice) {
    notice.classList.toggle('warn', v.notice.tone === 'warn');
    setText($('noticeText'), v.notice.text);
    setText($('noticeDetail'), v.notice.detail ?? '');
  }
  $('lines').hidden = !(v.lines && v.lines.length);
  setText($('lines'), (v.lines ?? []).join('\n'));
  $('elsewhereActions').hidden = !v.stopElsewhere;

  // Buttons.
  $('openOperator').disabled = !reachable;
  $('openSettings').disabled = !reachable;
  const startStop = $('startStop');
  startStop.hidden = !v.button;
  setText(startStop, v.button === 'stop' ? 'Stop' : 'Start');
  startStop.classList.toggle('ds-btn--primary', v.button === 'start');
  startStop.classList.toggle('ds-btn--quiet', v.button !== 'start');
  startStop.disabled = v.button === 'start' && !v.canStart;

  // Settings.
  const port = $('port');
  if (!portDirty && document.activeElement !== port) port.value = String(v.configPort);
  port.disabled = !v.canChange;
  $('applyPort').disabled = !v.canChange || !portDirty;
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

  setText($('version'), `Version ${v.version}`);
  $('newer').hidden = !v.newer;
  if (v.newer) setText($('newer'), `Version ${v.newer} is available`);
}

/** @param {string} action @param {unknown} [value] */
async function act(action, value) {
  const result = await api.act(action, value);
  return result ?? {};
}

/** @param {string} text */
function portNote(text) {
  $('portNote').hidden = !text;
  setText($('portNote'), text);
}

$('openOperator').addEventListener('click', () => void act('open-operator'));
$('openSettings').addEventListener('click', () => void act('open-settings'));
$('startStop').addEventListener('click', async (/** @type {Event} */ e) => {
  const button = /** @type {HTMLButtonElement} */ (e.currentTarget);
  button.disabled = true;
  try {
    await act(current?.button === 'stop' ? 'stop' : 'start');
  } finally {
    button.disabled = false;
  }
});
$('stopElsewhere').addEventListener('click', async (/** @type {Event} */ e) => {
  const button = /** @type {HTMLButtonElement} */ (e.currentTarget);
  button.disabled = true;
  setText(button, 'Stopping…');
  try {
    await act('stop-elsewhere');
  } finally {
    button.disabled = false;
    setText(button, 'Stop it');
  }
});
$('pick').addEventListener('change', (/** @type {Event} */ e) => void act('address', /** @type {HTMLSelectElement} */ (e.target).value));
$('port').addEventListener('input', () => {
  portDirty = $('port').value.trim() !== String(current?.configPort ?? '');
  $('applyPort').disabled = !portDirty;
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
