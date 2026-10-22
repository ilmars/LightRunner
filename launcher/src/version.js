// Is there a newer Light Runner on GitHub? Compares this version with the latest release's tag.

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
