// A full screen button for pages opened in a browser over plain http, where "install as app" isn't offered (Android
// Chrome). Uses the Fullscreen API: iPhone Safari has none for pages, and a page already opened from the home screen
// (standalone) or in full screen has no use for it; the button stays hidden in those cases.

const ENTER = '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>';
const LEAVE = '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>';

/** True when the page is already shown like an app (opened from the home screen). */
export function isStandalone() {
  return navigator.standalone === true
    || (window.matchMedia?.('(display-mode: standalone)').matches ?? false)
    || (window.matchMedia?.('(display-mode: fullscreen)').matches ?? false);
}

/** The Fullscreen API this browser has (standard or webkit-prefixed), or null. */
function api(doc = document) {
  const el = doc.documentElement;
  if (typeof el.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) {
    return { on: () => doc.fullscreenElement != null, enter: () => el.requestFullscreen({ navigationUI: 'hide' }), leave: () => doc.exitFullscreen(), change: 'fullscreenchange', error: 'fullscreenerror' };
  }
  if (typeof el.webkitRequestFullscreen === 'function' && doc.webkitFullscreenEnabled !== false) {
    return { on: () => doc.webkitFullscreenElement != null, enter: () => el.webkitRequestFullscreen(), leave: () => doc.webkitExitFullscreen(), change: 'webkitfullscreenchange', error: 'webkitfullscreenerror' };
  }
  return null;
}

/** Shows `button` (an icon button holding an svg) when full screen is possible here, and makes it toggle. */
export function setupFullscreen(button) {
  const fs = api();
  if (!fs || isStandalone()) return;
  const svg = button.querySelector('svg');
  const show = () => {
    const on = fs.on();
    const label = on ? 'Leave full screen' : 'Full screen';
    if (svg) svg.innerHTML = on ? LEAVE : ENTER;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(on));
  };
  button.hidden = false;
  show();
  button.addEventListener('click', async () => {
    try {
      await (fs.on() ? fs.leave() : fs.enter());
    } catch {
      // refused (a browser setting, an in-app browser): nothing changes
    }
  });
  document.addEventListener(fs.change, show);
  // Refused outright: the button can't work here, so hide it.
  document.addEventListener(fs.error, () => { if (!fs.on()) button.hidden = true; });
  // A page can be installed while it is open (Chrome's install prompt): hide the button then too.
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', () => { if (isStandalone()) button.hidden = true; });
}
