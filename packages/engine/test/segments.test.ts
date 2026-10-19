// Segments: each repeated set of colour channels in a fixture type is one
// segment the engine lights on its own. A group's segments, in group order
// (each fixture's reversed when it is hung the other way), make one line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILT_IN_PROFILES, parseShow, type ChannelRole, type Fixture, type Profile, type Show } from '../../shared/src/index.ts';
import { Engine, fromHex, type Light } from '../src/index.ts';
import { kelvinOf, planChannels, writeCells, writeFixture, type ChannelPlan } from '../src/output.ts';
import { copy, dark, withoutUv } from '../src/light.ts';

const G = 2.2;
const dmx = (v: number) => Math.round(Math.pow(v, G) * 255);
const stage = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));
const stageProfile = (id: string) => stage().profiles.find((p) => p.id === id)!;
const made = (id: string, roles: ChannelRole[]): Profile => ({ id, name: id, channels: roles.map((role) => ({ role })) });
const fixtureOf = (profile: Profile, address = 1): Fixture =>
  ({ id: 'f', name: 'f', profile: profile.id, universe: 0, address, x: 0.5, y: 0.5 });
const planOf = (profile: Profile) => planChannels(fixtureOf(profile), profile, G);

const BAR10 = 'stairville-sonicpulse-led-bar-10-39-ch';
const SIXBAR = 'elation-sixbar-500-18-ch';

test('segments are found from repeated colour channels', () => {
  const bar = planOf(stageProfile(BAR10));
  assert.equal(bar.cells, 8);
  // Dimmer, strobe and the mode channels are fixture-wide; the n-th red belongs to segment n.
  assert.deepEqual(bar.channels.filter((c) => c.role === 'red').map((c) => c.cell), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(bar.channels.filter((c) => c.role === 'dimmer' || c.role === 'strobe' || c.role === 'other').every((c) => c.cell === -1));

  assert.equal(planOf(stageProfile(SIXBAR)).cells, 3);
  const rgb = planOf(BUILT_IN_PROFILES.find((p) => p.id === 'generic-rgb')!);
  assert.equal(rgb.cells, 1);
  assert.deepEqual(rgb.channels.map((c) => c.cell), [0, 0, 0]);

  const fourRgbAndWhite = planOf(made('x', ['red', 'green', 'blue', 'red', 'green', 'blue', 'red', 'green', 'blue', 'red', 'green', 'blue', 'white']));
  assert.equal(fourRgbAndWhite.cells, 4);
  assert.equal(fourRgbAndWhite.channels.find((c) => c.role === 'white')!.cell, -1);
  assert.deepEqual(fourRgbAndWhite.channels.filter((c) => c.role === 'blue').map((c) => c.cell), [0, 1, 2, 3]);
});

// ---- writeFixture as it was before segments (main at 8b473ae), kept here as the reference ----

const AMBER_GREEN = 0xbf / 255;

function put(buf: Uint8Array, ch: ChannelPlan['channels'][number], v: number): void {
  const x = Math.min(1, Math.max(0, v));
  if (ch.fineAt >= 0) {
    const v16 = Math.round(x * 65535);
    buf[ch.at] = v16 >> 8;
    if (ch.fineAt < 512) buf[ch.fineAt] = v16 & 255;
  } else {
    buf[ch.at] = Math.round(x * 255);
  }
}

function referenceWrite(buf: Uint8Array, plan: ChannelPlan, light: Light): void {
  if (!plan.hasUv && light.u > 0) light = withoutUv(copy(dark(), light));
  if (light.i <= 0) {
    for (const ch of plan.channels) {
      const fixed = ch.role === 'strobe' || ch.role === 'other';
      buf[ch.at] = fixed ? ch.fixed : 0;
      if (ch.fineAt >= 0 && ch.fineAt < 512) buf[ch.fineAt] = 0;
    }
    return;
  }
  const g = plan.gamma;
  const fold = plan.hasWhite ? 0 : light.w;
  const amber = plan.hasAmber ? 0 : light.a;
  const level = plan.hasDimmer ? 1 : light.i;
  const col = (c: number, a: number) => Math.pow(Math.min(1, c + fold + a) * level, g);
  for (const ch of plan.channels) {
    switch (ch.role) {
      case 'dimmer': put(buf, ch, Math.pow(light.i, g)); break;
      case 'red': put(buf, ch, col(light.r, amber)); break;
      case 'green': put(buf, ch, col(light.g, amber * AMBER_GREEN)); break;
      case 'blue': put(buf, ch, col(light.b, 0)); break;
      case 'white': put(buf, ch, Math.pow(light.w * level, g)); break;
      case 'amber': put(buf, ch, Math.pow(light.a * level, g)); break;
      case 'uv': put(buf, ch, Math.pow(light.u * level, g)); break;
      case 'cct': {
        const k = ch.kelvin ?? { min: 2700, max: 6500 };
        put(buf, ch, (kelvinOf(light) - k.min) / (k.max - k.min));
        break;
      }
      default: buf[ch.at] = ch.fixed;
    }
  }
}

test('a plain colour writes the same DMX as before segments', () => {
  const profiles = [...BUILT_IN_PROFILES, ...stage().profiles];
  const lights = [
    dark(),
    fromHex('#ffffff'),
    fromHex('#ff0000', 0, 0.37),
    fromHex('#00ff80', 0.5, 0.8),
    fromHex('#dcebff', { white: 0.6, amber: 0.3, uv: 0.2 }, 0.9),
    fromHex('#000000', { amber: 1 }, 0.5),
    fromHex('#000000', { uv: 1 }),
    fromHex('#ffb46b', 0, 0.01),
  ];
  for (const profile of profiles) {
    // At address 500 too, so channels past 512 are dropped the same way.
    for (const address of [1, 500]) {
      const plan = planChannels(fixtureOf(profile, address), profile, G);
      for (const light of lights) {
        const want = new Uint8Array(512).fill(7);
        referenceWrite(want, plan, { ...light });
        const cells = new Uint8Array(512).fill(7);
        writeCells(cells, plan, Array.from({ length: plan.cells }, () => ({ ...light })));
        const whole = new Uint8Array(512).fill(7);
        writeFixture(whole, plan, { ...light });
        const what = `${profile.id} at ${address}, light ${JSON.stringify(light)}`;
        assert.deepEqual(Array.from(cells), Array.from(want), `writeCells: ${what}`);
        assert.deepEqual(Array.from(whole), Array.from(want), `writeFixture: ${what}`);
      }
    }
  }
});

test('segments of one fixture can differ, and the dimmer gets the brightest', () => {
  const plan = planOf(made('d2rgb', ['dimmer', 'red', 'green', 'blue', 'red', 'green', 'blue']));
  assert.equal(plan.cells, 2);
  const buf = new Uint8Array(512);
  writeCells(buf, plan, [fromHex('#ff0000'), fromHex('#0000ff', 0, 0.5)]);
  assert.deepEqual(Array.from(buf.subarray(0, 7)), [dmx(1), 255, 0, 0, 0, 0, dmx(0.5)]);
  // Below full, the dimmer takes the brightest segment and each colour its share of that.
  writeCells(buf, plan, [fromHex('#ff0000', 0, 0.8), fromHex('#0000ff', 0, 0.4)]);
  assert.deepEqual(Array.from(buf.subarray(0, 7)), [dmx(0.8), 255, 0, 0, 0, 0, dmx(0.5)]);

  // Without a dimmer each segment carries its own intensity; a fixture-wide white follows the brightest segment.
  const bare = planOf(made('2rgbw', ['red', 'green', 'blue', 'red', 'green', 'blue', 'white']));
  const out = new Uint8Array(512);
  writeCells(out, bare, [fromHex('#ff0000', 0.5, 0.4), fromHex('#00ff00', 1, 0.8)]);
  assert.deepEqual(Array.from(out.subarray(0, 7)), [dmx(0.4), 0, 0, 0, dmx(0.8), 0, dmx(0.8)]);
});

/** Two 8-segment bars in one group, the second hung the other way round. */
function barsShow(): Show {
  const source = stage();
  return parseShow({
    schemaVersion: source.schemaVersion,
    name: 'Bars',
    profiles: source.profiles.filter((p) => p.id === BAR10),
    fixtures: [
      { id: 'bar1', name: 'Bar 1', profile: BAR10, universe: 1, address: 1 },
      { id: 'bar2', name: 'Bar 2', profile: BAR10, universe: 1, address: 40, reversed: true },
    ],
    groups: [{ id: 'bars', name: 'Bars', fixtures: ['bar1', 'bar2'] }],
    presets: [{ id: 'white', name: 'White', group: 'bars', layers: [{ kind: 'static', colour: { hex: '#ffffff' } }], fade: 0 }],
    looks: [],
  });
}

test('the visual has 3 bytes per segment and the line follows group order and reversed', () => {
  const e = new Engine(barsShow(), 0);
  assert.deepEqual(e.segmentCounts(), [8, 8]);
  assert.equal(e.apply({ type: 'groupPreset', group: 'bars', preset: 'white', fade: 0 }, 0), null);
  e.frame(0);

  // A stub layer: the preset's layer hands out a different brightness on each render, and
  // the group renders its line in order, so the k-th render is line position k (ctx.index).
  const layer = (e as unknown as { presets: Map<string, { layers: object[] }> }).presets.get('white')!.layers[0]!;
  let renders = 0;
  Object.defineProperty(layer, 'light', { get: () => fromHex('#ffffff', 0, (renders++ + 1) / 16) });
  const frame = e.frame(1);
  assert.equal(renders, 16, 'one render per segment of the line');
  assert.equal(frame.visual.length, 16 * 3);
  const shown = (k: number) => frame.visual[k * 3]!;
  const at = (position: number) => Math.round(((position + 1) / 16) * 255);
  // Bar 1's segments are line positions 0..7; bar 2 is reversed, so its first segment is the line's end.
  for (let c = 0; c < 8; c++) assert.equal(shown(c), at(c), `bar 1 segment ${c + 1}`);
  for (let c = 0; c < 8; c++) assert.equal(shown(8 + c), at(15 - c), `bar 2 segment ${c + 1}`);
  assert.equal(e.visibleLevels().length, 16);

  // The DMX follows: bar 2 has dimmer, strobe and 5 mode channels, then 8 x RGBW; its last segment shows line position 8.
  const u = frame.universes.get(1)!;
  assert.equal(u[39], 255, 'bar 2 dimmer at the brightest segment');
  assert.equal(u[39 + 7 + 7 * 4], dmx((8 + 1) / 16), 'bar 2 segment 8 red');
});

test('Master, manual and Flash reach every segment of a fixture', () => {
  const e = new Engine(barsShow(), 0);
  e.apply({ type: 'groupPreset', group: 'bars', preset: 'white', fade: 0 }, 0);
  e.apply({ type: 'master', value: 0.5 }, 0);
  e.frame(0);
  e.frame(1);
  assert.deepEqual(e.visibleLevels(), new Array(16).fill(0.5));

  // A fixture's manual colour takes all of its segments, and only its own.
  e.apply({ type: 'manual', target: { fixture: 'bar2' }, colour: '#ff0000', intensity: 1 }, 1);
  for (let t = 1; t < 3; t += 0.025) e.frame(t);
  const frame = e.frame(3);
  for (let c = 0; c < 8; c++) assert.deepEqual(Array.from(frame.visual.subarray(c * 3, c * 3 + 3)), [128, 128, 128], `bar 1 segment ${c + 1}`);
  // Manual follows the finger with a filter, so it is only nearly at half.
  for (let c = 8; c < 16; c++) {
    const [r, g, b] = frame.visual.subarray(c * 3, c * 3 + 3);
    assert.ok(Math.abs(r! - 128) <= 1 && g === 0 && b === 0, `bar 2 segment ${c - 7}: ${[r, g, b]}`);
  }

  e.apply({ type: 'flash', groups: ['bars'], on: true }, 3);
  e.frame(3.1);
  assert.deepEqual(e.visibleLevels(), new Array(16).fill(1));
});
