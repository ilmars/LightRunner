import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPicks, diffShows, displayColour, editColour, EffectLayer, parseShow, type Show } from '../src/index.ts';

const rig = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));

test('an identical show has no differences', () => {
  assert.deepEqual(diffShows(rig(), rig()), []);
});

test('the order of the fields in an item makes no difference: a song with a tempo, saved in the order it was made, is the same song', () => {
  const current = rig();
  const song = current.looks.find((l) => l.id === 'worship')!;
  // As addSong builds a look: tempo added after groups. A parsed show has the schema's order (tempo before groups).
  const made = { id: song.id, name: song.name, groups: song.groups, tempo: 96 } as typeof song;
  current.looks = current.looks.map((l) => (l.id === song.id ? made : l));
  const incoming = parseShow(JSON.parse(JSON.stringify(current)));
  assert.notEqual(JSON.stringify(incoming.looks.find((l) => l.id === song.id)), JSON.stringify(made), 'the two differ only in key order');
  assert.deepEqual(diffShows(current, incoming), []);
  incoming.looks.find((l) => l.id === song.id)!.tempo = 100;
  assert.equal(diffShows(current, incoming).find((i) => i.id === song.id)?.change, 'changed');
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

test('a shape set up here is kept when the file has none (a Lightkey project)', () => {
  const current = rig();
  const cage = current.fixtures.find((f) => f.id === 'l1')!;
  Object.assign(cage, { shape: 'outline', w: 0.12, h: 0.2 });
  const front = current.fixtures.find((f) => f.id === 'p1')!;
  Object.assign(front, { shape: 'beam', angle: -90, reach: 0.15 });
  // The file knows nothing of shapes: L1 is still the line Lightkey draws, and P1 moved.
  const incoming = rig();
  incoming.fixtures.find((f) => f.id === 'p1')!.address = 200;
  const items = diffShows(current, incoming);
  assert.equal(items.find((i) => i.id === 'l1'), undefined, 'no change is reported for the cage');
  assert.deepEqual(items.find((i) => i.id === 'p1')?.details, ['address 1/1 → 1/200']);
  // Taking P1 and L1 keeps their shapes, and the outline keeps its size.
  const out = applyPicks(current, incoming, [
    { kind: 'fixture', id: 'p1', change: 'changed' },
    { kind: 'fixture', id: 'l1', change: 'changed' },
  ]);
  const p1 = out.fixtures.find((f) => f.id === 'p1')!;
  assert.deepEqual([p1.address, p1.shape, p1.angle, p1.reach], [200, 'beam', -90, 0.15]);
  const l1 = out.fixtures.find((f) => f.id === 'l1')!;
  assert.deepEqual([l1.shape, l1.w, l1.h], ['outline', 0.12, 0.2]);
});

test('a file that has shapes is compared and taken as usual', () => {
  const current = rig();
  const incoming = rig();
  Object.assign(incoming.fixtures.find((f) => f.id === 'b8')!, { shape: 'bar', angle: 30 });
  const item = diffShows(current, incoming).find((i) => i.id === 'b8');
  assert.deepEqual(item?.details, ['changed on the stage plan']);
  const out = applyPicks(current, incoming, [{ kind: 'fixture', id: 'b8', change: 'changed' }]);
  assert.equal(out.fixtures.find((f) => f.id === 'b8')!.angle, 30);
});

test('hidden colours (Custom, and the copies Prepare keeps) are left out of the compare; a taken look brings its own', () => {
  const hidden = (id: string, hex: string) => ({ id, name: 'Zils', group: 'key-lights', custom: true, fade: 3, layers: [{ kind: 'static' as const, colour: { hex }, intensity: 1 }] });
  const current = rig();
  current.presets.push(hidden('key-lights-zils-kept', '#0000ff'), hidden('custom-1', '#123456'));
  // The file (a Lightkey project, or an older export) has neither: nothing to list.
  assert.deepEqual(diffShows(current, rig()), []);
  // A file whose look uses a hidden colour of its own: the look is listed, the hidden colour is not, and taking the look brings it.
  const incoming = rig();
  incoming.presets.push(hidden('custom-9', '#00ff00'));
  incoming.looks.find((l) => l.id === 'worship')!.groups.find((e) => e.group === 'key-lights')!.preset = 'custom-9';
  const items = diffShows(rig(), incoming);
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}:${i.change}`), ['look:worship:changed']);
  const taken = applyPicks(rig(), incoming, [{ kind: 'look', id: 'worship', change: 'changed' }]);
  assert.equal(taken.presets.find((p) => p.id === 'custom-9')?.layers[0]?.kind, 'static');
  // A hidden colour here with the same id but another light stays as it is; the taken look gets its own copy.
  const mine = rig();
  mine.presets.push(hidden('custom-9', '#ff0000'));
  const both = applyPicks(mine, incoming, [{ kind: 'look', id: 'worship', change: 'changed' }]);
  assert.deepEqual(both.presets.find((p) => p.id === 'custom-9')!.layers, hidden('custom-9', '#ff0000').layers);
  const used = both.looks.find((l) => l.id === 'worship')!.groups.find((e) => e.group === 'key-lights')!.preset;
  assert.notEqual(used, 'custom-9');
  assert.deepEqual(both.presets.find((p) => p.id === used)!.layers, hidden('custom-9', '#00ff00').layers);
});

test('timelines are compared and taken like the other items, and removing what they point to leaves them alone', () => {
  const current = rig();
  const incoming = rig();
  const tl = (name: string, level = 1) => ({
    id: 'sunday', name, markers: [], offsetMs: 0,
    layers: [{ group: 'front-lights', blocks: [{ id: 'a', start: 0, rise: 2, what: { kind: 'level' as const, level } }] }],
  });
  assert.deepEqual(diffShows(current, incoming), []);
  incoming.timelines = [tl('Sunday')];
  let items = diffShows(current, incoming);
  assert.deepEqual(items, [{ kind: 'timeline', id: 'sunday', change: 'added', name: 'Sunday', details: [] }]);
  const taken = applyPicks(current, incoming, [{ kind: 'timeline', id: 'sunday', change: 'added' }]);
  assert.deepEqual(taken.timelines, incoming.timelines);
  assert.deepEqual(diffShows(taken, incoming), []);

  current.timelines = [tl('Sunday')];
  incoming.timelines = [tl('Sunday morning', 0.5)];
  items = diffShows(current, incoming);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.change, 'changed');
  assert.deepEqual(items[0]!.details, ['name "Sunday" → "Sunday morning"', 'blocks or layers changed']);
  assert.equal(applyPicks(current, incoming, [{ kind: 'timeline', id: 'sunday', change: 'changed' }]).timelines[0]!.name, 'Sunday morning');
  // Same name, other blocks; and markers and the offset on their own.
  incoming.timelines = [tl('Sunday', 0.5)];
  assert.deepEqual(diffShows(current, incoming)[0]!.details, ['blocks or layers changed']);
  incoming.timelines = [{ ...tl('Sunday'), offsetMs: 80, markers: [{ t: 3, text: 'Hi' }] }];
  assert.deepEqual(diffShows(current, incoming)[0]!.details, ['markers changed', 'lights earlier or later changed']);

  incoming.timelines = [];
  assert.deepEqual(diffShows(current, incoming), [{ kind: 'timeline', id: 'sunday', change: 'removed', name: 'Sunday', details: [] }]);
  assert.deepEqual(applyPicks(current, incoming, [{ kind: 'timeline', id: 'sunday', change: 'removed' }]).timelines, []);

  // Removing the group, a preset or a look a timeline uses does not touch the timeline.
  const withTl = rig();
  withTl.timelines = [{ ...tl('Sunday'), layers: [{ group: 'front-lights', blocks: [{ id: 'a', start: 0, rise: 0, what: { kind: 'colour', preset: 'front-lights-silti-3200k', level: 1 } }] }, { group: '*', blocks: [{ id: 'b', start: 0, rise: 0, what: { kind: 'look', look: 'worship' } }] }] }];
  const gone = rig();
  gone.timelines = withTl.timelines;
  const frontFixtures = withTl.groups.find((g) => g.id === 'front-lights')!.fixtures;
  gone.groups = gone.groups.filter((g) => g.id !== 'front-lights');
  gone.presets = gone.presets.filter((p) => p.group !== 'front-lights');
  gone.looks = gone.looks.filter((l) => l.id !== 'worship');
  gone.fixtures = gone.fixtures.filter((f) => !frontFixtures.includes(f.id));
  gone.operator.groups = gone.operator.groups.filter((g) => g !== 'front-lights');
  gone.operator.looks = gone.operator.looks.filter((l) => l !== 'worship');
  gone.operator.runningOrder = gone.operator.runningOrder.filter((l) => l !== 'worship');
  gone.operator.quickLooks = gone.operator.quickLooks.filter((q) => q.look !== 'worship');
  const picks = diffShows(withTl, gone).filter((i) => i.kind !== 'timeline').map((i) => ({ kind: i.kind, id: i.id, change: i.change }));
  assert.ok(picks.length);
  const after = applyPicks(withTl, gone, picks);
  assert.deepEqual(after.timelines, withTl.timelines);
});

test('Hangs on and LEDs set up here are kept when the file has none (a Lightkey project): nothing is listed, nothing is lost', () => {
  const current = rig();
  assert.ok(current.fixtures.every((f) => f.hangs), 'the church show says where every light hangs');
  assert.ok(current.profiles.some((p) => p.leds), 'and how many LEDs its bars have');
  // What Lightkey gives: the same rig without either.
  const incoming = rig();
  for (const f of incoming.fixtures) delete f.hangs;
  for (const p of incoming.profiles) delete p.leds;
  assert.deepEqual(diffShows(current, incoming), [], 'no fixture and no type is listed as changed');
  // A real change to a light still takes its Hangs on and LEDs along with it unchanged.
  incoming.fixtures.find((f) => f.id === 'b3')!.address = 300;
  incoming.profiles.find((p) => p.id === current.fixtures.find((f) => f.id === 'b3')!.profile)!.channels.pop();
  const items = diffShows(current, incoming);
  assert.deepEqual(items.find((i) => i.id === 'b3')?.details, ['address 1/48 → 1/300']);
  const typeId = current.fixtures.find((f) => f.id === 'b3')!.profile;
  const type = items.find((i) => i.kind === 'profile' && i.id === typeId);
  assert.ok(type && type.details.every((d) => !d.includes('LEDs')), 'the type differs in its channels only');
  const out = applyPicks(current, incoming, [
    { kind: 'fixture', id: 'b3', change: 'changed' },
    { kind: 'profile', id: typeId, change: 'changed' },
  ]);
  assert.equal(out.fixtures.find((f) => f.id === 'b3')!.hangs, current.fixtures.find((f) => f.id === 'b3')!.hangs);
  assert.equal(out.profiles.find((p) => p.id === typeId)!.leds, current.profiles.find((p) => p.id === typeId)!.leds);
});

test('a file that says where a light hangs or how many LEDs it has is compared, described and taken', () => {
  const current = rig();
  const sixbar = current.fixtures.find((f) => f.id === 'b1')!;
  assert.equal(sixbar.hangs, 'truss');
  const incoming = rig();
  incoming.fixtures.find((f) => f.id === 'b1')!.hangs = 'stand';
  incoming.profiles.find((p) => p.id === sixbar.profile)!.leds = 8;
  const items = diffShows(current, incoming);
  assert.deepEqual(items.find((i) => i.kind === 'fixture' && i.id === 'b1')?.details, ['hangs on truss → stand']);
  assert.deepEqual(items.find((i) => i.kind === 'profile' && i.id === sixbar.profile)?.details, ['LEDs 6 → 8']);
  const out = applyPicks(current, incoming, [
    { kind: 'fixture', id: 'b1', change: 'changed' },
    { kind: 'profile', id: sixbar.profile, change: 'changed' },
  ]);
  assert.equal(out.fixtures.find((f) => f.id === 'b1')!.hangs, 'stand');
  assert.equal(out.profiles.find((p) => p.id === sixbar.profile)!.leds, 8);
  // Both ways: a file that has them where this show has none is a change too.
  const bare = rig();
  delete bare.fixtures.find((f) => f.id === 'b1')!.hangs;
  assert.deepEqual(diffShows(bare, incoming).find((i) => i.id === 'b1')?.details, ['hangs on guessed → stand']);
});
