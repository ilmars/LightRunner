// Programmer PIN: stored hashed in the show, checked with a login that sets a
// session cookie. With no PIN set the settings page is open (first setup).

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

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

export class Sessions {
  private sessions = new Map<string, number>();
  private fails = 0;
  private lockedUntil = 0;

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
    this.sessions.set(token, Date.now() + SESSION_HOURS * 3600_000);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const until = this.sessions.get(token);
    if (!until) return false;
    if (until < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  end(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Log everyone out, e.g. after the PIN changes. */
  clear(): void {
    this.sessions.clear();
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
