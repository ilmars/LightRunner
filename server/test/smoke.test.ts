import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseShow, type Show } from '../../packages/shared/src/index.ts';
import { operatorLayout } from '../src/layout.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** The demo show with a hazer in a smoke group "Haze", and a look that (as an import might) lists it. */
export function hazeShow(): Show {
  const show = parseShow(JSON.parse(readFileSync(join(root, 'server/seed/demo-show.json'), 'utf8')));
  show.fixtures.push({ id: 'hazer', name: 'Hazer', profile: 'generic-dimmer', universe: 0, address: 60, x: 0.5, y: 0.1 });
  show.groups.push({ id: 'haze', name: 'Haze', kind: 'smoke', fixtures: ['hazer'] });
  show.operator.groups.push('haze');
  show.presets.push({ id: 'haze-on', name: 'On', group: 'haze', swatch: '#ffffff', layers: [{ kind: 'static', colour: { hex: '#ffffff' }, intensity: 1 }], fade: 3 });
  show.looks.find((l) => l.id === 'worship')!.groups.push({ group: 'haze', preset: 'haze-on', level: 1 });
  return parseShow(show);
}

test('the operator layout says which groups are smoke, and looks give them no colour', () => {
  const show = hazeShow();
  const layout = operatorLayout(show, show.fixtures.map((f) => f.id));
  assert.deepEqual(layout.groups.map((g) => [g.id, g.kind]), [
    ['front-wash', 'light'], ['back-wall', 'light'], ['audience', 'light'], ['pulpit', 'light'], ['haze', 'smoke'],
  ]);
  const worship = layout.looks.find((l) => l.id === 'worship')!;
  assert.equal(worship.colours[4], null);
  assert.equal(worship.levels[4], null);
});
