// Is a frame's address the launcher window's own page? Compared as decoded file paths, not as addresses: the
// install folder may have spaces and letters such as ā, which an address writes in more than one way.

import { normalize as normalizePosix } from 'node:path/posix';
import { normalize as normalizeWin32 } from 'node:path/win32';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} url the frame's address
 * @param {string} pagePath the page's file
 * @param {string} [platform] Windows compares without regard to case, as its file names are
 */
export function isPage(url, pagePath, platform = process.platform) {
  const windows = platform === 'win32';
  let path;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    parsed.hash = '';
    parsed.search = '';
    path = fileURLToPath(parsed, { windows });
  } catch {
    return false;
  }
  const normalize = windows ? normalizeWin32 : normalizePosix;
  const a = normalize(path).normalize('NFC');
  const b = normalize(pagePath).normalize('NFC');
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}
