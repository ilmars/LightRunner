import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPicks, diffShows, displayColour, editColour, EffectLayer, parseShow, type Show } from '../src/index.ts';

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

test('hanging a fixture the other way round is described', () => {
  const incoming = rig();
  incoming.fixtures.find((f) => f.id === 'b4')!.reversed = true;
  const item = diffShows(rig(), incoming).find((i) => i.kind === 'fixture' && i.id === 'b4');
  assert.deepEqual(item?.details, ['reversed on']);
  assert.deepEqual(diffShows(incoming, rig()).find((i) => i.id === 'b4')?.details, ['reversed off']);
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

/** The rig with a hazer in a smoke group, as this installation has it. */
function withHaze(kind: 'light' | 'smoke'): Show {
  const show = rig();
  show.fixtures.push({ id: 'hazer', name: 'Hazer', profile: 'generic-dimmer', universe: 1, address: 300, x: 0.5, y: 0.1 });
  show.groups.push({ id: 'haze', name: 'Haze', kind, fixtures: ['hazer'] });
  return parseShow(show);
}

test("an import can't turn a smoke group back into a light group", () => {
  const current = withHaze('smoke');
  // A show file or Lightkey-made show knows nothing of smoke: its groups read as lights.
  const incoming = withHaze('light');
  assert.deepEqual(diffShows(current, incoming), [], 'kind alone is no difference');

  // A real change to the group is still offered, and taking it keeps the group a smoke machine.
  incoming.groups.find((g) => g.id === 'haze')!.name = 'Haze machine';
  const items = diffShows(current, incoming);
  assert.deepEqual(items.map((i) => [i.kind, i.id, i.details]), [['group', 'haze', ['name "Haze" → "Haze machine"']]]);
  const merged = applyPicks(current, incoming, [{ kind: 'group', id: 'haze', change: 'changed' }]);
  const haze = merged.groups.find((g) => g.id === 'haze')!;
  assert.equal(haze.name, 'Haze machine');
  assert.equal(haze.kind, 'smoke');

  // Nor can it turn a light group into a smoke group.
  const smokeFile = withHaze('smoke');
  smokeFile.groups.find((g) => g.id === 'key-lights')!.kind = 'smoke';
  smokeFile.groups.find((g) => g.id === 'key-lights')!.name = 'Keys';
  const kept = applyPicks(current, smokeFile, [{ kind: 'group', id: 'key-lights', change: 'changed' }]);
  assert.equal(kept.groups.find((g) => g.id === 'key-lights')!.kind, 'light');
});

test('a new group from a file keeps the kind the file gives it', () => {
  const current = rig();
  const incoming = withHaze('smoke');
  const merged = applyPicks(current, incoming, [
    { kind: 'fixture', id: 'hazer', change: 'added' },
    { kind: 'group', id: 'haze', change: 'added' },
  ]);
  assert.equal(merged.groups.find((g) => g.id === 'haze')!.kind, 'smoke');
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

test('a changed effect is described as an effect change', () => {
  const layer = (waves: number) => EffectLayer.parse({ kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }], speed: { beats: 4 }, waves });
  const current = rig(), incoming = rig();
  current.presets.push({ id: 'bg-wave', name: 'Wave', group: 'background', fade: 3, layers: [layer(1)] });
  incoming.presets.push({ id: 'bg-wave', name: 'Wave', group: 'background', fade: 3, layers: [layer(3)] });
  const item = diffShows(current, incoming).find((i) => i.id === 'bg-wave');
  assert.deepEqual(item?.details, ['effect changed']);
});

const ZILS = ['key-lights-zils', 'background-zils', 'drum-cage-zils', 'b8-side-bar-zils'];
const swatch = (s: Show, id: string) => s.presets.find((p) => p.id === id)!.swatch;
/** The rig after "Change it everywhere" made Zils (shared colour 8) a deeper blue. */
const deeperBlue = () => editColour(rig(), { preset: 'key-lights-zils', colour: '#103a7c', shared: true, sameName: false }).show;

test('a changed shared colour is listed on its own, and taking it brings the swatches along', () => {
  const current = deeperBlue();
  const items = diffShows(current, rig());
  // One item: the shared colour. The Zils colours only differ by the swatch that follows it.
  assert.deepEqual(items, [{ kind: 'palette', id: 'lightkey', change: 'changed', name: 'Lightkey colours', details: ['colour 8 (Zils) #103a7c → #0000ff'] }]);
  const merged = applyPicks(current, rig(), [{ kind: 'palette', id: 'lightkey', change: 'changed' }]);
  assert.equal(merged.palettes.find((p) => p.id === 'lightkey')!.colours[7]!.hex, '#0000ff');
  for (const id of ZILS) assert.equal(swatch(merged, id), '#0000ff', id);
  assert.deepEqual(diffShows(merged, rig()), []);
  // Patch scope (a Lightkey project) leaves shared colours out.
  assert.deepEqual(diffShows(current, rig(), 'patch'), []);
});

test("a taken preset's swatch agrees with the shared colour it points to here", () => {
  const current = deeperBlue();
  const incoming = rig();
  incoming.presets.find((p) => p.id === 'background-zils')!.fade = 5;
  const item = diffShows(current, incoming).find((i) => i.kind === 'preset' && i.id === 'background-zils');
  assert.deepEqual(item?.details, ['fade 3 s → 5 s']);
  // Taking only the preset keeps this show's deeper blue, and its button shows it.
  const merged = applyPicks(current, incoming, [{ kind: 'preset', id: 'background-zils', change: 'changed' }]);
  assert.equal(merged.presets.find((p) => p.id === 'background-zils')!.fade, 5);
  assert.equal(merged.palettes.find((p) => p.id === 'lightkey')!.colours[7]!.hex, '#103a7c');
  assert.equal(swatch(merged, 'background-zils'), '#103a7c');
  // Taking both gives the file's blue everywhere.
  const both = applyPicks(current, incoming, [
    { kind: 'preset', id: 'background-zils', change: 'changed' },
    { kind: 'palette', id: 'lightkey', change: 'changed' },
  ]);
  for (const id of ZILS) assert.equal(swatch(both, id), '#0000ff', id);
});

test('a swatch that does not follow its colour is still listed', () => {
  const incoming = rig();
  incoming.presets.find((p) => p.id === 'key-lights-zils')!.swatch = '#123456';
  const item = diffShows(rig(), incoming).find((i) => i.id === 'key-lights-zils');
  assert.deepEqual(item?.details, ['button colour #0000ff → #123456']);
});

test('new shared colours are offered, and a preset pointing to them needs them ticked too', () => {
  const current = rig();
  const incoming = rig();
  incoming.palettes.push({ id: 'extra', name: 'Extra colours', colours: [{ hex: '#ff00ff', white: 0.2 }] });
  incoming.presets.push({ id: 'key-lights-roze', name: 'Rozā', group: 'key-lights', fade: 3, swatch: '#ff00ff', layers: [{ kind: 'static', colour: { palette: 'extra', index: 0 }, intensity: 1 }] });
  incoming.palettes.find((p) => p.id === 'lightkey')!.colours[1]!.white = 0.5;
  const items = diffShows(current, incoming);
  assert.deepEqual(items.find((i) => i.id === 'extra'), { kind: 'palette', id: 'extra', change: 'added', name: 'Extra colours', details: [] });
  assert.match(items.find((i) => i.id === 'lightkey')!.details[0]!, /^colour 2 \(.+\) white, amber or UV changed$/);
  assert.throws(() => applyPicks(current, incoming, [{ kind: 'preset', id: 'key-lights-roze', change: 'added' }]), /unknown palette "extra"/);
  const merged = applyPicks(current, incoming, [
    { kind: 'preset', id: 'key-lights-roze', change: 'added' },
    { kind: 'palette', id: 'extra', change: 'added' },
  ]);
  // The swatch is worked out from the shared colour (its white mixed in), as the colour editor does.
  assert.equal(swatch(merged, 'key-lights-roze'), displayColour('#ff00ff', { white: 0.2 }));
});
