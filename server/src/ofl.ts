// Open Fixture Library client. With the whole database downloaded (see
// ofldb.ts) everything works from this computer; without it, search and
// fixture files come from open-fixture-library.org and are cached on disk.

import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeMode, oflToProfile, type OflFixture, type Profile } from '../../packages/shared/src/index.ts';
import { OFL_ARCHIVE, OFL_LATEST, dbFromArchive, diffDb, type DbChange, type DbDiff, type OflDb } from './ofldb.ts';
import { writeAtomic } from './store.ts';

const BASE = 'https://open-fixture-library.org';
const MANUFACTURERS_MAX_AGE = 7 * 24 * 3600_000;
const KEY = /^[a-z0-9-]+$/;

export interface OflSearchHit {
  key: string;
  manufacturer: string;
  name: string;
  categories: string[];
}

export interface OflModeInfo {
  index: number;
  name: string;
  shortName: string | null;
  channels: number;
  roles: string[];
}

export interface DbStatus {
  installed: boolean;
  sha: string | null;
  downloadedAt: string | null;
  fixtures: number;
  manufacturers: number;
  /** A download is running. */
  downloading: boolean;
  error: string | null;
  /** Set after "Check for updates" found nothing new. */
  upToDate: boolean;
  /** A downloaded update waiting to be installed, with what it changes. */
  update: (Omit<DbDiff, 'changed'> & { sha: string | null; changed: (DbChange & { usedInShow: boolean })[] }) | null;
}

export class OflClient {
  private readonly dir: string;
  private readonly fetchFn: typeof fetch;
  private manufacturers: Record<string, { name: string }> | null = null;
  /** undefined until first read from disk; null when not downloaded. */
  private db: OflDb | null | undefined = undefined;
  private downloading = false;
  private error: string | null = null;
  private upToDate = false;
  private staged: { db: OflDb; diff: DbDiff } | null = null;

  constructor(dir: string, fetchFn: typeof fetch = fetch) {
    this.dir = dir;
    this.fetchFn = fetchFn;
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
  }

  private get dbFile(): string {
    return join(this.dir, 'database.json');
  }

  /** The downloaded database, or null. */
  database(): OflDb | null {
    if (this.db === undefined) {
      try {
        this.db = JSON.parse(readFileSync(this.dbFile, 'utf8')) as OflDb;
      } catch {
        this.db = null;
      }
    }
    return this.db;
  }

  status(usedInShow: (key: string) => boolean = () => false): DbStatus {
    const db = this.database();
    return {
      installed: Boolean(db),
      sha: db?.sha ?? null,
      downloadedAt: db?.downloadedAt ?? null,
      fixtures: db ? Object.keys(db.fixtures).length : 0,
      manufacturers: db ? Object.keys(db.manufacturers).length : 0,
      downloading: this.downloading,
      error: this.error,
      upToDate: this.upToDate,
      update: this.staged
        ? { sha: this.staged.db.sha, added: this.staged.diff.added, removed: this.staged.diff.removed, changed: this.staged.diff.changed.map((c) => ({ ...c, usedInShow: usedInShow(c.key) })) }
        : null,
    };
  }

  /**
   * Download the whole database in the background. The first download is
   * installed straight away; later ones wait, with what they change, until
   * someone installs or discards them.
   */
  startDownload(): void {
    if (this.downloading) return;
    this.downloading = true;
    this.error = null;
    this.upToDate = false;
    void (async () => {
      try {
        const current = this.database();
        if (current?.sha) {
          // Skip the download when GitHub says nothing changed.
          const latest = await this.latestSha().catch(() => null);
          if (latest && latest === current.sha) {
            this.upToDate = true;
            this.staged = null;
            return;
          }
        }
        const res = await this.fetchFn(OFL_ARCHIVE, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        const next = dbFromArchive(Buffer.from(await res.arrayBuffer()));
        if (!current) {
          this.install(next);
        } else {
          const diff = diffDb(current, next);
          if (!diff.added.length && !diff.changed.length && !diff.removed.length) {
            this.install(next);
            this.upToDate = true;
          } else {
            this.staged = { db: next, diff };
          }
        }
      } catch (err) {
        this.error = `Couldn't download the fixture database: ${(err as Error).message}. Check this computer's internet connection.`;
      } finally {
        this.downloading = false;
      }
    })();
  }

  private async latestSha(): Promise<string | null> {
    const res = await this.fetchFn(OFL_LATEST, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { sha?: string }).sha ?? null;
  }

  private install(db: OflDb): void {
    writeAtomic(this.dbFile, JSON.stringify(db));
    this.db = db;
    this.manufacturers = null;
  }

  installUpdate(): void {
    if (!this.staged) throw new Error('there is no update to install');
    this.install(this.staged.db);
    this.staged = null;
  }

  discardUpdate(): void {
    this.staged = null;
  }

  /** Manufacturers with how many fixtures each has. */
  async manufacturerList(): Promise<{ key: string; name: string; count: number }[]> {
    const db = this.database();
    let list: { key: string; name: string; count: number }[];
    if (db) {
      const counts = new Map<string, number>();
      for (const key of Object.keys(db.fixtures)) counts.set(key.split('/')[0], (counts.get(key.split('/')[0]) ?? 0) + 1);
      list = [...counts.entries()].map(([key, count]) => ({ key, name: db.manufacturers[key]?.name ?? key, count }));
    } else {
      const data = (await this.getJson('/api/v1/manufacturers')) as Record<string, { name: string; fixtureCount?: number }>;
      list = Object.entries(data).map(([key, m]) => ({ key, name: m.name, count: m.fixtureCount ?? 0 }));
    }
    return list.filter((m) => m.count > 0).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One manufacturer's fixtures. */
  async manufacturerFixtures(man: string): Promise<OflSearchHit[]> {
    if (!KEY.test(man)) throw new Error('not an Open Fixture Library key');
    const db = this.database();
    if (db) {
      return Object.entries(db.fixtures)
        .filter(([key]) => key.startsWith(`${man}/`))
        .map(([key, f]) => ({ key, manufacturer: db.manufacturers[man]?.name ?? man, name: f.name, categories: f.categories ?? [] }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const data = (await this.getJson(`/api/v1/manufacturers/${man}`)) as { name: string; fixtures: { key: string; name: string; categories?: string[] }[] };
    return data.fixtures.map((f) => ({ key: `${man}/${f.key}`, manufacturer: data.name, name: f.name, categories: f.categories ?? [] }));
  }

  private async getJson(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.fetchFn(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Open Fixture Library answered ${res.status}`);
    return res.json();
  }

  private cached(file: string, maxAge = Infinity): unknown | null {
    try {
      if (Date.now() - statSync(file).mtimeMs > maxAge) return null;
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async manufacturerNames(): Promise<Record<string, { name: string }>> {
    if (this.manufacturers) return this.manufacturers;
    const db = this.database();
    if (db) return (this.manufacturers = db.manufacturers);
    const file = join(this.dir, 'manufacturers.json');
    let data = this.cached(file, MANUFACTURERS_MAX_AGE) as Record<string, { name: string }> | null;
    if (!data) {
      try {
        data = (await this.getJson('/api/v1/manufacturers')) as Record<string, { name: string }>;
        writeAtomic(file, JSON.stringify(data));
      } catch (err) {
        // Offline: an old list is better than none.
        data = this.cached(file) as Record<string, { name: string }> | null;
        if (!data) throw err;
      }
    }
    this.manufacturers = data;
    return data;
  }

  /** Search by name. Uses the downloaded database when there is one; online otherwise, with a cache fallback. */
  async search(query: string): Promise<{ hits: OflSearchHit[]; offline: boolean; local: boolean }> {
    const q = query.trim();
    if (q.length < 2) return { hits: [], offline: false, local: Boolean(this.database()) };
    const db = this.database();
    if (db) {
      // Every word must match the brand, name, key or a category.
      const words = q.toLowerCase().split(/\s+/);
      const hits = Object.entries(db.fixtures)
        .map(([key, f]) => {
          const man = key.split('/')[0];
          const hay = `${db.manufacturers[man]?.name ?? man} ${f.name} ${f.shortName ?? ''} ${key} ${(f.categories ?? []).join(' ')}`.toLowerCase();
          return words.every((w) => hay.includes(w)) ? { key, manufacturer: db.manufacturers[man]?.name ?? man, name: f.name, categories: f.categories ?? [] } : null;
        })
        .filter((h): h is OflSearchHit => h !== null)
        .sort((a, b) => `${a.manufacturer} ${a.name}`.localeCompare(`${b.manufacturer} ${b.name}`))
        .slice(0, 80);
      return { hits, offline: false, local: true };
    }
    let keys: string[];
    let offline = false;
    try {
      keys = (await this.getJson('/api/v1/get-search-results', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searchQuery: q, manufacturersQuery: [], categoriesQuery: [] }),
      })) as string[];
    } catch {
      offline = true;
      keys = this.downloaded().filter((k) => k.replace(/[/-]/g, ' ').includes(q.toLowerCase()));
    }
    const names = await this.manufacturerNames().catch(() => ({} as Record<string, { name: string }>));
    const hits = keys.slice(0, 60).map((key) => {
      const [man, fix] = key.split('/');
      const local = this.cached(this.fixtureFile(man, fix)) as OflFixture | null;
      return {
        key,
        manufacturer: names[man]?.name ?? man,
        name: local?.name ?? fix.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        categories: local?.categories ?? [],
      };
    });
    return { hits, offline, local: false };
  }

  private fixtureFile(man: string, fix: string): string {
    return join(this.dir, 'fixtures', `${man}__${fix}.json`);
  }

  private downloaded(): string[] {
    try {
      return (readFileSync(join(this.dir, 'fixtures', '.index'), 'utf8').split('\n').filter(Boolean));
    } catch {
      return [];
    }
  }

  /** A fixture's file: from the cache when there, else downloaded and cached. */
  async fixture(key: string): Promise<{ fixture: OflFixture; manufacturerKey: string; fixtureKey: string; manufacturer: string }> {
    const [man, fix] = key.split('/');
    if (!man || !fix || !KEY.test(man) || !KEY.test(fix)) throw new Error('not an Open Fixture Library key');
    const file = this.fixtureFile(man, fix);
    let fixture = (this.database()?.fixtures[key] ?? this.cached(file)) as OflFixture | null;
    if (!fixture) {
      fixture = (await this.getJson(`/${man}/${fix}.json`)) as OflFixture;
      if (!Array.isArray(fixture?.modes)) throw new Error('that fixture file has no modes');
      writeAtomic(file, JSON.stringify(fixture));
      const index = new Set(this.downloaded());
      index.add(key);
      writeAtomic(join(this.dir, 'fixtures', '.index'), [...index].join('\n'));
    }
    const names = await this.manufacturerNames().catch(() => ({} as Record<string, { name: string }>));
    return { fixture, manufacturerKey: man, fixtureKey: fix, manufacturer: names[man]?.name ?? man };
  }

  async modes(key: string): Promise<{ key: string; name: string; manufacturer: string; modes: OflModeInfo[] }> {
    const { fixture, manufacturer } = await this.fixture(key);
    return {
      key,
      name: fixture.name,
      manufacturer,
      modes: fixture.modes.map((m, index) => ({ index, name: m.name, shortName: m.shortName ?? null, ...describeMode(fixture, m) })),
    };
  }

  async profile(key: string, modeIndex: number): Promise<Profile> {
    const { fixture, manufacturerKey, fixtureKey, manufacturer } = await this.fixture(key);
    return oflToProfile(fixture, modeIndex, manufacturerKey, fixtureKey, manufacturer);
  }
}
