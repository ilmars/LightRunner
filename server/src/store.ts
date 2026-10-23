// Show and live-state files. Every write goes to a temp file first and is then
// renamed over the old one, so a crash mid-write never leaves a broken file.
// Each show save keeps a backup; the last 20 are kept.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { parseShow, type RuntimeState, type Show } from '../../packages/shared/src/index.ts';

export const BACKUPS_KEPT = 20;

export interface LoadedShow {
  show: Show;
  /** Where the show came from, for the log. */
  source: 'show' | 'backup' | 'seed';
  problem?: string;
}

export class Store {
  readonly dir: string;
  private readonly seedPath: string;
  /** Keeps backup names unique when two saves land in the same millisecond. */
  private saves = 0;

  constructor(dir: string, seedPath: string) {
    this.dir = dir;
    this.seedPath = seedPath;
    mkdirSync(join(dir, 'backups'), { recursive: true });
  }

  get showPath(): string {
    return join(this.dir, 'show.json');
  }

  get runtimePath(): string {
    return join(this.dir, 'runtime.json');
  }

  /** Load the show; if it is missing or corrupt, fall back to the newest good backup, then the seed. */
  loadShow(): LoadedShow {
    let problem: string | undefined;
    if (existsSync(this.showPath)) {
      try {
        return { show: parseShow(JSON.parse(readFileSync(this.showPath, 'utf8'))), source: 'show' };
      } catch (err) {
        problem = `show.json could not be loaded: ${(err as Error).message}`;
      }
    }
    for (const file of this.backups()) {
      try {
        const show = parseShow(JSON.parse(readFileSync(join(this.dir, 'backups', file), 'utf8')));
        return { show, source: 'backup', problem: problem ?? 'show.json was missing' };
      } catch {
        // try the next one
      }
    }
    const show = parseShow(JSON.parse(readFileSync(this.seedPath, 'utf8')));
    if (!existsSync(this.showPath)) this.saveShow(show);
    return { show, source: 'seed', problem };
  }

  /** Saves the show, first keeping the old one as a backup unless `backup` is false. */
  saveShow(show: Show, { backup = true }: { backup?: boolean } = {}): void {
    parseShow(show);
    if (backup && existsSync(this.showPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const seq = String(this.saves++ % 10000).padStart(4, '0');
      copyFileSync(this.showPath, join(this.dir, 'backups', `show-${stamp}-${seq}.json`));
      for (const old of this.backups().slice(BACKUPS_KEPT)) rmSync(join(this.dir, 'backups', old));
    }
    writeAtomic(this.showPath, JSON.stringify(show, null, 2));
  }

  /** Backup file names, newest first. */
  backups(): string[] {
    return readdirSync(join(this.dir, 'backups'))
      .filter((f) => f.startsWith('show-') && f.endsWith('.json'))
      .sort()
      .reverse();
  }

  loadRuntime(): RuntimeState | null {
    try {
      const rt = JSON.parse(readFileSync(this.runtimePath, 'utf8')) as RuntimeState;
      if (typeof rt.master !== 'number' || typeof rt.groups !== 'object') return null;
      return rt;
    } catch {
      return null;
    }
  }

  saveRuntime(rt: RuntimeState): void {
    writeAtomic(this.runtimePath, JSON.stringify(rt));
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a file atomically (a temporary file, flushed, then renamed over the old one). `mode` is for files only this
 * user may read; `rename` is for tests.
 */
export function writeAtomic(
  path: string,
  text: string,
  { mode, rename = renameSync }: { mode?: number; rename?: (from: string, to: string) => void } = {},
): void {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  // 'r+', not 'r': Windows refuses to flush a file opened read-only (EPERM).
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Windows can refuse a rename for a moment while something (a virus scanner, a backup) has the file open.
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 2 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true });
        throw e;
      }
      pause(100);
    }
  }
}

/** Writes live state at most once per second, always ending with the latest. */
export class RuntimeSaver {
  private pending: RuntimeState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastWrite = 0;
  private readonly store: Store;
  private readonly every: number;

  constructor(store: Store, everyMs = 1000) {
    this.store = store;
    this.every = everyMs;
  }

  save(rt: RuntimeState): void {
    this.pending = rt;
    if (this.timer) return;
    const wait = Math.max(0, this.lastWrite + this.every - Date.now());
    this.timer = setTimeout(() => this.flush(), wait);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    this.store.saveRuntime(this.pending);
    this.pending = null;
    this.lastWrite = Date.now();
  }
}
