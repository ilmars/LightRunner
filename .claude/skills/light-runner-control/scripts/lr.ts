// Talk to a running Light Runner the way its pages do: read its state, send it commands, and save a changed show.
// Nothing here changes code or files of the project; the server checks every request as it checks the pages'.
// Run with Node 24 from the repository:
//
//   node .claude/skills/light-runner-control/scripts/lr.ts [--url http://localhost:8080] <what> ...
//
//   get <path>                  GET /api/<path> and print the JSON (state, layout, looks, show, settings, profiles, ...)
//   post <path> [<json>]        POST /api/<path> (e.g. identify a light, or a fixture type from the Open Fixture Library)
//   send <cmd> [<cmd> ...]      commands on the stage or the show, as the operator page sends them, in order on one
//                               connection; stops at the first one refused. A <cmd> is JSON, e.g. '{"type":"safe"}'.
//   prepare <cmd> [<cmd> ...]   the same, in Prepare: stage commands change only a draft, Save / Add song / Save as
//                               quick look store the draft, and the real lights never change. Ends with Live (the draft
//                               is thrown away) unless --go is given: then the draft fades onto the stage (Go).
//   show-get <file>             the whole show into <file> (and its revision into <file>.rev), for Patch-type changes
//   show-check <file>           checks a changed show file as the server will, and lists every problem (and two
//                               lights on the same channels, unless --overlap-ok)
//   show-put <file>             checks it, then saves it as Patch does; refused if the show changed since show-get
//   free <file> <universe> <n>  the first DMX address in <universe> with <n> free channels in a row, in a show-get file
//
// The programmer PIN (when one is set) is read from the LIGHT_RUNNER_PIN environment variable or from a file named
// by --pin-file; it is never printed and never goes on the command line.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { addressProblems, checkReferences, findProfile, isShowEdit, parseShow, Command } from '../../../../packages/shared/src/index.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    'pin-file': { type: 'string' },
    go: { type: 'boolean', default: false },
    'overlap-ok': { type: 'boolean', default: false },
  },
});
const base = values.url.replace(/\/+$/, '');
const [what, ...rest] = positionals;

let cookie = '';

/** Logs in with the PIN, when one is given; the server answers with a session cookie. */
async function login(): Promise<boolean> {
  const pin = values['pin-file'] ? readFileSync(values['pin-file'], 'utf8').trim() : process.env.LIGHT_RUNNER_PIN?.trim();
  if (!pin) return false;
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  if (!res.ok) throw new Error(`The PIN was refused: ${((await res.json()) as { error?: string }).error ?? res.status}`);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  return true;
}

/** An HTTP call; a 401 logs in once with the PIN and tries again. */
async function call(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
  const send = () => fetch(`${base}${path}`, {
    method, body, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  let res = await send();
  if (res.status === 401 && !cookie && await login()) res = await send();
  if (res.status === 401) throw new Error('This needs the programmer PIN: set LIGHT_RUNNER_PIN (or --pin-file) in your own terminal, never on a command line.');
  return res;
}

async function check(res: Response): Promise<unknown> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `answered ${res.status}`);
  return body;
}

/** Parses each command and checks it against the server's own command list, so a typo is caught before anything is sent. */
function commands(args: string[]): Command[] {
  if (!args.length) throw new Error('Give at least one command, as JSON.');
  return args.map((arg) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(arg);
    } catch {
      throw new Error(`Not JSON: ${arg}`);
    }
    const ok = Command.safeParse(parsed);
    if (!ok.success) throw new Error(`Not a command Light Runner knows: ${arg}\n${ok.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
    return ok.data;
  });
}

/** Sends the commands on one WebSocket, in order, waiting for each answer; stops at the first one refused. */
async function sendAll(list: Command[]): Promise<void> {
  // A session cookie makes this connection the programmer's (only needed with a PIN set and a programmer-only command).
  if (!cookie && (process.env.LIGHT_RUNNER_PIN || values['pin-file'])) await login();
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, cookie ? { headers: { cookie } } : {});
  const answers = new Map<number, (error: string | null) => void>();
  ws.on('message', (data, binary) => {
    if (binary) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // not every message is JSON
    }
    if (msg?.type === 'result') answers.get(msg.ref)?.(msg.error ?? null);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', () => reject(new Error(`Can't reach Light Runner at ${base}.`)));
  });
  try {
    let ref = 0;
    for (const cmd of list) {
      const mine = ++ref;
      const error = await new Promise<string | null>((resolve, reject) => {
        answers.set(mine, resolve);
        setTimeout(() => reject(new Error(`No answer to ${cmd.type} in 30 s.`)), 30_000).unref();
        ws.send(JSON.stringify({ type: 'command', ref: mine, cmd }));
      });
      const shown = cmd.type === 'draft' ? `draft ${cmd.cmd.type}` : cmd.type;
      if (error) throw new Error(`${shown}: refused: ${error}`);
      console.log(`${shown}: ok`);
    }
  } finally {
    ws.close();
  }
}

/**
 * Throws with every problem the show file has: one the server would refuse, or two fixtures on the same channels
 * (allowed only with --overlap-ok, for lights meant to do the same thing).
 */
function checkShow(file: string): ReturnType<typeof parseShow> {
  let show;
  try {
    show = parseShow(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`Not a valid show: ${(err as Error).message}`);
  }
  const problems = [...checkReferences(show), ...(values['overlap-ok'] ? [] : addressProblems(show))];
  // The operator page shows only the groups its own list names, once that list has any in it.
  const listed = new Set(show.operator.groups);
  if (listed.size) for (const g of show.groups) if (!listed.has(g.id)) problems.push(`group "${g.id}" is not on the operator page: add it to operator.groups`);
  if (problems.length) throw new Error(`Problems (nothing was saved):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return show;
}

try {
  switch (what) {
    case 'get': {
      const path = (rest[0] ?? '').replace(/^\/?(api\/)?/, '');
      if (!path) throw new Error('get what? e.g. get layout');
      console.log(JSON.stringify(await check(await call('GET', `/api/${path}`)), null, 2));
      break;
    }
    case 'post': {
      const path = (rest[0] ?? '').replace(/^\/?(api\/)?/, '');
      if (!path) throw new Error('post what? e.g. post identify {"fixture":"p1"}');
      if (rest[1] !== undefined) JSON.parse(rest[1]);
      console.log(JSON.stringify(await check(await call('POST', `/api/${path}`, rest[1] ?? '{}')), null, 2));
      break;
    }
    case 'free': {
      const [file, universe, count] = rest;
      if (!file || universe === undefined || count === undefined) throw new Error('free <file> <universe> <channels>');
      const show = parseShow(JSON.parse(readFileSync(file, 'utf8')));
      const used = new Set<number>();
      for (const fx of show.fixtures) {
        if (fx.universe !== Number(universe)) continue;
        const n = findProfile(show, fx.profile)?.channels.length ?? 1;
        for (let c = fx.address; c < fx.address + n; c++) used.add(c);
      }
      const need = Number(count);
      let start = 1;
      for (let c = 1; c <= 512 && c - start + 1 < need; c++) if (used.has(c)) start = c + 1;
      while (start + need - 1 <= 512 && [...Array(need).keys()].some((k) => used.has(start + k))) start++;
      if (start + need - 1 > 512) throw new Error(`Universe ${universe} has no ${need} free channels in a row.`);
      console.log(start);
      break;
    }
    case 'send':
      await sendAll(commands(rest));
      break;
    case 'prepare': {
      // Stage commands go to the draft; show edits (Save, Add song, Save as quick look, ...) store the draft.
      const list = commands(rest).map((cmd): Command => (isShowEdit(cmd) || cmd.type.startsWith('blind') || cmd.type === 'draft' ? cmd : { type: 'draft', cmd } as Command));
      await sendAll([{ type: 'blindStart' }, ...list, { type: values.go ? 'blindGo' : 'blindEnd' }]);
      break;
    }
    case 'show-get': {
      const file = rest[0];
      if (!file) throw new Error('show-get <file>');
      const res = await call('GET', '/api/show');
      const show = await check(res);
      writeFileSync(file, JSON.stringify(show, null, 2) + '\n');
      writeFileSync(`${file}.rev`, res.headers.get('x-show-revision') ?? '');
      console.log(`Saved the show to ${file}. Change it, then show-check and show-put it.`);
      break;
    }
    case 'show-check': {
      const file = rest[0];
      if (!file) throw new Error('show-check <file>');
      checkShow(file);
      console.log('The show is fine.');
      break;
    }
    case 'show-put': {
      const file = rest[0];
      if (!file) throw new Error('show-put <file>');
      checkShow(file);
      const revision = readFileSync(`${file}.rev`, 'utf8').trim();
      const res = await call('PUT', '/api/show?source=patch', readFileSync(file, 'utf8'), { 'x-show-revision': revision });
      await check(res);
      writeFileSync(`${file}.rev`, res.headers.get('x-show-revision') ?? '');
      console.log('Saved. The pages show the new patch now.');
      break;
    }
    default:
      throw new Error('What? get, post, send, prepare, show-get, show-check, show-put or free (see the top of this file).');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
