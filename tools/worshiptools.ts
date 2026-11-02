// WorshipTools login shared by tools/worshiptools-*.ts.
//
// WorshipTools has no public API; these scripts make the same calls as their web
// apps. The weAuthRefresh cookie gets a one-hour token from planning.worshiptools.com,
// and that token signs every api.worship.tools request.
//
// Login: sign in at planning.worshiptools.com, open the browser's developer tools >
// Application > Cookies > planning.worshiptools.com and copy the value of
// weAuthRefresh. `node tools/worshiptools-service.ts --login` reads it from the
// keyboard (never from the command line, so it stays out of shell history) and keeps
// it in data/worshiptools-login.json. WORSHIPTOOLS_REFRESH in the environment works too.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const PLANNING = 'https://planning.worshiptools.com';
export const API = 'https://api.worship.tools/v1';
const loginFile = join(fileURLToPath(new URL('../', import.meta.url)), 'data', 'worshiptools-login.json');

export async function saveLogin(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const refresh = (await rl.question('Paste the weAuthRefresh cookie value: ')).trim().replace(/^weAuthRefresh=/, '');
  rl.close();
  if (!refresh) throw new Error('Nothing pasted.');
  writeLogin({ ...readLoginFile(), refresh });
  await getToken(); // proves the cookie works before saying so
  console.log(`Saved to ${loginFile}. Login works.`);
}

function readLoginFile(): { refresh?: string; machineId?: string } {
  return existsSync(loginFile) ? JSON.parse(readFileSync(loginFile, 'utf8')) : {};
}

function writeLogin(login: { refresh?: string; machineId?: string }): void {
  mkdirSync(dirname(loginFile), { recursive: true });
  writeFileSync(loginFile, JSON.stringify(login) + '\n', { mode: 0o600 });
  chmodSync(loginFile, 0o600);
}

/** A stable id for this computer, the way WorshipTools' own apps keep one. */
export function machineId(): string {
  const login = readLoginFile();
  if (login.machineId) return login.machineId;
  login.machineId = Math.random().toString(36).slice(2, 11).toUpperCase();
  writeLogin(login);
  return login.machineId;
}

/** A one-hour api.worship.tools token. Keeps the refresh cookie if the server hands out a new one. */
export async function getToken(): Promise<string> {
  const refresh = process.env.WORSHIPTOOLS_REFRESH || readLoginFile().refresh;
  if (!refresh) throw new Error('Not logged in: run `node tools/worshiptools-service.ts --login` first.');
  const res = await fetch(`${PLANNING}/auth/refresh`, {
    headers: { Cookie: `weAuthRefresh=${refresh}` },
    redirect: 'manual',
  });
  const cookies = Object.fromEntries(
    res.headers.getSetCookie().map((c) => {
      const [pair] = c.split(';');
      const at = pair.indexOf('=');
      return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))];
    }),
  );
  if (cookies.weAuthRefresh && !process.env.WORSHIPTOOLS_REFRESH) {
    writeLogin({ ...readLoginFile(), refresh: cookies.weAuthRefresh });
  }
  if (!cookies.weAuthToken) {
    throw new Error(`WorshipTools refused the login (HTTP ${res.status}). Sign in again in the browser and run --login.`);
  }
  return cookies.weAuthToken;
}

export async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url.split('?')[0]} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

/** api.worship.tools with a token that is renewed shortly before its hour is up. */
export function apiClient() {
  let token: Promise<string> | undefined;
  let expires = 0;
  return async (path: string, init: RequestInit = {}): Promise<any> => {
    if (!token || Date.now() > expires) {
      token = getToken();
      token.catch(() => (token = undefined));
      expires = Date.now() + 50 * 60_000;
    }
    const headers = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await token}` };
    return getJson(API + path, { ...init, headers });
  };
}
