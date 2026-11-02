// The planning service from the command line: the same client the server uses (server/src/planning/client.ts).
//
//   node tools/planning-service.ts --login                  # once: paste the weAuthRefresh cookie
//   node tools/planning-service.ts --list                   # the coming services of the first service type
//   node tools/planning-service.ts SERVICE_URL [--json]     # one service's items
//
// The login is kept in planning-login.json in the data folder (LIGHT_RUNNER_DATA, default ./data). The older
// tools/worshiptools-*.ts scripts keep theirs in data/worshiptools-login.json with the same { refresh, machineId }
// shape, so that file can simply be copied to data/planning-login.json.
//
// --login reads the cookie from the keyboard (never from the command line, so it stays out of shell history).
// To get it: sign in at planning.worshiptools.com, open the browser's developer tools > Application > Cookies >
// planning.worshiptools.com and copy the value of weAuthRefresh. The cookie is never printed.

import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PlanningClient, PlanningError } from '../server/src/planning/client.ts';
import type { PlannedService } from '../packages/shared/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const loginFile = resolve(process.env.LIGHT_RUNNER_DATA ?? resolve(root, 'data'), 'planning-login.json');
const client = new PlanningClient({ loginFile, log: (line) => console.log(line) });

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    login: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const ids = /\/account\/([0-9a-f-]{36})\/service\/([0-9a-f-]{36})/.exec(positionals[0] ?? '');

if (!values.login && !values.list && !ids) {
  console.error('Usage: node tools/planning-service.ts SERVICE_URL [--json]');
  console.error('       node tools/planning-service.ts --list');
  console.error('       node tools/planning-service.ts --login');
  process.exit(2);
}

try {
  if (values.login) {
    await login();
  } else if (!client.loggedIn()) {
    throw new PlanningError('Not logged in: run `node tools/planning-service.ts --login` first.');
  } else if (values.list) {
    await list();
  } else if (ids) {
    const service = await client.service(ids[1]!, ids[2]!);
    if (values.json) console.log(JSON.stringify(service, null, 2));
    else printService(service);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

async function login(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const cookie = await rl.question('Paste the weAuthRefresh cookie value: ');
  rl.close();
  await client.setLogin(cookie); // proves the cookie works before saving it
  console.log(`Saved to ${loginFile}. Login works.`);
}

async function list(): Promise<void> {
  const [account] = await client.accounts();
  if (!account) throw new PlanningError('No planning account was found for this login.');
  const [type] = await client.serviceTypes(account.id);
  if (!type) throw new PlanningError('That account has no service types.');
  console.log([account.name, type.name].filter(Boolean).join(' - '));
  const services = await client.services(account.id, type.id, new Date());
  if (!services.length) console.log('No services found.');
  for (const s of services) {
    console.log(`${s.start.replace('T', ' ')}  ${s.items} items, ${s.songs} songs`);
    console.log(`   https://planning.worshiptools.com/account/${account.id}/service/${s.id}`);
  }
}

function printService(s: PlannedService): void {
  console.log(s.title);
  if (s.start) console.log(s.start.replace('T', ' '));
  console.log();
  for (const item of s.items) {
    if (item.kind === 'header') {
      console.log(`== ${item.name}`);
      continue;
    }
    const extra = [item.kind !== 'song' && item.kind !== 'other' && item.kind, item.tempo && `${item.tempo} bpm`].filter(Boolean);
    console.log(`   ${item.name}${extra.length ? `  (${extra.join(', ')})` : ''}`);
  }
}
