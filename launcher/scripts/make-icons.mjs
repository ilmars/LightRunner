// Draws the launcher's icons from the design system's SVGs (web/shared/icon.svg and icon-16.svg), with Electron's
// own Chromium: `npx electron scripts/make-icons.mjs`. Run it again when the icon changes; the PNGs are kept in git.
//
//   resources/icon.png       1024 px, the Windows app icon (electron-builder makes the .ico from it)
//   resources/icon-mac.png   1024 px with the Mac's margin round the square (electron-builder makes the .icns)
//   assets/icon.png          256 px, the window's icon on Windows while developing
//   assets/tray.png, @2x     the Windows tray icon (the 16 px drawing)
//   assets/trayTemplate.png, @2x   the Mac menu bar icon: the segments in black, as macOS wants (it tints them)

import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = join(launcher, '..', 'web', 'shared');
const master = readFileSync(join(shared, 'icon.svg'), 'utf8');
const small = readFileSync(join(shared, 'icon-16.svg'), 'utf8');
// The menu bar's: the 16 px drawing's three segments, black at three strengths, no square behind them.
const template = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 1024 1024">
  <rect x="60" y="352" width="220" height="320" rx="70" fill="#000" fill-opacity=".38"/>
  <rect x="340" y="352" width="220" height="320" rx="70" fill="#000" fill-opacity=".66"/>
  <rect x="620" y="352" width="344" height="320" rx="70" fill="#000"/>
</svg>`;

/** [file, svg, canvas size, drawn size] */
const jobs = [
  ['resources/icon.png', master, 1024, 1024],
  ['resources/icon-mac.png', master, 1024, 824],
  ['assets/icon.png', master, 256, 256],
  ['assets/tray.png', small, 16, 16],
  ['assets/tray@2x.png', small, 32, 32],
  ['assets/trayTemplate.png', template, 16, 16],
  ['assets/trayTemplate@2x.png', template, 32, 32],
];

// Not a top-level await: Electron is ready only once this module has run.
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const [file, svg, size, drawn] of jobs) {
    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      const g = c.getContext('2d');
      const at = (${size} - ${drawn}) / 2;
      g.drawImage(img, at, at, ${drawn}, ${drawn});
      return c.toDataURL('image/png');
    })()`);
    writeFileSync(join(launcher, file), Buffer.from(png.split(',')[1], 'base64'));
    console.log(`make-icons: ${file} (${size} px)`);
  }
  app.quit();
});
