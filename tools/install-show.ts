// Make a show file the live show (the old one is kept as a backup).
// Stop the server first; it loads the show when it starts.
//
//   node tools/install-show.ts shows/dieva-majas-l1.json [--data data] [--keep-state]

import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addressProblems, parseShow } from '../packages/shared/src/index.ts';
import { Store } from '../server/src/store.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string', default: join(root, 'data') },
    'keep-state': { type: 'boolean', default: false },
  },
});
if (positionals.length !== 1) {
  console.error('Usage: node tools/install-show.ts SHOW.json [--data DIR] [--keep-state]');
  process.exit(2);
}
const show = parseShow(JSON.parse(readFileSync(resolve(positionals[0]), 'utf8')));
const problems = addressProblems(show);
if (problems.length) console.warn(`Address warnings:\n- ${problems.join('\n- ')}`);
const store = new Store(resolve(values.data!), join(root, 'server/seed/demo-show.json'));
store.saveShow(show);
// The saved live state names the old show's groups and presets, so start clean.
if (!values['keep-state']) rmSync(store.runtimePath, { force: true });
console.log(`Installed "${show.name}": ${show.fixtures.length} fixtures, ${show.looks.length} looks`);
