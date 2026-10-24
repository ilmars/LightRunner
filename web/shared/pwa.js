// Every page loads this: it registers the service worker (the page cache for the home-screen icon), but only in a
// secure context (https, or localhost). The church's plain http is not one, so nothing is registered there.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
