// Open Fixture Library client: search, manufacturers and fixture files from
// open-fixture-library.org, cached on disk so fixtures already looked at keep
// working without internet.

import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeMode, oflToProfile, type OflFixture, type Profile } from '../../packages/shared/src/index.ts';
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

export class OflClient {
  private readonly dir: string;
  private readonly fetchFn: typeof fetch;
  private manufacturers: Record<string, { name: string }> | null = null;

  constructor(dir: string, fetchFn: typeof fetch = fetch) {
    this.dir = dir;
    this.fetchFn = fetchFn;
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
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

  /** Search by name. Falls back to fixtures already downloaded when offline. */
  async search(query: string): Promise<{ hits: OflSearchHit[]; offline: boolean }> {
    const q = query.trim();
    if (q.length < 2) return { hits: [], offline: false };
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
    return { hits, offline };
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
    let fixture = this.cached(file) as OflFixture | null;
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
