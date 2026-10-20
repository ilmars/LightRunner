import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';
import {
  Pickup, apcAllOff, apcIntro, apcLeds, apcModel, buttonIntent, faderAction, ledChanges, parseApc, pickApcPort, rgbSysex,
  type ApcLayout, type ApcState,
} from '../src/apc.ts';
import { FakeMidi, loadMidi, type MidiPorts } from '../src/midi.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(get: () => T | null | undefined | false, ms = 2000, what = 'a condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ---- Which port is an APC mini, and which model ----

test('the model comes from the port name', () => {
  assert.equal(apcModel('APC MINI'), 'mk1');
  assert.equal(apcModel('APC mini'), 'mk1');
  assert.equal(apcModel('APC mini mk2'), 'mk2');
  assert.equal(apcModel('APC mini mk2 Control'), 'mk2');
  assert.equal(apcModel('MIDIIN2 (APC mini mk2)'), 'mk2');
  assert.equal(apcModel('APC MINI MK2'), 'mk2');
  assert.equal(apcModel('Launchpad Mini'), null);
  assert.equal(apcModel('APC40 mkII'), null);
  assert.equal(apcModel('APC Key 25'), null);
});

test('the control port is picked over the notes port', () => {
  assert.equal(pickApcPort([]), null);
  assert.equal(pickApcPort(['Launchpad Mini', 'Microsoft GS Wavetable Synth']), null);
  // Windows: the second port is "MIDIIN2 (...)"; macOS: "... Notes".
  assert.equal(pickApcPort(['MIDIIN2 (APC mini mk2)', 'APC mini mk2']), 'APC mini mk2');
  assert.equal(pickApcPort(['APC mini mk2 Notes', 'APC mini mk2 Control']), 'APC mini mk2 Control');
  assert.equal(pickApcPort(['IAC Driver Bus 1', 'APC MINI']), 'APC MINI');
});

// ---- Reading what the APC sends ----

test('pads, buttons and faders of the mk2 (Akai: pads 0-63, track 100-107, scene 112-119, faders CC 48-56)', () => {
  assert.deepEqual(parseApc('mk2', [0x90, 0, 127]), { kind: 'press', control: { kind: 'pad', row: 1, col: 1 } });
  assert.deepEqual(parseApc('mk2', [0x90, 7, 127]), { kind: 'press', control: { kind: 'pad', row: 1, col: 8 } });
  assert.deepEqual(parseApc('mk2', [0x90, 56, 127]), { kind: 'press', control: { kind: 'pad', row: 8, col: 1 } });
  assert.deepEqual(parseApc('mk2', [0x80, 63, 0]), { kind: 'release', control: { kind: 'pad', row: 8, col: 8 } });
  // A note-on with velocity 0 is a release too.
  assert.deepEqual(parseApc('mk2', [0x90, 100, 0]), { kind: 'release', control: { kind: 'track', n: 1 } });
  assert.deepEqual(parseApc('mk2', [0x90, 107, 127]), { kind: 'press', control: { kind: 'track', n: 8 } });
  assert.deepEqual(parseApc('mk2', [0x90, 112, 127]), { kind: 'press', control: { kind: 'scene', n: 1 } });
  assert.deepEqual(parseApc('mk2', [0x90, 119, 127]), { kind: 'press', control: { kind: 'scene', n: 8 } });
  assert.deepEqual(parseApc('mk2', [0xb0, 48, 127]), { kind: 'fader', fader: 1, value: 1 });
  assert.deepEqual(parseApc('mk2', [0xb0, 55, 0]), { kind: 'fader', fader: 8, value: 0 });
  assert.deepEqual(parseApc('mk2', [0xb0, 56, 64]), { kind: 'fader', fader: 9, value: 0.5039 });
  // Shift, the older model's buttons and other controllers mean nothing here.
  assert.equal(parseApc('mk2', [0x90, 122, 127]), null);
  assert.equal(parseApc('mk2', [0x90, 64, 127]), null);
  assert.equal(parseApc('mk2', [0x90, 82, 127]), null);
  assert.equal(parseApc('mk2', [0xb0, 47, 10]), null);
  assert.equal(parseApc('mk2', [0xb0, 57, 10]), null);
  assert.equal(parseApc('mk2', [0xe0, 0, 64]), null);
  assert.equal(parseApc('mk2', [0x90, 1]), null);
  assert.equal(parseApc('mk2', []), null);
  // The reply to the introduction carries where the nine faders are.
  assert.deepEqual(
    parseApc('mk2', [0xf0, 0x47, 0x7f, 0x4f, 0x61, 0x00, 0x09, 0, 127, 64, 0, 0, 0, 0, 0, 127, 0xf7]),
    { kind: 'faders', values: [0, 1, 0.5039, 0, 0, 0, 0, 0, 1] },
  );
  assert.equal(parseApc('mk2', [0xf0, 0x47, 0x7f, 0x4f, 0x24, 0xf7]), null);
});

test('pads, buttons and faders of the older APC mini (track 64-71, scene 82-89)', () => {
  assert.deepEqual(parseApc('mk1', [0x90, 0, 127]), { kind: 'press', control: { kind: 'pad', row: 1, col: 1 } });
  assert.deepEqual(parseApc('mk1', [0x90, 64, 127]), { kind: 'press', control: { kind: 'track', n: 1 } });
  assert.deepEqual(parseApc('mk1', [0x80, 71, 127]), { kind: 'release', control: { kind: 'track', n: 8 } });
  assert.deepEqual(parseApc('mk1', [0x90, 82, 127]), { kind: 'press', control: { kind: 'scene', n: 1 } });
  assert.deepEqual(parseApc('mk1', [0x90, 89, 127]), { kind: 'press', control: { kind: 'scene', n: 8 } });
  assert.deepEqual(parseApc('mk1', [0xb0, 56, 127]), { kind: 'fader', fader: 9, value: 1 });
  assert.equal(parseApc('mk1', [0x90, 98, 127]), null); // Shift
  assert.equal(parseApc('mk1', [0x90, 100, 127]), null);
  assert.equal(parseApc('mk1', [0x90, 112, 127]), null);
});

test('what each pad and button asks for', () => {
  const pad = (row: number, col: number) => ({ kind: 'pad' as const, row, col });
  // Top row: songs 1-8, the row below: 9-16.
  assert.deepEqual(buttonIntent(pad(8, 1), true), { action: { kind: 'item', n: 1 } });
  assert.deepEqual(buttonIntent(pad(8, 8), true), { action: { kind: 'item', n: 8 } });
  assert.deepEqual(buttonIntent(pad(7, 1), true), { action: { kind: 'item', n: 9 } });
  assert.deepEqual(buttonIntent(pad(7, 8), true), { action: { kind: 'item', n: 16 } });
  // Rows 6 to 1: colours 1 to 6 of the group above the column's fader.
  assert.deepEqual(buttonIntent(pad(6, 1), true), { action: { kind: 'groupColour', group: 1, colour: 1 } });
  assert.deepEqual(buttonIntent(pad(1, 1), true), { action: { kind: 'groupColour', group: 1, colour: 6 } });
  assert.deepEqual(buttonIntent(pad(6, 8), true), { action: { kind: 'groupColour', group: 8, colour: 1 } });
  assert.deepEqual(buttonIntent(pad(3, 5), true), { action: { kind: 'groupColour', group: 5, colour: 4 } });
  // Letting go of a pad does nothing.
  assert.equal(buttonIntent(pad(8, 1), false), null);
  assert.equal(buttonIntent(pad(3, 5), false), null);
  // Track buttons flash their group while held.
  assert.deepEqual(buttonIntent({ kind: 'track', n: 3 }, true), { action: { kind: 'flash', group: 3, on: true } });
  assert.deepEqual(buttonIntent({ kind: 'track', n: 3 }, false), { action: { kind: 'flash', group: 3, on: false } });
  // Scene buttons, top to bottom.
  const scene = (n: number, on: boolean) => buttonIntent({ kind: 'scene', n }, on);
  assert.deepEqual(scene(1, true), { action: { kind: 'next' } });
  assert.deepEqual(scene(2, true), { action: { kind: 'backToLook' } });
  assert.deepEqual(scene(3, true), { action: { kind: 'undo' } });
  assert.deepEqual(scene(4, true), { action: { kind: 'basic' } });
  assert.deepEqual(scene(5, true), { action: { kind: 'flash', group: 'all', on: true } });
  assert.deepEqual(scene(5, false), { action: { kind: 'flash', group: 'all', on: false } });
  assert.deepEqual(scene(6, true), { blackoutHold: true });
  assert.deepEqual(scene(6, false), { blackoutHold: false });
  for (const n of [1, 2, 3, 4]) assert.equal(scene(n, false), null);
  for (const on of [true, false]) {
    assert.equal(scene(7, on), null);
    assert.equal(scene(8, on), null);
  }
  assert.deepEqual(faderAction(1, 0.5), { kind: 'groupLevel', group: 1, value: 0.5 });
  assert.deepEqual(faderAction(8, 0), { kind: 'groupLevel', group: 8, value: 0 });
  assert.deepEqual(faderAction(9, 1), { kind: 'master', value: 1 });
});

// ---- Pickup ----

test('pickup: a fader far from the level does nothing until it crosses it', () => {
  const p = new Pickup();
  // The level is 60 %; the fader starts at the bottom.
  assert.equal(p.move(1, 0.1, 0.6, 0), null);
  assert.equal(p.move(1, 0.3, 0.6, 0.1), null);
  assert.equal(p.move(1, 0.5, 0.6, 0.2), null);
  // Passing the level picks it up, and from then on it follows.
  assert.equal(p.move(1, 0.7, 0.6, 0.3), 0.7);
  assert.equal(p.move(1, 0.4, 0.7, 0.4), 0.4);
  // Each fader has its own pickup.
  assert.equal(p.move(2, 0.9, 0.2, 0.5), null);
});

test('pickup: coming within 2 % of the level picks it up; the first move only if it is that close', () => {
  const p = new Pickup();
  assert.equal(p.move(1, 0.585, 0.6, 0), 0.585);
  const q = new Pickup();
  assert.equal(q.move(1, 0.9, 0.6, 0), null);
  assert.equal(q.move(1, 0.61, 0.6, 0.1), 0.61);
  // Coming down onto the level from above.
  const r = new Pickup();
  assert.equal(r.move(1, 0.9, 0.3, 0), null);
  assert.equal(r.move(1, 0.2, 0.3, 0.1), 0.2);
});

test('pickup: a level changed from elsewhere re-arms it; its own levels arriving late do not', () => {
  const p = new Pickup();
  assert.equal(p.move(1, 0.5, 0.5, 0), 0.5);
  assert.equal(p.move(1, 0.6, 0.5, 0.05), 0.6);
  assert.equal(p.move(1, 0.8, 0.5, 0.1), 0.8);
  // The state catches up with what the fader sent, in steps: still following.
  p.level(1, 0.5, 0.11);
  p.level(1, 0.6, 0.12);
  p.level(1, 0.8, 0.13);
  assert.equal(p.move(1, 0.85, 0.8, 0.2), 0.85);
  // A look sets the group to 20 %: the fader waits for it again.
  p.level(1, 0.2, 5);
  assert.equal(p.move(1, 0.9, 0.2, 5.1), null);
  assert.equal(p.move(1, 0.21, 0.2, 5.2), 0.21);
  // A change of 2 % or less from elsewhere keeps it following.
  p.level(1, 0.225, 9);
  assert.equal(p.move(1, 0.3, 0.225, 9.1), 0.3);
});

test('pickup: a look that sets a level the fader swept past a moment ago is still a change from elsewhere', () => {
  const p = new Pickup();
  // Fader 1 caught at 20 % and swept up to 90 %, the state giving each level back.
  let t = 0;
  assert.equal(p.move(1, 25 / 127, 0.2, t), 25 / 127);
  for (let v = 26; v <= 114; v++) {
    t += 0.005;
    const sent = p.move(1, v / 127, (v - 1) / 127, t);
    assert.equal(sent, v / 127);
    p.level(1, v / 127, t);
  }
  // Half a second later a look sets group 1 to 50 %: inside the range just swept.
  p.level(1, 0.5, t + 0.5);
  // A one-step nudge of the fader must not make the light jump to 89 %.
  assert.equal(p.move(1, 113 / 127, 0.5, t + 0.6), null);
  assert.equal(p.move(1, 80 / 127, 0.5, t + 0.7), null);
  // Down past 50 %: it takes over again.
  assert.equal(p.move(1, 60 / 127, 0.5, t + 0.8), 60 / 127);
});

test('pickup: its own levels coming back late, a few at a time, keep it following', () => {
  const p = new Pickup();
  assert.equal(p.move(1, 0.5, 0.5, 0), 0.5);
  assert.equal(p.move(1, 0.6, 0.5, 0.01), 0.6);
  assert.equal(p.move(1, 0.7, 0.5, 0.02), 0.7);
  assert.equal(p.move(1, 0.8, 0.5, 0.03), 0.8);
  // Some of them never come back on their own (only the newest of a quick run is sent).
  p.level(1, 0.6, 0.05);
  p.level(1, 0.8, 0.06);
  assert.equal(p.move(1, 0.82, 0.8, 0.07), 0.82);
  // After 0.8 came back, 0.6 is done: a later 60 % is a change from elsewhere.
  p.level(1, 0.82, 0.08);
  p.level(1, 0.6, 0.09);
  assert.equal(p.move(1, 0.83, 0.6, 0.1), null);
});

test('pickup: a new look makes every fader wait again', () => {
  const p = new Pickup();
  assert.equal(p.move(1, 0.5, 0.5, 0), 0.5);
  assert.equal(p.move(9, 1, 1, 0), 1);
  p.rearm();
  assert.equal(p.move(1, 0.9, 0.3, 1), null);
  assert.equal(p.move(9, 0.95, 0.8, 1), null);
  assert.equal(p.move(9, 0.81, 0.8, 1.1), 0.81);
});

test('pickup: positions the APC reports (mk2 introduction) count as where the fader was', () => {
  const p = new Pickup();
  p.place(1, 0.1);
  // From 10 % straight past a level of 50 % in one move: picked up.
  assert.equal(p.move(1, 0.9, 0.5, 0), 0.9);
});

// ---- LEDs ----

const LAYOUT: ApcLayout = {
  basicLights: 'basic',
  basicSwatch: '#ffd2a0',
  runningOrder: [
    { id: 'basic', swatch: null },
    { id: 's1', swatch: '#ff0000' },
    { id: 's2', swatch: '#0000ff' },
    { id: 's3', swatch: null },
  ],
  groups: [
    { id: 'g1', kind: 'light', presets: [{ id: 'red', swatch: '#ff0000', effect: null }, { id: 'chase', swatch: '#00ff00', effect: {} }, { id: 'blue', swatch: '#0000ff', effect: null }] },
    { id: 'smoke', kind: 'smoke', presets: [] },
    { id: 'g2', kind: 'light', presets: [{ id: 'green', swatch: '#00ff00', effect: null }] },
  ],
};
const STATE: ApcState = {
  look: 's1', lastLook: 's1', lookChanged: false, canUndo: false, master: 1,
  groups: { g1: { preset: 'blue', level: 1 }, g2: { preset: 'green', level: 0.5 } },
  flashing: [],
};

test('LEDs of the older model: songs on stage green, next yellow; colours running green, others yellow, missing off', () => {
  const leds = apcLeds('mk1', LAYOUT, STATE);
  // 64 pads, 8 track buttons, 8 scene buttons.
  assert.equal(leds.size, 80);
  assert.deepEqual(leds.get(56), [0x90, 56, 0]); // Basic lights: not on stage
  assert.deepEqual(leds.get(57), [0x90, 57, 1]); // Song 1 on stage: green
  assert.deepEqual(leds.get(58), [0x90, 58, 5]); // Song 2 next: yellow
  assert.deepEqual(leds.get(59), [0x90, 59, 0]); // Song 3
  assert.deepEqual(leds.get(60), [0x90, 60, 0]); // no song 5
  // Group 1's colours are red and blue (the chase is an effect): blue runs.
  assert.deepEqual(leds.get(40), [0x90, 40, 5]); // row 6, column 1: red
  assert.deepEqual(leds.get(32), [0x90, 32, 1]); // row 5, column 1: blue, running
  assert.deepEqual(leds.get(24), [0x90, 24, 0]); // no colour 3
  assert.deepEqual(leds.get(41), [0x90, 41, 1]); // group 2 (smoke left out): green, running
  assert.deepEqual(leds.get(42), [0x90, 42, 0]); // no group 3
  // Buttons: Next is lit, the rest are dark.
  assert.deepEqual(leds.get(82), [0x90, 82, 1]);
  for (const n of [64, 65, 66, 71, 83, 84, 85, 86, 87, 88, 89]) assert.deepEqual(leds.get(n), [0x90, n, 0], `button ${n}`);
});

test('LEDs of the mk2: each pad in its own colour by RGB SysEx, dimmed unless on stage or running', () => {
  const leds = apcLeds('mk2', LAYOUT, STATE);
  assert.equal(leds.size, 80);
  // Song 1 on stage: its red at full. Bytes per Akai: F0 47 7F 4F 24, length 00 08, start and end pad, R G B as MSB LSB, F7.
  assert.deepEqual(leds.get(57), [0xf0, 0x47, 0x7f, 0x4f, 0x24, 0x00, 0x08, 57, 57, 0x01, 0x7f, 0, 0, 0, 0, 0xf7]);
  assert.deepEqual(leds.get(57), rgbSysex(57, 255, 0, 0));
  // Song 2 next: its blue, dim (40 %).
  assert.deepEqual(leds.get(58), rgbSysex(58, 0, 0, 102));
  // Group 1's blue runs: full; its red does not: dimmed (15 %).
  assert.deepEqual(leds.get(32), rgbSysex(32, 0, 0, 255));
  assert.deepEqual(leds.get(40), rgbSysex(40, 38, 0, 0));
  // Nothing there: off.
  assert.deepEqual(leds.get(24), rgbSysex(24, 0, 0, 0));
  assert.deepEqual(leds.get(60), rgbSysex(60, 0, 0, 0));
  // Buttons are single LEDs: 0 off, 1 on, 2 blink, on channel 1.
  assert.deepEqual(leds.get(112), [0x90, 112, 1]);
  assert.deepEqual(leds.get(117), [0x90, 117, 0]);
  assert.deepEqual(leds.get(100), [0x90, 100, 0]);
});

test('the mk2 shows pale colours as the iPad does (mixed towards cream)', () => {
  const leds = apcLeds('mk2', { ...LAYOUT, runningOrder: [{ id: 's1', swatch: '#ffffff' }] }, STATE);
  // White on stage: shown as cream, like the iPad's swatches.
  assert.deepEqual(leds.get(56), rgbSysex(56, 247, 244, 239));
});

test('button LEDs: Flash while flashing, Blackout blinks, Back to while changed, Basic lights while on stage', () => {
  const flashing = apcLeds('mk1', LAYOUT, { ...STATE, flashing: ['g2'], lookChanged: true });
  assert.deepEqual(flashing.get(64), [0x90, 64, 0]);
  assert.deepEqual(flashing.get(65), [0x90, 65, 1]); // group 2 flashing
  assert.deepEqual(flashing.get(86), [0x90, 86, 0]); // Flash all: not every group
  assert.deepEqual(flashing.get(83), [0x90, 83, 1]); // Back to
  const all = apcLeds('mk1', LAYOUT, { ...STATE, flashing: ['g1', 'g2'] });
  assert.deepEqual(all.get(86), [0x90, 86, 1]);
  const blackout = apcLeds('mk2', LAYOUT, { ...STATE, look: 'blackout', flashing: ['g1'] });
  assert.deepEqual(blackout.get(117), [0x90, 117, 2]); // Blackout blinks
  assert.deepEqual(blackout.get(100), [0x90, 100, 0]); // Flash does nothing during Blackout
  assert.deepEqual(blackout.get(112), [0x90, 112, 1]); // Next: song 2 after song 1
  const basic = apcLeds('mk1', LAYOUT, { ...STATE, look: 'safe' });
  assert.deepEqual(basic.get(85), [0x90, 85, 1]);
  assert.deepEqual(basic.get(56), [0x90, 56, 1]); // Basic lights' pad on stage
  assert.deepEqual(basic.get(57), [0x90, 57, 5]); // Song 1 next
  const end = apcLeds('mk1', LAYOUT, { ...STATE, look: 's3', lastLook: 's3' });
  assert.deepEqual(end.get(82), [0x90, 82, 0]); // Next: end of the list
});

test('only changed LEDs are sent after the first full set', () => {
  const a = apcLeds('mk1', LAYOUT, STATE);
  assert.equal(ledChanges(null, a).length, 80);
  assert.deepEqual(ledChanges(a, a), []);
  const b = apcLeds('mk1', LAYOUT, { ...STATE, look: 's2', lastLook: 's2' });
  assert.deepEqual(ledChanges(a, b), [[0x90, 57, 0], [0x90, 58, 1], [0x90, 59, 5]]);
});

test('the mk2 gets the introduction message; turning off clears every LED', () => {
  assert.deepEqual(apcIntro('mk2'), [[0xf0, 0x47, 0x7f, 0x4f, 0x60, 0x00, 0x04, 0x00, 0x00, 0x01, 0x00, 0xf7]]);
  assert.deepEqual(apcIntro('mk1'), []);
  const off = apcAllOff('mk2');
  assert.equal(off.length, 80);
  assert.deepEqual(off[0], [0x90, 0, 0]);
  assert.ok(off.some((m) => m[1] === 119 && m[2] === 0));
  assert.ok(apcAllOff('mk1').some((m) => m[1] === 89 && m[2] === 0));
});

// ---- The MIDI add-on ----

test('without the MIDI add-on: one plain line in the log, and no ports', async () => {
  const lines: string[] = [];
  const ports = await loadMidi((m) => lines.push(m), async () => { throw new Error("Cannot find package '@julusian/midi'"); });
  assert.equal(ports, null);
  assert.deepEqual(lines, ["APC mini: MIDI support isn't installed"]);
});

// ---- Through the app, with a simulated APC ----

interface Rig {
  app: App;
  midi: FakeMidi;
  lines: string[];
  layout: any;
}

async function withApc(fn: (rig: Rig) => Promise<void>, opts: { midi?: (log: (m: string) => void) => Promise<MidiPorts | null> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-'));
  const midi = new FakeMidi();
  const lines: string[] = [];
  const app = new App({
    port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' },
    log: (m) => lines.push(m), midi: opts.midi ?? (async () => midi), apcPollMs: 20, apcHoldMs: 150,
  });
  try {
    await app.start();
    const layout = await (await fetch(`http://127.0.0.1:${app.port}/api/layout`)).json();
    await fn({ app, midi, lines, layout });
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const apcStatus = async (app: App) => (await fetch(`http://127.0.0.1:${app.port}/api/apc`)).json();

test('the APC is found when plugged in, gets the full LED set, and its pads run songs and colours', () => withApc(async ({ app, midi, layout, lines }) => {
  assert.deepEqual(await apcStatus(app), { midi: true, connected: false, model: null });
  midi.plug('Launchpad Mini');
  midi.plug('MIDIIN2 (APC mini mk2)');
  midi.plug('APC mini mk2');
  const port = await waitFor(() => midi.port, 1000, 'the APC to be opened');
  assert.equal(port.name, 'APC mini mk2');
  assert.deepEqual(await apcStatus(app), { midi: true, connected: true, model: 'mk2' });
  // The introduction first, then every LED.
  await waitFor(() => port.sent.length >= 81, 1000, 'the full LED set');
  assert.deepEqual(port.sent[0], apcIntro('mk2')[0]);
  assert.equal(port.sent.length, 81);
  const order: string[] = layout.runningOrder.map((l: any) => l.id);

  // Pad for song 2 (top row, second pad).
  port.sent.length = 0;
  port.receive([0x90, 57, 127]);
  port.receive([0x80, 57, 0]);
  await waitFor(() => app.state?.look === order[1], 2000, 'song 2 on stage');
  // Only what changed is sent: never the whole set again.
  await waitFor(() => port.sent.some((m) => m[7] === 57), 1000, 'the song 2 pad to light');
  await sleep(50);
  assert.ok(port.sent.length > 0 && port.sent.length < 20, `sent ${port.sent.length} messages`);

  // Colour 2 of group 1: row 5, column 1 (note 32).
  const g1 = layout.groups[0];
  port.receive([0x90, 32, 127]);
  await waitFor(() => app.state?.groups[g1.id]?.preset === g1.presets.filter((p: any) => !p.effect)[1].id, 2000, 'colour 2 of group 1');
  // The pad of a colour that isn't there does nothing (and says so in the log).
  port.receive([0x90, 0, 127]);
  await waitFor(() => lines.some((l) => l.includes('Group 1 has no colour 6.')), 1000, 'the refusal in the log');
}));

test('scene buttons: Next, Back to, Undo, Basic lights', () => withApc(async ({ app, midi, layout }) => {
  midi.plug('APC MINI');
  const port = await waitFor(() => midi.port, 1000, 'the APC to be opened');
  const order: string[] = layout.runningOrder.map((l: any) => l.id);
  port.receive([0x90, 82, 127]); // Next
  await waitFor(() => app.state?.look === order[1], 2000, 'Next to start song 1');
  port.receive([0x90, 82, 127]);
  await waitFor(() => app.state?.look === order[2], 2000, 'Next to start song 2');
  // A colour of group 1 that the song doesn't use (column 1; colour 1 is row 6, note 40, colour 2 note 32, ...).
  const g1 = layout.groups[0];
  const colours = g1.presets.filter((p: any) => !p.effect);
  const k = colours.findIndex((p: any) => p.id !== app.state?.groups[g1.id]?.preset);
  const note = (6 - (k + 1)) * 8;
  port.receive([0x90, note, 127]);
  await waitFor(() => app.state?.lookChanged, 2000, 'the look to be changed');
  port.receive([0x90, 83, 127]); // Back to
  await waitFor(() => app.state?.lookChanged === false, 2000, 'Back to look');
  port.receive([0x90, note, 127]);
  await waitFor(() => app.state?.groups[g1.id]?.preset === colours[k].id && app.state?.lookChanged, 2000, 'the colour again');
  port.receive([0x90, 84, 127]); // Undo
  await waitFor(() => app.state?.lookChanged === false, 2000, 'Undo of the colour');
  port.receive([0x90, 85, 127]); // Basic lights
  await waitFor(() => app.state?.look === 'safe', 2000, 'Basic lights');
  // The spare buttons do nothing.
  port.receive([0x90, 88, 127]);
  port.receive([0x90, 89, 127]);
  await sleep(50);
  assert.equal(app.state?.look, 'safe');
}));

test('Flash is held while the button is down, for a group and for all', () => withApc(async ({ app, midi, layout }) => {
  midi.plug('APC MINI');
  const port = await waitFor(() => midi.port, 1000, 'the APC to be opened');
  const lights = layout.groups.filter((g: any) => g.kind !== 'smoke').map((g: any) => g.id);
  port.receive([0x90, 65, 127]); // track 2 down
  await waitFor(() => app.state?.flashing.includes(lights[1]), 2000, 'group 2 to flash');
  await waitFor(() => port.sent.some((m) => m[1] === 65 && m[2] === 1), 1000, 'the track 2 LED to light');
  const litAt = port.sent.findIndex((m) => m[1] === 65 && m[2] === 1);
  port.receive([0x80, 65, 0]);
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the flash to stop');
  await waitFor(() => port.sent.slice(litAt + 1).some((m) => m[1] === 65 && m[2] === 0), 1000, 'the LED to go out');
  // Quick taps in a row leave nothing on.
  for (let i = 0; i < 5; i++) {
    port.receive([0x90, 64, 127]);
    port.receive([0x80, 64, 0]);
  }
  await sleep(100);
  assert.deepEqual(app.state?.flashing, []);
  port.receive([0x90, 86, 127]); // Flash all
  await waitFor(() => lights.every((g: string) => app.state?.flashing.includes(g)), 2000, 'every group to flash');
  port.receive([0x90, 86, 0]);
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'Flash all to stop');
}));

test('Blackout needs a 1 s hold (here 150 ms), and its LED blinks while blacked out', () => withApc(async ({ app, midi }) => {
  midi.plug('APC MINI');
  const port = await waitFor(() => midi.port, 1000, 'the APC to be opened');
  port.receive([0x90, 82, 127]); // Next: a song on stage
  await waitFor(() => app.state?.look && app.state.look !== 'blackout', 2000, 'a song');
  port.receive([0x90, 87, 127]);
  await sleep(50);
  port.receive([0x80, 87, 0]);
  await sleep(200);
  assert.notEqual(app.state?.look, 'blackout', 'a short tap does nothing');
  port.receive([0x90, 87, 127]);
  await waitFor(() => app.state?.look === 'blackout', 2000, 'Blackout after the hold');
  port.receive([0x80, 87, 0]);
  await waitFor(() => port.sent.some((m) => m[1] === 87 && m[2] === 2), 1000, 'the Blackout LED to blink');
  // It does not toggle: another hold keeps it blacked out (as on the iPad); Next brings the lights back.
  port.receive([0x90, 82, 127]);
  await waitFor(() => app.state?.look !== 'blackout', 2000, 'Next after Blackout');
  await waitFor(() => port.sent.filter((m) => m[1] === 87).at(-1)?.[2] === 0, 1000, 'the Blackout LED to go out');
}));

test('faders: group dimmers and Master, with pickup', () => withApc(async ({ app, midi, layout }) => {
  midi.plug('APC mini mk2');
  const port = await waitFor(() => midi.port, 1000, 'the APC to be opened');
  const g1 = layout.groups[0].id;
  const level = () => app.state!.groups[g1]!.level;
  const near = (v: number) => Math.abs(level() - v) < 0.001;
  assert.equal(await app.device({ kind: 'groupLevel', group: 1, value: 0.6 }, 'test'), null);
  await waitFor(() => near(0.6), 2000, 'group 1 at 60 %');
  // Fader 1 from the bottom: nothing changes until it reaches the level.
  port.receive([0xb0, 48, 0]);
  port.receive([0xb0, 48, 13]);
  await sleep(100);
  assert.ok(near(0.6), `level ${level()}`);
  // Past the level, then down to 30 %: it follows.
  port.receive([0xb0, 48, 90]);
  await waitFor(() => near(90 / 127), 2000, 'the fader to take over');
  port.receive([0xb0, 48, 38]);
  await waitFor(() => near(38 / 127), 2000, 'group 1 at 30 %');
  // Master is at 100 % and the fader at the top: it follows at once.
  port.receive([0xb0, 56, 127]);
  port.receive([0xb0, 56, 64]);
  await waitFor(() => Math.abs(app.state!.master - 64 / 127) < 0.001, 2000, 'Master at 50 %');
  // The level is changed elsewhere (the iPad): the fader has to find it again.
  assert.equal(await app.device({ kind: 'groupLevel', group: 1, value: 0.9 }, 'test'), null);
  await waitFor(() => near(0.9), 2000, 'group 1 at 90 % from elsewhere');
  port.receive([0xb0, 48, 30]);
  await sleep(100);
  assert.ok(near(0.9), 'the fader waits for the new level');
  port.receive([0xb0, 48, 113]); // within 2 %
  await waitFor(() => near(113 / 127), 2000, 'the fader to take over again');
  // Fader 8 has no group in this show: nothing happens, nothing breaks.
  port.receive([0xb0, 55, 127]);
  port.receive([0xb0, 55, 0]);
}));

test('the mk2 introduction reply tells pickup where the faders are', () => withApc(async ({ app, midi, layout }) => {
  midi.plug('APC mini mk2');
  const port = await waitFor(() => midi.port, 1000, 'the APC to be opened');
  const g1 = layout.groups[0].id;
  assert.equal(await app.device({ kind: 'groupLevel', group: 1, value: 0.5 }, 'test'), null);
  await waitFor(() => app.state!.groups[g1]!.level === 0.5, 2000, 'group 1 at 50 %');
  // Fader 1 was at the bottom; one move past the level picks it up.
  port.receive([0xf0, 0x47, 0x7f, 0x4f, 0x61, 0x00, 0x09, 0, 0, 0, 0, 0, 0, 0, 0, 127, 0xf7]);
  port.receive([0xb0, 48, 100]);
  await waitFor(() => Math.abs(app.state!.groups[g1]!.level - 100 / 127) < 0.001, 2000, 'the fader to take over');
}));

test('unplugging releases a held Flash and turns the APC off; plugging in again starts afresh', () => withApc(async ({ app, midi, layout, lines }) => {
  midi.plug('APC mini mk2');
  const first = await waitFor(() => midi.port, 1000, 'the APC to be opened');
  const g1 = layout.groups[0].id;
  first.receive([0x90, 100, 127]); // Flash group 1, held
  await waitFor(() => app.state?.flashing.includes(g1), 2000, 'group 1 to flash');
  midi.unplug('APC mini mk2');
  await waitFor(() => first.closed, 1000, 'the port to be closed');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the Flash to stop');
  assert.deepEqual(await apcStatus(app), { midi: true, connected: false, model: null });
  assert.ok(lines.some((l) => /APC mini.*unplugged/i.test(l)), lines.join('\n'));
  midi.plug('APC MINI');
  const second = await waitFor(() => midi.port !== first && midi.port, 1000, 'the APC to be opened again');
  await waitFor(() => second.sent.length >= 80, 1000, 'the full LED set again');
  assert.equal(second.sent.length, 80);
  assert.deepEqual(await apcStatus(app), { midi: true, connected: true, model: 'mk1' });
}));

test('stopping the app turns the APC LEDs off and closes the port', async () => {
  let port: ReturnType<FakeMidi['open']> | undefined;
  await withApc(async ({ midi }) => {
    midi.plug('APC MINI');
    port = await waitFor(() => midi.port, 1000, 'the APC to be opened');
    await waitFor(() => port!.sent.length >= 80, 1000, 'the full LED set');
    port.sent.length = 0;
  });
  assert.ok(port!.closed);
  assert.equal(port!.sent.length, 80);
  assert.ok(port!.sent.every((m) => m[0] === 0x90 && m[2] === 0));
});

test('a port that fails to open is tried again, and logged once', () => withApc(async ({ midi, lines }) => {
  midi.plug('APC MINI');
  midi.failOpen = true;
  await sleep(150);
  assert.equal(lines.filter((l) => l.startsWith('APC mini: could not open')).length, 1, lines.join('\n'));
  midi.failOpen = false;
  await waitFor(() => midi.port, 1000, 'the APC to be opened at last');
}));

test('without the MIDI add-on the app runs as before', () => withApc(async ({ app, lines }) => {
  assert.equal(lines.filter((l) => l.startsWith('APC mini')).length, 1, lines.join('\n'));
  assert.ok(lines.includes("APC mini: MIDI support isn't installed"));
  assert.deepEqual(await apcStatus(app), { midi: false, connected: false, model: null });
  const settings = await (await fetch(`http://127.0.0.1:${app.port}/api/settings`)).json();
  assert.deepEqual(settings.apc, { midi: false, connected: false, model: null });
  assert.ok(app.state);
}, { midi: (log) => loadMidi(log, async () => { throw new Error('missing'); }) }));

test('an App given no MIDI ports never looks for an APC (tests and tools stay away from a real one)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-'));
  const lines: string[] = [];
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: (m) => lines.push(m) });
  try {
    await app.start();
    assert.deepEqual(await apcStatus(app), { midi: false, connected: false, model: null });
    assert.equal(lines.filter((l) => l.startsWith('APC mini')).length, 0, lines.join('\n'));
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The device Flash on/off race (from Task 1's review) ----

test('a device Flash let go before its "on" has finished leaves nothing held', () => withApc(async ({ app, layout }) => {
  const g1 = layout.groups[0].id;
  // On and off from one source, without waiting in between (a quick tap).
  const on = app.device({ kind: 'flash', group: 1, on: true }, 'x');
  const off = app.device({ kind: 'flash', group: 1, on: false }, 'x');
  assert.equal(await on, null);
  assert.equal(await off, null);
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the flash to stop');
  // Nothing of 'x' is held: another source's Flash goes out when it lets go.
  assert.equal(await app.device({ kind: 'flash', group: 1, on: true }, 'y'), null);
  await waitFor(() => app.state?.flashing.includes(g1), 2000, 'the flash from y');
  assert.equal(await app.device({ kind: 'flash', group: 1, on: false }, 'y'), null);
  await waitFor(() => app.state?.flashing.length === 0, 1000, 'y letting go to put the flash out');
}));
