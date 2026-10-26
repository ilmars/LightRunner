// Recordings for the Timeline page: kept in `<data>/recordings/`, streamed in and streamed out (a recording can be
// 100 MB, so nothing here reads a whole file into memory). The browser that presses Start plays the file; the
// server never decodes or plays it.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeAtomic } from './store.ts';

export const RECORDING_LIMIT = 100 * 1024 * 1024;
/** All the recordings together. */
export const RECORDINGS_TOTAL = 1024 * 1024 * 1024;

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
  /** The answer is sent with `Connection: close` and the request dropped: the rest of the body is not wanted. */
  readonly close: boolean;
  constructor(status: number, message: string, close = false) {
    super(message);
    this.status = status;
    this.close = close;
  }
}

/** The client went away in the middle of an upload: nobody is left to answer. */
export class UploadAborted extends Error {
  constructor() {
    super('the upload was cut off');
  }
}

export interface RecordingsOptions {
  /** The most one recording may be (bytes). */
  limit?: number;
  /** The most all recordings may be (bytes). */
  total?: number;
  /** Where an upload is written; tests pass one that fails. */
  writer?: (path: string) => Writable;
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
  private readonly total: number;
  private readonly writer: (path: string) => Writable;

  constructor(dataDir: string, opts: RecordingsOptions = {}) {
    this.dir = join(dataDir, 'recordings');
    this.indexPath = join(this.dir, 'index.json');
    this.limit = opts.limit ?? RECORDING_LIMIT;
    this.total = opts.total ?? RECORDINGS_TOTAL;
    this.writer = opts.writer ?? ((path) => createWriteStream(path));
  }

  /** What the folder holds now: recordings and uploads still coming in (so uploads at the same time count). */
  private used(): number {
    if (!existsSync(this.dir)) return 0;
    let sum = 0;
    for (const f of readdirSync(this.dir)) {
      if (!FILE.test(f) && !f.endsWith('.upload')) continue;
      try {
        sum += statSync(join(this.dir, f)).size;
      } catch {
        // removed while counting
      }
    }
    return sum;
  }

  private tooBig(why: 'file' | 'total', close: boolean): RecordingError {
    return new RecordingError(413, why === 'file'
      ? `That recording is too big. Light Runner keeps recordings up to ${megabytes(this.limit)}.`
      : `Recordings take more than ${megabytes(this.total)} on the Mac: delete one first.`, close);
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
    const existing = this.used();
    // What the page says it is sending is checked first: a file that is too big is refused before any of it comes.
    const declared = req.headers['content-length'] === undefined ? NaN : Number(req.headers['content-length']);
    if (declared > this.limit) throw this.tooBig('file', true);
    if (declared + existing > this.total) throw this.tooBig('total', true);
    // What may still come in: the per-file limit, or what is left of the total, whichever is less.
    const room = Math.min(this.limit, this.total - existing);
    mkdirSync(this.dir, { recursive: true });
    const id = randomBytes(8).toString('hex');
    const file = `${id}.${ext}`;
    const tmp = join(this.dir, `${file}.upload`);
    const out = this.writer(tmp);
    let writeError = null as Error | null;
    // The pipeline hands its own failures (too big, client gone) on to the file as well; only the file's are write errors.
    out.on('error', (err) => {
      if (!(err instanceof RecordingError) && !(err instanceof UploadAborted)) writeError ??= err;
    });

    let size = 0;
    let over: 'file' | 'total' | null = null;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        size += chunk.length;
        if (size <= room) return done(null, chunk);
        over ??= room < this.limit ? 'total' : 'file';
        // Up to twice the limit it is read and thrown away, so the page hears 413 and not a dropped connection;
        // past that, the connection is closed on it.
        return size > this.limit * 2 ? done(this.tooBig(over, true)) : done();
      },
    });
    // The request is piped by hand: a failed `pipeline` would destroy it, and with it the connection the answer needs.
    const gone = () => counter.destroy(new UploadAborted());
    const onClose = () => { if (!req.complete) gone(); };
    req.on('error', gone);
    req.once('close', onClose);
    req.pipe(counter);
    try {
      await pipeline(counter, out);
    } catch (err) {
      req.unpipe(counter);
      await discard(out, tmp);
      if (writeError && err === writeError) {
        const full = ['ENOSPC', 'EDQUOT'].includes((writeError as NodeJS.ErrnoException).code ?? '');
        throw new RecordingError(507, full ? "The Mac's disk is full: delete something and try again." : 'The Mac could not save the recording.');
      }
      throw err;
    } finally {
      req.off('close', onClose);
    }
    if (over) {
      await discard(out, tmp);
      throw this.tooBig(over, false);
    }
    if (size === 0) {
      await discard(out, tmp);
      throw new RecordingError(400, 'That file is empty.');
    }
    // Two uploads at once could both have fitted when they began.
    if (this.used() > this.total) {
      await discard(out, tmp);
      throw this.tooBig('total', false);
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
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      // Deleted a moment ago.
      throw new RecordingError(404, 'There is no such recording.');
    }
    const etag = `"${id}"`;
    const headers: Record<string, string | number> = {
      'content-type': TYPES[extname(file).slice(1)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-cache',
      etag,
    };
    if (req.headers.range === undefined && req.headers['if-none-match']?.split(',').some((t) => t.trim() === etag)) {
      res.writeHead(304, headers).end();
      return;
    }
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

/** Closes the upload's file (Windows won't remove an open one) and removes it. */
async function discard(out: Writable, path: string): Promise<void> {
  out.destroy();
  if (!out.closed) await once(out, 'close').catch(() => {});
  rmSync(path, { force: true, maxRetries: 5, retryDelay: 20 });
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
  if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10} GB`;
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
