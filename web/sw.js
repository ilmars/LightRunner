// Page cache for the home-screen icon. Registered only in a secure context (https or localhost); over the church's
// plain http the browser doesn't allow service workers, so none is registered and this file is never used there.
// Network-first, so an update always reaches the tablet; the cache only answers when the server can't be reached
// (the page then shows its own "Connection lost" banner). Only page files are touched: never /api/, the WebSocket
// or anything else the server answers live. Raise the number in CACHE when this file's rules change; the old
// cache is deleted when the new worker takes over.
const CACHE = 'light-runner-pages-v1';
const PAGE_FILES = ['.html', '.js', '.css', '.svg', '.png', '.woff2', '.webmanifest', '.txt'];
// Kept from the first visit, so the installed app still opens its page (and says the connection is lost).
const SHELL = [
  '/operator/', '/operator/app.js', '/operator/style.css',
  '/shared/theme.css', '/shared/stage.js', '/shared/stagedraw.js', '/shared/press.js', '/shared/colour.js', '/shared/pwa.js', '/shared/fullscreen.js',
  '/shared/fonts/inter-latin-wght-normal.woff2', '/shared/icon.svg', '/shared/icon-16.svg', '/shared/icon-192.png',
  '/manifest.webmanifest',
];

/** True for a page file of this server: a folder's page ("/operator/"), or a file of a page type. Not /api/, not /ws. */
function isPageFile(url) {
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname;
  if (path === '/ws' || path.startsWith('/api/')) return false;
  return path.endsWith('/') || PAGE_FILES.some((ext) => path.endsWith(ext));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One missing file must not stop the worker from installing.
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Anything else goes to the network as if there were no worker.
  if (request.method !== 'GET' || !isPageFile(new URL(request.url))) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)
        .then((hit) => hit ?? (request.mode === 'navigate' ? caches.match('/operator/') : undefined))
        .then((hit) => hit ?? Response.error())),
  );
});
