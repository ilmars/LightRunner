// Recordings for the Timeline page: kept in `<data>/recordings/`, streamed in and streamed out (a recording can be
// 100 MB, so nothing here reads a whole file into memory). The browser that presses Start plays the file; the
// server never decodes or plays it.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeAtomic } from './store.ts';

export const RECORDING_LIMIT = 100 * 1024 * 1024;

/** The kinds Light Runner keeps, by extension. */
const TYPES: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav' };
/** What a browser may call them, when the name has no usable extension. */
const BY_CONTENT_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
  'audio/aac': 'aac', 'audio/x-aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
};
/** A recording's id is 16 hex digits (ids in the show have no dots); its file is `<id>.<ext>`. */
const ID = /^[0-9a-f]{16}$/;
const FILE = /^([0-9a-f]{16})\.(mp3|m4a|aac|wav)$/;

export class RecordingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RecordingInfo {
  id: string;
  name: string;
  size: number;
}

export class Recordings {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly limit: number;

  constructor(dataDir: string, limit = RECORDING_LIMIT) {
    this.dir = join(dataDir, 'recordings');
    this.indexPath = join(this.dir, 'index.json');
    this.limit = limit;
  }

  /** Removes the half-written files an upload left when the server stopped in the middle of it. */
  tidy(): void {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) if (f.endsWith('.upload') || f.endsWith('.tmp')) rmSync(join(this.dir, f), { force: true });
  }

  list(): RecordingInfo[] {
    if (!existsSync(this.dir)) return [];
    const names = this.names();
    const out: RecordingInfo[] = [];
    for (const file of readdirSync(this.dir)) {
      const id = FILE.exec(file)?.[1];
      if (!id) continue;
      try {
        out.push({ id, name: names[id] ?? file, size: statSync(join(this.dir, file)).size });
      } catch {
        // removed while listing
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** Streams the request body into the folder. Over the limit, or anything but audio: refused, nothing kept. */
  async add(req: IncomingMessage, rawName: string): Promise<RecordingInfo> {
    const name = cleanName(rawName);
    const ext = extensionFor(name, String(req.headers['content-type'] ?? ''));
    if (!ext) throw new RecordingError(415, 'Light Runner plays mp3, m4a, aac or wav recordings.');
    mkdirSync(this.dir, { recursive: true });
    const id = randomBytes(8).toString('hex');
    const file = `${id}.${ext}`;
    const tmp = join(this.dir, `${file}.upload`);
    const out = createWriteStream(tmp);
    // Without a listener a write error (disk full) would take the server down; the loop below sees it too.
    out.on('error', () => {});
    let size = 0;
    let over = false;
    try {
      // An upload that is too big is read to its end and thrown away rather than cut off, so the page hears 413
      // and not a dropped connection.
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > this.limit) {
          over = true;
          continue;
        }
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await finished(out);
    } catch (err) {
      out.destroy();
      rmSync(tmp, { force: true });
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') throw new RecordingError(507, 'The Mac has no room left for this recording.');
      throw err;
    }
    if (over) {
      rmSync(tmp, { force: true });
      throw new RecordingError(413, `That recording is too big. Light Runner keeps recordings up to ${megabytes(this.limit)}.`);
    }
    if (size === 0) {
      rmSync(tmp, { force: true });
      throw new RecordingError(400, 'That file is empty.');
    }
    renameSync(tmp, join(this.dir, file));
    const names = this.names();
    names[id] = name;
    this.saveNames(names);
    return { id, name, size };
  }

  /** Removes a recording; `inUse` is the check that no timeline still plays it. */
  remove(id: string, inUse: (id: string) => boolean): void {
    const file = this.fileOf(id);
    if (!file) throw new RecordingError(404, 'There is no such recording.');
    if (inUse(id)) throw new RecordingError(409, 'A timeline still uses this recording. Take it off the timeline first.');
    rmSync(file, { force: true });
    const names = this.names();
    if (id in names) {
      delete names[id];
      this.saveNames(names);
    }
  }

  /** Sends the file, all of it or the part a Range header asks for, straight from disk. */
  async send(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const file = this.fileOf(id);
    if (!file) throw new RecordingError(404, 'There is no such recording.');
    const size = statSync(file).size;
    const headers: Record<string, string | number> = {
      'content-type': TYPES[extname(file).slice(1)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-cache',
    };
    let start = 0;
    let end = size - 1;
    const asked = req.headers.range;
    if (asked !== undefined) {
      const range = parseRange(asked, size);
      if (!range) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 }).end();
        return;
      }
      [start, end] = range;
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    } else {
      res.writeHead(200, { ...headers, 'content-length': size });
    }
    try {
      await pipeline(createReadStream(file, { start, end }), res);
    } catch {
      // The player went away (a seek, a closed page): nothing to report.
      res.destroy();
    }
  }

  /** The path of a recording we hold, or null for any id that is not one of ours (never a path from the request). */
  private fileOf(id: string): string | null {
    if (!ID.test(id) || !existsSync(this.dir)) return null;
    const file = readdirSync(this.dir).find((f) => FILE.exec(f)?.[1] === id);
    return file ? join(this.dir, file) : null;
  }

  private names(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveNames(names: Record<string, string>): void {
    writeAtomic(this.indexPath, JSON.stringify(names, null, 2));
  }
}

/** The file name as the person knows it: no folders, no stray control characters, not endless. */
function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const name = basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name || 'Recording';
}

/** mp3, m4a, aac or wav: from the name's ending, else from the type the browser sent. */
function extensionFor(name: string, contentType: string): string | null {
  const ext = extname(name).slice(1).toLowerCase();
  if (TYPES[ext]) return ext;
  // A name with some other ending (.txt, .mp4) is not audio we know, whatever type was claimed.
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) return null;
  return BY_CONTENT_TYPE[contentType.split(';')[0]!.trim().toLowerCase()] ?? null;
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n`, cut to the file; null when it cannot be met (one range only). */
export function parseRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
  return [start, end];
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
