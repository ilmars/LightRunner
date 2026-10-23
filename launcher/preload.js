// The launcher window's only way to the main process: read what to show, ask for an action, hear of changes.
// A sandboxed preload runs as a plain script (not a module), so it uses require.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  view: () => ipcRenderer.invoke('launcher:view'),
  act: (/** @type {string} */ action, /** @type {unknown} */ value) => ipcRenderer.invoke('launcher:act', action, value),
  fit: (/** @type {number} */ height) => ipcRenderer.send('launcher:fit', height),
  onChange: (/** @type {(view: unknown) => void} */ cb) => {
    ipcRenderer.on('launcher:changed', (_event, view) => cb(view));
  },
});
