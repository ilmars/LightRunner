import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPicks, diffShows, parseShow, type Show } from '../src/index.ts';

const rig = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));

test('an identical show has no differences', () => {
  assert.deepEqual(diffShows(rig(), rig()), []);
});

test('new, changed and removed items are found and described', () => {
  const current = rig();
  const incoming = rig();
  incoming.fixtures.find((f) => f.id === 'b3')!.address = 300;
  incoming.fixtures.push({ id: 'b9', name: 'B9 bar', profile: 'generic-rgb', universe: 1, address: 400, x: 0.5, y: 0.5 });
  incoming.fixtures = incoming.fixtures.filter((f) => f.id !== 'b8');
  incoming.groups.find((g) => g.id === 'background')!.fixtures.push('b9');
  incoming.groups = incoming.groups.filter((g) => g.id !== 'b8-side-bar');
  incoming.presets = incoming.presets.filter((p) => p.group !== 'b8-side-bar');
  for (const l of incoming.looks) l.groups = l.groups.filter((e) => e.group !== 'b8-side-bar');
  incoming.operator.groups = incoming.operator.groups.filter((g) => g !== 'b8-side-bar');

  const items = diffShows(current, incoming);
  const find = (kind: string, id: string) => items.find((i) => i.kind === kind && i.id === id);
  assert.equal(find('fixture', 'b9')?.change, 'added');
  assert.deepEqual(find('fixture', 'b3')?.details, ['address 1/48 → 1/300']);
  assert.equal(find('fixture', 'b8')?.change, 'removed');
  assert.deepEqual(find('group', 'background')?.details, ['adds B9 bar']);
  assert.equal(find('group', 'b8-side-bar')?.change, 'removed');
  assert.equal(find('look', 'worship')?.change, 'changed');

  // Patch scope: fixture types and fixtures only.
  assert.ok(diffShows(current, incoming, 'patch').every((i) => i.kind === 'profile' || i.kind === 'fixture'));
});

test('only picked changes are applied, and removals take their dependants', () => {
  const current = rig();
  const incoming = rig();
  incoming.fixtures.find((f) => f.id === 'b3')!.address = 300;
  incoming.fixtures.find((f) => f.id === 'b4')!.address = 340;
  incoming.fixtures = incoming.fixtures.filter((f) => f.id !== 'l1');

  const merged = applyPicks(current, incoming, [
    { kind: 'fixture', id: 'b3', change: 'changed' },
    { kind: 'fixture', id: 'l1', change: 'removed' },
  ]);
  assert.equal(merged.fixtures.find((f) => f.id === 'b3')!.address, 300);
  assert.equal(merged.fixtures.find((f) => f.id === 'b4')!.address, 87); // not picked
  assert.ok(!merged.fixtures.some((f) => f.id === 'l1'));
  assert.deepEqual(merged.groups.find((g) => g.id === 'drum-cage')!.fixtures, []);
  assert.equal(merged.settings.output.kind, current.settings.output.kind);
});

test('a pick that leaves the show broken is refused with a readable reason', () => {
  const current = rig();
  const incoming = rig();
  incoming.groups.push({ id: 'balcony', name: 'Balcony', kind: 'light', fixtures: ['b9'] });
  incoming.fixtures.push({ id: 'b9', name: 'B9', profile: 'generic-rgb', universe: 1, address: 400, x: 0.5, y: 0.5 });
  assert.throws(
    () => applyPicks(current, incoming, [{ kind: 'group', id: 'balcony', change: 'added' }]),
    /don't fit together: group "balcony" lists unknown fixture "b9"\. Tick what they depend on too/,
  );
  const ok = applyPicks(current, incoming, [
    { kind: 'group', id: 'balcony', change: 'added' },
    { kind: 'fixture', id: 'b9', change: 'added' },
  ]);
  assert.ok(ok.operator.groups.includes('balcony'));
});
