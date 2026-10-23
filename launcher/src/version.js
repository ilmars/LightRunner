// Is there a newer Light Runner on GitHub? Compares this version with the latest release's tag, which is asked for
// at most once a day (kept in a small file between starts), and never makes a fuss when offline.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

const PLAIN = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {unknown} text
 * @returns {number[] | null}
 */
function parse(text) {
  const m = typeof text === 'string' ? PLAIN.exec(text) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The latest release's version (without the "v") when it is newer than this one; otherwise null,
 * also for a tag or version that isn't a plain x.y.z (a pre-release, "latest", nothing).
 * @param {string} current
 * @param {string} latestTag
 * @returns {string | null}
 */
export function newerVersion(current, latestTag) {
  const a = parse(current);
  const b = parse(latestTag);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return b.join('.');
    if (b[i] < a[i]) return null;
  }
  return null;
}

/**
 * Is a check due: there was none, the last was a day ago or more, or the clock has gone back since?
 * @param {unknown} checkedAt when the last check was made (ms)
 * @param {number} now
 */
export function checkDue(checkedAt, now) {
  return !(typeof checkedAt === 'number' && Number.isFinite(checkedAt) && now >= checkedAt && now - checkedAt < DAY);
}

/**
 * The latest release's tag, asked for at most once a day; otherwise (and when it can't be asked: offline, GitHub
 * refusing) the one known from the last check, or null. An attempt counts as the day's check even when it fails.
 * @param {{ cacheFile: string, fetchLatest: () => Promise<string | null>, now?: () => number }} options
 *   `fetchLatest` asks GitHub (fetchLatestTag) and throws when it can't
 * @returns {Promise<string | null>}
 */
export async function latestTag({ cacheFile, fetchLatest, now = Date.now }) {
  /** @type {{ checkedAt?: unknown, latest?: unknown }} */
  let cache = {};
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (parsed && typeof parsed === 'object') cache = parsed;
  } catch {}
  let latest = typeof cache.latest === 'string' ? cache.latest : null;
  if (!checkDue(cache.checkedAt, now())) return latest;
  /** @param {string | null} tag */
  const write = (tag) => {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ checkedAt: now(), latest: tag }));
    } catch {}
  };
  write(latest);
  try {
    latest = await fetchLatest();
    write(latest);
  } catch {}
  return latest;
}

/**
 * Ask GitHub for the latest release's tag: null when there is no release (404, or no tag in the answer); throws
 * when offline or for any other answer.
 * @param {typeof fetch} fetchImpl
 * @param {string} url the API's releases/latest
 * @param {string} userAgent GitHub wants one
 * @returns {Promise<string | null>}
 */
export async function fetchLatestTag(fetchImpl, url, userAgent) {
  const res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': userAgent }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const tag = /** @type {any} */ (await res.json())?.tag_name;
  return typeof tag === 'string' ? tag : null;
}
