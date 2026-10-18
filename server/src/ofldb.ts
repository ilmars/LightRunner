// The whole Open Fixture Library on this computer. OFL keeps its fixture
// definitions in a GitHub repository; its archive is a few MB, so the
// database is downloaded in one go, kept as one file, and compared with the
// next download to show what changed.

import { gunzipSync } from 'node:zlib';
import type { OflFixture } from '../../packages/shared/src/index.ts';

export const OFL_ARCHIVE = 'https://codeload.github.com/OpenLightingProject/open-fixture-library/tar.gz/refs/heads/master';
export const OFL_LATEST = 'https://api.github.com/repos/OpenLightingProject/open-fixture-library/commits/master';

export interface OflDb {
  /** Git commit the files came from. */
  sha: string | null;
  downloadedAt: string;
  manufacturers: Record<string, { name: string; website?: string }>;
  /** "manufacturer/fixture" → definition. */
  fixtures: Record<string, OflFixture>;
}

export interface DbChange {
  key: string;
  name: string;
  manufacturer: string;
}

export interface DbDiff {
  added: DbChange[];
  changed: DbChange[];
  removed: DbChange[];
}

/** Read a .tar.gz into its files. Handles ustar prefixes and pax long names; returns the archive's commit id when GitHub put one in. */
export function readTarGz(data: Buffer, want: (name: string) => boolean): { files: Map<string, Buffer>; comment: string | null } {
  const tar = gunzipSync(data);
  const files = new Map<string, Buffer>();
  let comment: string | null = null;
  let longName: string | null = null;
  let off = 0;
  const str = (a: number, n: number) => tar.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
  const paxValues = (body: Buffer) => {
    const out: Record<string, string> = {};
    for (const line of body.toString('utf8').split('\n')) {
      const m = line.match(/^\d+ ([^=]+)=(.*)$/s);
      if (m) out[m[1]] = m[2];
    }
    return out;
  };
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = Number.parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(off + 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${str(off, 100)}` : str(off, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    longName = null;
    if (type === 'g') comment = paxValues(body).comment ?? comment;
    else if (type === 'x') longName = paxValues(body).path ?? null;
    else if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if ((type === '0' || type === '\0') && want(name)) files.set(name, Buffer.from(body));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { files, comment };
}

/** Turn the repository archive into a database. */
export function dbFromArchive(data: Buffer): OflDb {
  const { files, comment } = readTarGz(data, (n) => /\/fixtures\/[^/]+(\/[^/]+)?\.json$/.test(n));
  let manufacturers: OflDb['manufacturers'] = {};
  const fixtures: OflDb['fixtures'] = {};
  for (const [name, body] of files) {
    const m = name.match(/\/fixtures\/([^/]+)\/([^/]+)\.json$/);
    if (name.endsWith('/fixtures/manufacturers.json')) {
      manufacturers = JSON.parse(body.toString('utf8'));
      delete (manufacturers as Record<string, unknown>)['$schema'];
    } else if (m) {
      try {
        const fixture = JSON.parse(body.toString('utf8')) as OflFixture & { redirectTo?: string };
        // Renamed fixtures leave a redirect file behind; skip those.
        if (Array.isArray(fixture.modes) && !fixture.redirectTo) fixtures[`${m[1]}/${m[2]}`] = fixture;
      } catch {
        // a broken file in the archive is skipped
      }
    }
  }
  if (!Object.keys(fixtures).length) throw new Error('the download had no fixtures in it');
  return { sha: comment, downloadedAt: new Date().toISOString(), manufacturers, fixtures };
}

const change = (db: OflDb, key: string): DbChange => {
  const man = key.split('/')[0];
  return { key, name: db.fixtures[key]?.name ?? key, manufacturer: db.manufacturers[man]?.name ?? man };
};

/** What a new download adds, changes and removes compared with the current one. */
export function diffDb(current: OflDb, next: OflDb): DbDiff {
  const diff: DbDiff = { added: [], changed: [], removed: [] };
  for (const key of Object.keys(next.fixtures)) {
    if (!(key in current.fixtures)) diff.added.push(change(next, key));
    else if (JSON.stringify(current.fixtures[key]) !== JSON.stringify(next.fixtures[key])) diff.changed.push(change(next, key));
  }
  for (const key of Object.keys(current.fixtures)) if (!(key in next.fixtures)) diff.removed.push(change(current, key));
  const byName = (a: DbChange, b: DbChange) => `${a.manufacturer} ${a.name}`.localeCompare(`${b.manufacturer} ${b.name}`);
  diff.added.sort(byName);
  diff.changed.sort(byName);
  diff.removed.sort(byName);
  return diff;
}
