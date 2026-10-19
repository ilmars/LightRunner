// White, amber and UV: how they mix, fade and reach the channels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_PROFILES, type ChannelRole, type Fixture, type Profile } from '../../shared/src/index.ts';
import { Engine, dark, fromHex, mix, type Light } from '../src/index.ts';
import { kelvinOf, planChannels, visualOf, writeFixture } from '../src/output.ts';
import { FRAME, close, demoShow, lightOf } from './helpers.ts';

const G = 2.2;
const dmx = (v: number) => Math.round(Math.pow(v, G) * 255);
const builtIn = (id: string) => BUILT_IN_PROFILES.find((p) => p.id === id)!;
const made = (id: string, roles: ChannelRole[]): Profile => ({ id, name: id, channels: roles.map((role) => ({ role })) });
const RGBWAUV = made('rgbwauv', ['red', 'green', 'blue', 'white', 'amber', 'uv']);

/** The channel values a fixture of this profile at address 1 gets for `light`. */
function write(profile: Profile, light: Light): number[] {
  const fixture: Fixture = { id: 'f', name: 'f', profile: profile.id, universe: 0, address: 1, x: 0.5, y: 0.5 };
  const buf = new Uint8Array(512);
  writeFixture(buf, planChannels(fixture, profile, G), light);
  return Array.from(buf.subarray(0, profile.channels.length));
}

function visual(light: Light): number[] {
  const out = new Uint8Array(3);
  visualOf(light, out, 0);
  return Array.from(out);
}

test('amber and UV channels are driven like white, with gamma', () => {
  // Red with half amber and a quarter UV, at 80 %: no dimmer, so the level is in every channel.
  const light = fromHex('#ff0000', { amber: 0.5, uv: 0.25 }, 0.8);
  assert.deepEqual(write(RGBWAUV, light), [dmx(0.8), 0, 0, 0, dmx(0.4), dmx(0.2)]);
  // With a dimmer, the level goes on the dimmer and amber and UV keep their own levels.
  const dimmed = made('dau', ['dimmer', 'amber', 'uv']);
  assert.deepEqual(write(dimmed, light), [dmx(0.8), dmx(0.5), dmx(0.25)]);
  // Without amber or UV the channels stay at 0, as before.
  assert.deepEqual(write(RGBWAUV, fromHex('#ff8000', 0.5)), [255, dmx(0x80 / 255), 0, dmx(0.5), 0, 0]);
});

test('without an amber channel, amber is made from red and green; UV without a UV channel is left out', () => {
  const amber = fromHex('#000000', { amber: 1 });
  assert.deepEqual(write(builtIn('generic-rgb'), amber), [255, dmx(0xbf / 255), 0]);
  assert.deepEqual(write(builtIn('generic-rgba'), amber), [0, 0, 0, 255]);
  // Amber on top of blue: red and green come up, blue stays.
  assert.deepEqual(write(builtIn('generic-rgb'), fromHex('#0000ff', { amber: 0.5 })), [dmx(0.5), dmx(0.5 * 0xbf / 255), 255]);

  const uv = fromHex('#000000', { uv: 1 });
  assert.deepEqual(write(builtIn('generic-rgb'), uv), [0, 0, 0]);
  assert.deepEqual(write(builtIn('generic-rgbw'), uv), [0, 0, 0, 0]);
  assert.deepEqual(write(builtIn('generic-drgb'), uv), [0, 0, 0, 0]);
  // UV next to a colour: the colour shows at its own brightness.
  assert.deepEqual(write(builtIn('generic-drgb'), fromHex('#800000', { uv: 1 })), [dmx(0x80 / 255), 255, 0, 0]);
  // A plain dimmer can't make UV: UV alone leaves it dark, UV next to a colour doesn't change it.
  assert.deepEqual(write(builtIn('generic-dimmer'), uv), [0]);
  assert.deepEqual(write(builtIn('generic-dimmer'), fromHex('#000000', { white: 0.5, uv: 1 })), [dmx(0.5)]);
  assert.deepEqual(write(builtIn('generic-dimmer'), fromHex('#ff0000', { uv: 0.5 })), [255]);
});

test('amber makes a colour-temperature fixture warmer; UV makes no difference', () => {
  const white = fromHex('#ffffff');
  assert.ok(kelvinOf(fromHex('#ffffff', { amber: 0.5 })) < kelvinOf(white) - 500);
  assert.ok(kelvinOf(fromHex('#ffeedd', { amber: 0.3 })) < kelvinOf(fromHex('#ffeedd')));
  assert.equal(kelvinOf(fromHex('#000000', { amber: 1 })), 2000);
  assert.equal(kelvinOf(fromHex('#ffffff', { uv: 1 })), kelvinOf(white));
  const cct = made('dc', ['dimmer', 'cct']);
  const warm = write(cct, fromHex('#ffffff', { amber: 1 }));
  const plain = write(cct, white);
  assert.equal(warm[0], 255);
  assert.ok(warm[1]! < plain[1]!, `cct ${warm[1]} vs ${plain[1]}`);
});

test('the visualiser shows amber as orange and UV as a faint violet', () => {
  assert.deepEqual(visual(fromHex('#000000', { amber: 1 })), [255, 0xbf, 0]);
  assert.deepEqual(visual(fromHex('#000000', { uv: 1 })), [64, 0, 102]);
  assert.deepEqual(visual(fromHex('#000000', { uv: 1 }, 0.5)), [32, 0, 51]);
  // Unchanged without them: white adds to all three.
  assert.deepEqual(visual(fromHex('#ff4000', 0.5, 0.5)), [128, 96, 64]);
});

test('amber and UV mix as emitted light, like the colours', () => {
  const out = mix(dark(), [fromHex('#ff0000'), fromHex('#000000', { amber: 1, uv: 0.5 })], [0.5, 0.5]);
  assert.ok(close(out.r, 1) && close(out.a, 1) && close(out.u, 0.5) && close(out.i, 1));
  // Fading up from dark keeps the amber.
  const up = mix(dark(), [dark(), fromHex('#000000', { amber: 1 })], [0.8, 0.2]);
  assert.ok(close(up.a, 1) && close(up.r, 0) && close(up.i, 0.2));
});

/** The demo show with RGBWAUV audience fixtures and audience presets that use amber and UV. */
function extrasShow() {
  const show = demoShow();
  show.profiles.push(RGBWAUV);
  for (const [id, address] of [['aud-1', 60], ['aud-2', 66]] as const) {
    const f = show.fixtures.find((x) => x.id === id)!;
    f.profile = RGBWAUV.id;
    f.address = address;
  }
  show.presets.push(
    { id: 'aud-amber', name: 'Amber', group: 'audience', fade: 3, layers: [{ kind: 'static', colour: { hex: '#ff0000', amber: 1 }, intensity: 1 }] },
    { id: 'aud-uv', name: 'UV', group: 'audience', fade: 3, layers: [{ kind: 'static', colour: { hex: '#0000ff', white: 0.4, uv: 1 }, intensity: 0.7 }] },
  );
  return show;
}

/**
 * Largest per-frame change of a fixture's intensity, of its emitted red, green
 * and blue, and of its emitted white, amber and UV.
 */
function worstSteps(e: Engine, fixture: string, from: number, to: number, onFrame: (t: number) => void) {
  const emitted = (l: Light) => [l.i, l.r * l.i, l.g * l.i, l.b * l.i, l.w * l.i, l.a * l.i, l.u * l.i];
  let prev = emitted(lightOf(e, fixture));
  const worst = prev.map(() => 0);
  for (let t = from; t <= to + 1e-9; t += FRAME) {
    onFrame(t);
    e.frame(t);
    const now = emitted(lightOf(e, fixture));
    for (let k = 0; k < now.length; k++) worst[k] = Math.max(worst[k]!, Math.abs(now[k]! - prev[k]!));
    prev = now;
  }
  return { intensity: worst[0]!, colours: Math.max(...worst.slice(1, 4)), extras: Math.max(...worst.slice(4)) };
}

test('a preset compiles its amber and UV, and a fade between two of them stays under 5% per frame', () => {
  const e = new Engine(extrasShow());
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-amber', fade: 0 }, 0);
  e.frame(1);
  const amber = lightOf(e, 'aud-1');
  assert.ok(close(amber.r, 1) && close(amber.a, 1) && close(amber.u, 0) && close(amber.i, 1));
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-uv', fade: 1 }, 1);
  // Interrupted half way by a live colour with amber, then back to the amber preset.
  const step = worstSteps(e, 'aud-1', 1, 6, (t) => {
    if (close(t, 1.5, 1e-6)) e.apply({ type: 'groupColour', group: 'audience', colour: '#00ff00', amber: 0.6, uv: 0.3, fade: 1 }, t);
    if (close(t, 2, 1e-6)) e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-amber', fade: 1 }, t);
  });
  // The 5% rule is on intensity. White, amber and UV move no faster than red,
  // green and blue do in the same fade (the colour is scaled to its brightest channel).
  assert.ok(step.intensity < 0.05, `largest intensity step ${step.intensity}`);
  assert.ok(step.extras <= step.colours + 1e-9, `extras step ${step.extras} vs colours ${step.colours}`);
  const uv = new Engine(extrasShow());
  uv.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-uv', fade: 0 }, 0);
  uv.frame(1);
  const l = lightOf(uv, 'aud-1');
  assert.ok(close(l.u, 1) && close(l.w, 0.4) && close(l.b, 1) && close(l.i, 0.7));
});

test('Any colour with white, amber and UV runs a live colour that Undo and a restart handle like any other', () => {
  const e = new Engine(extrasShow());
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-amber', fade: 0 }, 0);
  assert.equal(e.apply({ type: 'groupColour', group: 'audience', colour: '#000000', amber: 0.5, uv: 0.2, fade: 0 }, 1), null);
  e.frame(1.1);
  assert.equal(e.liveState(1.1, 'ok').groups.audience.preset, 'live:audience:#000000:a50:u20');
  const l = lightOf(e, 'aud-1');
  assert.ok(close(l.a, 1) && close(l.u, 0.4) && close(l.i, 0.5) && close(l.w, 0));

  const b = new Engine(extrasShow());
  b.restore(e.runtime(), 0);
  b.frame(0);
  assert.equal(b.liveState(0, 'ok').groups.audience.preset, 'live:audience:#000000:a50:u20');
  assert.ok(close(lightOf(b, 'aud-1').a, 1));

  assert.equal(e.apply({ type: 'undo' }, 2), null);
  assert.equal(e.liveState(2, 'ok').groups.audience.preset, 'aud-amber');
  // Without extras the id is the old one.
  e.apply({ type: 'groupColour', group: 'audience', colour: '#00FF80', white: 0, fade: 0 }, 5);
  assert.equal(e.liveState(5, 'ok').groups.audience.preset, 'live:audience:#00ff80');
});

test('a slider drag (Any colour sends that continue the first) is one Undo step', () => {
  const e = new Engine(extrasShow());
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-amber', fade: 0 }, 0);
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-uv', fade: 0 }, 1);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', amber: 0.01, fade: 0.2 }, 2);
  assert.equal(e.recorded, true, 'the first send of a drag is an Undo step');
  for (let k = 2; k <= 31; k++) {
    assert.equal(e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', amber: k / 100, fade: 0.2, continues: true }, 2 + k * 0.04), null);
    assert.equal(e.recorded, false);
  }
  assert.equal(e.liveState(4, 'ok').groups.audience.preset, 'live:audience:#ff0000:a31');
  assert.equal(e.apply({ type: 'undo' }, 4), null);
  assert.equal(e.liveState(4, 'ok').groups.audience.preset, 'aud-uv');
  assert.equal(e.apply({ type: 'undo' }, 5), null);
  assert.equal(e.liveState(5, 'ok').groups.audience.preset, 'aud-amber');
});

test('two drags are two Undo steps, even when the second starts on the colour the first ended on', () => {
  const e = new Engine(extrasShow());
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-amber', fade: 0 }, 0);
  // Drag A.
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', white: 0.1 }, 1);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', white: 0.2, fade: 0.2, continues: true }, 1.1);
  // Drag B starts where A ended (no change, so no step of its own), then moves on.
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', white: 0.2 }, 2);
  assert.equal(e.recorded, false);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', white: 0.3, fade: 0.2, continues: true }, 2.1);
  assert.equal(e.recorded, true, 'drag B gets its own step');
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', white: 0.4, fade: 0.2, continues: true }, 2.2);
  assert.equal(e.recorded, false);
  e.apply({ type: 'undo' }, 3);
  assert.equal(e.liveState(3, 'ok').groups.audience.preset, 'live:audience:#ff0000:w20', 'the first Undo takes back drag B only');
  e.apply({ type: 'undo' }, 4);
  assert.equal(e.liveState(4, 'ok').groups.audience.preset, 'aud-amber');
});

test('a continued Any colour send after something else changed the group is its own Undo step', () => {
  const e = new Engine(extrasShow());
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-amber', fade: 0 }, 0);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', uv: 0.5, fade: 0.2 }, 1);
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-uv', fade: 0 }, 2);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', uv: 0.6, fade: 0.2, continues: true }, 3);
  assert.equal(e.recorded, true);
  // On another group, too.
  e.apply({ type: 'groupColour', group: 'back-wall', colour: '#00ff00', fade: 0.2, continues: true }, 4);
  assert.equal(e.recorded, true);
  // And after an Undo.
  e.apply({ type: 'undo' }, 5);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', uv: 0.7, fade: 0.2, continues: true }, 6);
  assert.equal(e.recorded, true);
});

test('Save adopts a live colour with amber when the custom preset has the same amber', () => {
  const show = extrasShow();
  show.looks.push({ id: 'mine', name: 'Mine', groups: [{ group: 'audience', preset: 'aud-low' }] });
  const e = new Engine(show);
  e.apply({ type: 'look', id: 'mine', fade: 0 }, 0);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#ff0000', white: 0.25, amber: 0.4, fade: 0 }, 1);
  e.frame(2);
  const before = Array.from(e.frame(2.025).universes.get(0)!);
  const saved = structuredClone(show);
  saved.presets.push({
    id: 'custom-1', name: 'Custom', group: 'audience', custom: true, fade: 3,
    layers: [{ kind: 'static', colour: { hex: '#ff0000', white: 0.25, amber: 0.4 }, intensity: 1 }],
  });
  saved.looks.find((l) => l.id === 'mine')!.groups[0]!.preset = 'custom-1';
  e.setShow(saved, 2.05);
  assert.deepEqual(Array.from(e.frame(2.05).universes.get(0)!), before);
  assert.equal(e.liveState(2.05, 'ok').groups.audience.preset, 'custom-1');
  assert.equal(e.liveState(2.05, 'ok').lookChanged, false);
});

test('a lit colour with amber that the show no longer has carries on live with its amber, with no visible change', () => {
  const withAmber = () => {
    const show = demoShow();
    show.presets.push({ id: 'aud-amber', name: 'Amber red', group: 'audience', fade: 3, swatch: '#ff4800', layers: [{ kind: 'static', colour: { hex: '#ff0000', amber: 0.5, uv: 0.2 }, intensity: 1 }] });
    return show;
  };
  const e = new Engine(withAmber());
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-amber', fade: 0 }, 0);
  e.frame(1);
  const before = Array.from(e.frame(1.025).universes.get(0)!);
  e.setShow(demoShow(), 1.025); // e.g. Compare with a file removed it
  assert.deepEqual(Array.from(e.frame(1.025).universes.get(0)!), before);
  assert.equal(e.liveState(1.025, 'ok').groups.audience.preset, 'live:audience:#ff0000:a50:u20');
  assert.deepEqual(e.liveState(1.025, 'ok').groups.audience.live, { colour: '#ff0000', white: 0, amber: 0.5, uv: 0.2, display: '#ff3e0d' });
});
