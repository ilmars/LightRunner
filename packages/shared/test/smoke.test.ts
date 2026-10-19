import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addSong, ensureRunningOrder, parseShow, saveItem, saveQuickLook, type Show, type Stage } from '../src/index.ts';

const raw = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

/** The stage L1 rig with a hazer on its own channel, in a smoke group "Haze". */
function withHaze(): Show {
  const show = ensureRunningOrder(parseShow(raw('../../../shows/stage-l1.json')));
  show.fixtures.push({ id: 'hazer', name: 'Hazer', profile: 'generic-dimmer', universe: 1, address: 300, x: 0.5, y: 0.1 });
  show.groups.push({ id: 'haze', name: 'Haze', kind: 'smoke', fixtures: ['hazer'] });
  show.presets.push({ id: 'haze-on', name: 'On', group: 'haze', layers: [{ kind: 'static', colour: { hex: '#ffffff' }, intensity: 1 }], fade: 3 });
  return parseShow(show);
}

/** A stage that has the hazer running (as an imported look could leave it) and a light group set. */
function stage(show: Show): Stage {
  const key = show.presets.find((p) => p.group === 'key-lights')!.id;
  return { groups: { 'key-lights': key, haze: 'haze-on' }, levels: { 'key-lights': 0.5, haze: 0.8 } };
}

test('old shows parse with every group as a light', () => {
  for (const path of ['../../../shows/stage-l1.json', '../../../server/seed/demo-show.json']) {
    const file = raw(path);
    assert.ok(file.groups.every((g: { kind?: string }) => g.kind === undefined), 'the file has no kinds');
    assert.ok(parseShow(file).groups.every((g) => g.kind === 'light'));
  }
});

test('a group can be a smoke machine, and nothing else', () => {
  assert.equal(withHaze().groups.find((g) => g.id === 'haze')!.kind, 'smoke');
  const bad = raw('../../../server/seed/demo-show.json');
  bad.groups[0].kind = 'fog';
  assert.throws(() => parseShow(bad));
});

test('Save to an item leaves smoke groups out', () => {
  const show = withHaze();
  const song = show.operator.runningOrder[1]!;
  const out = saveItem(show, song, stage(show));
  const groups = out.looks.find((l) => l.id === song)!.groups.map((e) => e.group);
  assert.deepEqual(groups, ['key-lights']);
});

test('Save to Basic lights leaves smoke groups out', () => {
  const show = withHaze();
  const out = saveItem(show, show.operator.safeLook!, stage(show));
  assert.deepEqual(out.looks.find((l) => l.id === show.operator.safeLook)!.groups.map((e) => e.group), ['key-lights']);
});

test('Add song leaves smoke groups out', () => {
  const show = withHaze();
  const { show: out, id } = addSong(show, show.operator.runningOrder[1]!, stage(show));
  assert.deepEqual(out.looks.find((l) => l.id === id)!.groups.map((e) => e.group), ['key-lights']);
});

test('Save stage as quick look leaves smoke groups out, and needs a light group', () => {
  const show = withHaze();
  const { show: out, id } = saveQuickLook(show, { name: 'Key', tab: 'plain', groups: ['key-lights', 'haze'] }, stage(show));
  assert.deepEqual(out.looks.find((l) => l.id === id)!.groups.map((e) => e.group), ['key-lights']);
  assert.throws(() => saveQuickLook(show, { name: 'Haze', tab: 'plain', groups: ['haze'] }, stage(show)), /pick at least one group/);
});
