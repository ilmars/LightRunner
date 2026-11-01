// Programmer PIN: stored hashed in the show, checked with a login that sets a
// session cookie. With no PIN set the settings page is open (first setup).
// Sessions are kept in the data folder (sessions.json, hashes only) so a restart keeps them.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { writeAtomic } from './store.ts';

const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCKOUT_MS = 30_000;
export const COOKIE = 'lr_session';

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(pin, salt, 32).toString('base64')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(pin, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** What Sessions keep of each one: a hash of its token, when it ends, and which PIN it was made under. */
interface Kept {
  until: number;
  pin: string;
}

export interface SessionsOptions {
  /**
   * The file they are kept in (in the data folder), so a restart doesn't log anyone out. It holds a hash of each
   * token, never the token, and is readable only by its user where the system allows. Without it they live in memory.
   */
  file?: string;
  /** The PIN hash now: a session made under another PIN (it changed, however) is over. */
  pin?: () => string | undefined;
  now?: () => number;
}

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

export class Sessions {
  /** By the hash of each token. */
  private sessions = new Map<string, Kept>();
  private fails = 0;
  private lockedUntil = 0;
  private readonly opts: SessionsOptions;

  constructor(opts: SessionsOptions = {}) {
    this.opts = opts;
    this.load();
  }

  /** Check a PIN; returns a session token, or an error message. */
  login(pin: string, stored: string | undefined): { token: string } | { error: string } {
    if (Date.now() < this.lockedUntil) return { error: 'too many wrong PINs; wait 30 seconds' };
    if (stored && !verifyPin(pin, stored)) {
      if (++this.fails >= MAX_FAILS) {
        this.fails = 0;
        this.lockedUntil = Date.now() + LOCKOUT_MS;
      }
      return { error: 'wrong PIN' };
    }
    this.fails = 0;
    return { token: this.create() };
  }

  create(): string {
    const token = randomBytes(24).toString('base64url');
    this.prune();
    this.sessions.set(hashOf(token), { until: this.now() + SESSION_HOURS * 3600_000, pin: this.pinNow() });
    this.save();
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const key = hashOf(token);
    const kept = this.sessions.get(key);
    if (!kept) return false;
    if (kept.until < this.now() || kept.pin !== this.pinNow()) {
      this.sessions.delete(key);
      this.save();
      return false;
    }
    return true;
  }

  end(token: string | undefined): void {
    if (token && this.sessions.delete(hashOf(token))) this.save();
  }

  /** Log everyone out, e.g. after the PIN changes. */
  clear(): void {
    this.sessions.clear();
    this.save();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Which PIN is set now, as a hash of its (salted) hash: the file never holds the PIN hash itself. */
  private pinNow(): string {
    return hashOf(this.opts.pin?.() ?? '');
  }

  /** Sessions that are over go, so the file never grows. */
  private prune(): void {
    const now = this.now();
    for (const [key, kept] of this.sessions) if (kept.until < now) this.sessions.delete(key);
  }

  private load(): void {
    if (!this.opts.file || !existsSync(this.opts.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.opts.file, 'utf8')) as { sessions?: unknown };
      const now = this.now();
      for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
        const { hash, until, pin } = (s ?? {}) as Record<string, unknown>;
        if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && typeof until === 'number' && until >= now && typeof pin === 'string') {
          this.sessions.set(hash, { until: Math.min(until, now + SESSION_HOURS * 3600_000), pin });
        }
      }
    } catch {
      // A file that can't be read: nobody is logged in (they enter the PIN again).
    }
  }

  private save(): void {
    if (!this.opts.file) return;
    const sessions = [...this.sessions].map(([hash, kept]) => ({ hash, until: kept.until, pin: kept.pin }));
    try {
      writeAtomic(this.opts.file, JSON.stringify({ sessions }), { mode: 0o600 });
    } catch {
      // Not written (a full disk, a locked file): the sessions still work until the next restart.
    }
  }
}

export function sessionToken(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

export function clearedCookie(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
