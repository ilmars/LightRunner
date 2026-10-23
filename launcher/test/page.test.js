import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPage } from '../src/page.js';

// Only the window's own page may talk to the main process: the frame's address is compared with the page's file.

const WIN_PAGE = win32.join('C:/', 'Users', 'Jānis Bērziņš', 'AppData', 'Local', 'Programs', 'light runner', 'resources', 'app.asar', 'ui', 'index.html');
const MAC_PAGE = posix.join('/Applications', 'Light Runner.app', 'Contents', 'Resources', 'app.asar', 'ui', 'index.html');

test('the page itself, however its address is written', () => {
  const url = pathToFileURL(WIN_PAGE, { windows: true }).href;
  assert.match(url, /%C4%81/, 'ā is percent-encoded in the address');
  assert.match(url, /light%20runner/);
  for (const u of [url, `${url}#top`, `${url}?x=1`, url.replace('file:///C:', 'file:///c:'), url.replace(/%20/g, ' ')]) {
    assert.equal(isPage(u, WIN_PAGE, 'win32'), true, u);
  }
  const mac = pathToFileURL(MAC_PAGE, { windows: false }).href;
  assert.equal(isPage(mac, MAC_PAGE, 'darwin'), true);
  assert.equal(isPage(`${mac}#x`, MAC_PAGE, 'darwin'), true);
});

test('anything else is not the page', () => {
  const other = WIN_PAGE.replace('index.html', 'other.html');
  for (const u of [pathToFileURL(other, { windows: true }).href, 'https://example.com/ui/index.html', 'http://localhost:8080/', 'devtools://devtools/bundled/x.html', 'not a url', '']) {
    assert.equal(isPage(u, WIN_PAGE, 'win32'), false, u);
  }
  // On a Mac the case of a name matters.
  assert.equal(isPage(pathToFileURL(MAC_PAGE.replace('index', 'Index'), { windows: false }).href, MAC_PAGE, 'darwin'), false);
});
