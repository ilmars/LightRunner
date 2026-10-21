// The Akai APC mini as a lighting desk: which port it is, what its pads, buttons and faders ask for,
// fader pickup, and what its LEDs show. Pure: no timers or ports (the driver in apcdriver.ts has those).
//
// MIDI numbers from Akai's "APC mini mk2 Communications Protocol" v1.0: pads notes 0-63 (bottom left 0,
// left to right, bottom to top), track buttons 100-107, scene buttons 112-119 (top to bottom), Shift 122,
// faders CC 48-56 on channel 1. Pad LEDs: note-on, the channel sets brightness (channels 1-7 = 10 %-100 %),
// velocity a colour from a fixed palette; or any colour by the RGB SysEx (F0 47 7F 4F 24 ...). Button
// LEDs: note-on on channel 1, velocity 0 off, 1 on, 2 blink.
// The older APC mini uses the same pads and faders, track buttons 64-71, scene buttons 82-89, Shift 98;
// its pads are green, red or yellow: velocity 0 off, 1 green, 2 green blink, 3 red, 4 red blink,
// 5 yellow, 6 yellow blink.

import { colourList, lightGroups, nextItemId, stageIndexOf, type DeviceAction } from '../../packages/shared/src/devices.ts';
import { isApcMini } from '../../packages/shared/src/keys.ts';
import type { KeyTarget } from '../../packages/shared/src/schema.ts';

export type ApcModel = 'mk2' | 'mk1';

/** The model a MIDI port belongs to, or null when it is not an APC mini (not the APC40 or the APC Key 25). */
export function apcModel(name: string): ApcModel | null {
  if (!isApcMini(name)) return null;
  return /mk\s*2|mkii/i.test(name) ? 'mk2' : 'mk1';
}

/**
 * The APC mini's port among the computer's MIDI ports, or null. The mk2 has a second port for its note
 * mode ("MIDIIN2 (APC mini mk2)" on Windows, "APC mini mk2 Notes" on a Mac); the first is the one to use.
 */
export function pickApcPort(names: string[]): string | null {
  const apc = names.filter((n) => apcModel(n));
  return apc.find((n) => !/notes|midi(in|out)\d/i.test(n)) ?? apc[0] ?? null;
}

const BUTTONS: Record<ApcModel, { track: number; scene: number }> = {
  mk2: { track: 100, scene: 112 },
  mk1: { track: 64, scene: 82 },
};
const FADER_CC = 48;
const PADS = 64;

/**
 * Where a note or a control change (on channel 1) is on the APC mini, as a person reads it: pads by row and
 * column from the top left ("pad 1,1" is the top-left pad, where the running order starts), the buttons
 * under the pads and on the right counted from the left and from the top, faders 1-9. Null for anything else.
 */
export function apcPlace(model: ApcModel, type: 'note' | 'cc', number: number): string | null {
  if (type === 'cc') return number >= FADER_CC && number <= FADER_CC + 8 ? `fader ${number - FADER_CC + 1}` : null;
  const b = BUTTONS[model];
  if (number < PADS) return `pad ${8 - Math.floor(number / 8)},${(number % 8) + 1}`;
  if (number >= b.track && number < b.track + 8) return `lower button ${number - b.track + 1}`;
  if (number >= b.scene && number < b.scene + 8) return `side button ${number - b.scene + 1}`;
  return null;
}

/** The control change of fader 1-9. */
export const apcFaderCc = (fader: number) => FADER_CC + fader - 1;

/** Row 1 is the bottom row, column 1 the left one. */
export type ApcControl =
  | { kind: 'pad'; row: number; col: number }
  | { kind: 'track'; n: number }
  | { kind: 'scene'; n: number };

export type ApcInput =
  | { kind: 'press' | 'release'; control: ApcControl }
  /** A fader moved: 1-8 under the pads, 9 is Master; value 0 to 1. */
  | { kind: 'fader'; fader: number; value: number }
  /** Where all nine faders are, from the mk2's reply to the introduction. */
  | { kind: 'faders'; values: number[] };

/** A fader position 0-127 as 0 to 1, to 4 places. */
const unit = (v: number) => Math.round((v / 127) * 10000) / 10000;

/** What one MIDI message from the APC means, or null for anything it doesn't use. */
export function parseApc(model: ApcModel, bytes: readonly number[]): ApcInput | null {
  const status = bytes[0];
  if (status === undefined) return null;
  if (status === 0xf0) {
    // F0 47 <id> 4F 61 <len> <len> <nine fader positions> F7
    if (bytes[1] !== 0x47 || bytes[3] !== 0x4f || bytes[4] !== 0x61) return null;
    const values = bytes.slice(7, 16);
    if (values.length < 9 || values.some((v) => v > 127)) return null;
    return { kind: 'faders', values: values.map(unit) };
  }
  if (bytes.length < 3) return null;
  const type = status & 0xf0;
  const [, d1, d2] = bytes as [number, number, number];
  if (type === 0xb0) {
    const fader = d1 - FADER_CC + 1;
    return fader >= 1 && fader <= 9 ? { kind: 'fader', fader, value: unit(d2) } : null;
  }
  if (type !== 0x90 && type !== 0x80) return null;
  const kind = type === 0x90 && d2 > 0 ? 'press' : 'release';
  const b = BUTTONS[model];
  let control: ApcControl | null = null;
  if (d1 < PADS) control = { kind: 'pad', row: Math.floor(d1 / 8) + 1, col: (d1 % 8) + 1 };
  else if (d1 >= b.track && d1 < b.track + 8) control = { kind: 'track', n: d1 - b.track + 1 };
  else if (d1 >= b.scene && d1 < b.scene + 8) control = { kind: 'scene', n: d1 - b.scene + 1 };
  return control ? { kind, control } : null;
}

/** What a press (on) or a release asks for: a device action, the Blackout hold starting or ending, or nothing. */
export type ApcIntent = { action: DeviceAction } | { blackoutHold: boolean } | null;

/**
 * Pads: the top two rows are the running order (top row items 1-8, the next 9-16); below, column N is
 * group N's colours, colour 1 at the top (row 6) down to colour 6 (row 1). Track button N flashes group N
 * while held. Scene buttons, top to bottom: Next, Back to, Undo, Basic lights, Flash all (held),
 * Blackout (held 1 s), and two spare.
 */
export function buttonIntent(control: ApcControl, on: boolean): ApcIntent {
  switch (control.kind) {
    case 'pad':
      if (!on) return null;
      if (control.row >= 7) return { action: { kind: 'item', n: (8 - control.row) * 8 + control.col } };
      return { action: { kind: 'groupColour', group: control.col, colour: 7 - control.row } };
    case 'track':
      return { action: { kind: 'flash', group: control.n, on } };
    case 'scene':
      switch (control.n) {
        case 5: return { action: { kind: 'flash', group: 'all', on } };
        case 6: return { blackoutHold: on };
      }
      if (!on) return null;
      switch (control.n) {
        case 1: return { action: { kind: 'next' } };
        case 2: return { action: { kind: 'backToLook' } };
        case 3: return { action: { kind: 'undo' } };
        case 4: return { action: { kind: 'basic' } };
      }
      return null;
  }
}

/** Faders 1-8 are the group dimmers, 9 is Master. */
export function faderAction(fader: number, value: number): DeviceAction {
  return fader === 9 ? { kind: 'master', value } : { kind: 'groupLevel', group: fader, value };
}

// ---- Pickup ----

/** A fader this close to the level takes it over; a change from elsewhere bigger than this lets go of it. */
const NEAR = 0.02;
/** How long (s) a level a fader sent may take to come back in the state. */
const SENT_KEPT = 2;
/** The state gives back a sent level exactly (both are kept to 4 places). */
const SAME = 0.00005;

/**
 * A fader only takes over once it reaches the level it controls (passes it, or comes within 2 %), so moving
 * it never makes a light jump. It then follows until the level is changed from elsewhere (a look, the iPad)
 * by more than 2 %, or another look starts, and then waits for the fader to reach it again. Times are in seconds.
 */
export class Pickup {
  private readonly faders = new Map<number | string, { caught: boolean; pos: number | null; sent: { value: number; at: number }[] }>();

  /** Is this fader following its level now? */
  caught(n: number | string): boolean {
    return this.faders.get(n)?.caught ?? false;
  }

  /** The fader now controls something else: it waits to reach that level (where it is is kept). */
  forget(n: number | string): void {
    const f = this.faders.get(n);
    if (!f) return;
    f.caught = false;
    f.sent = [];
  }

  private fader(n: number | string) {
    let f = this.faders.get(n);
    if (!f) this.faders.set(n, (f = { caught: false, pos: null, sent: [] }));
    return f;
  }

  /** Where a fader is, as the APC reported it, without moving anything. */
  place(n: number | string, value: number): void {
    const f = this.fader(n);
    if (!f.caught) f.pos = value;
  }

  /** The fader moved to `value`; `level` is what it controls now. The level to send, or null while it waits. */
  move(n: number | string, value: number, level: number, now: number): number | null {
    const f = this.fader(n);
    if (!f.caught) {
      const near = Math.abs(value - level) <= NEAR;
      const crossed = f.pos !== null && (f.pos - level) * (value - level) <= 0;
      f.pos = value;
      if (!near && !crossed) return null;
      f.caught = true;
    }
    f.pos = value;
    f.sent = f.sent.filter((s) => now - s.at <= SENT_KEPT).slice(-50);
    f.sent.push({ value, at: now });
    return value;
  }

  /**
   * The level the fader controls, from the live state. A level it didn't send itself lets go of it. Its own
   * levels come back in the order it sent them, so one coming back means the ones sent before it are done:
   * a look that later sets a level the fader passed on its way is still a change from elsewhere.
   */
  level(n: number | string, level: number, now: number): void {
    const f = this.faders.get(n);
    if (!f?.caught) return;
    f.sent = f.sent.filter((s) => now - s.at <= SENT_KEPT);
    const echo = f.sent.findIndex((s) => Math.abs(s.value - level) < SAME);
    if (echo >= 0) {
      f.sent = f.sent.slice(echo + 1);
      return;
    }
    // Within 2 % of where the fader is (a small change from elsewhere): it keeps following.
    if (f.pos !== null && Math.abs(f.pos - level) <= NEAR) return;
    f.caught = false;
    f.sent = [];
  }

  /** Another look started: every fader waits to reach its level again. */
  rearm(): void {
    for (const f of this.faders.values()) {
      f.caught = false;
      f.sent = [];
    }
  }
}

// ---- LEDs ----

/** The part of the operator layout the LEDs show. */
export interface ApcLayout {
  basicLights: string | null;
  basicSwatch: string;
  runningOrder: { id: string; swatch: string | null }[];
  groups: { id: string; kind?: string; presets: { id: string; swatch: string | null; effect?: unknown }[] }[];
  /** The quick looks: the groups each sets and what it gives them (`entries` in the order of `groups` above). */
  quickLooks?: { id: string; swatch: string | null; groups: string[]; entries: ({ preset: string } | null)[] }[];
}

/**
 * What the LEDs show besides the stage: the standard layout (on unless switched off), and the keys assigned
 * on this APC (notes on channel 1), which win over the standard layout for their pad or button.
 */
export interface ApcLedOptions {
  standard?: boolean;
  keys?: { number: number; does: KeyTarget }[];
}

/** The stage runs what this quick look gives every group it sets (not during Blackout). */
export function quickLookShown(layout: Pick<ApcLayout, 'groups' | 'quickLooks'>, state: Pick<ApcState, 'look' | 'groups'>, id: string): boolean {
  const q = layout.quickLooks?.find((x) => x.id === id);
  if (!q || state.look === 'blackout') return false;
  let any = false;
  for (const g of q.groups) {
    const entry = q.entries[layout.groups.findIndex((x) => x.id === g)];
    if (!entry) continue;
    if (state.groups[g]?.preset !== entry.preset) return false;
    any = true;
  }
  return any;
}

/** The part of the live state the LEDs show. */
export interface ApcState {
  look: string | null;
  lastLook: string | null;
  lookChanged: boolean;
  canUndo: boolean;
  master: number;
  groups: Record<string, { preset: string | null; level: number } | undefined>;
  flashing: string[];
}

/** The message that sets each LED, by note number. */
export type ApcLeds = Map<number, number[]>;

const OFF = 0;
const ON = 1;
const BLINK = 2;
const GREEN = 1;
const YELLOW = 5;

/** mk2 brightness: the item on stage and the running colour are full; the rest are dimmed. */
const STAGE = 1;
const NEXT = 0.4;
const ITEM = 0.1;
const COLOUR = 0.15;
/** A colour the pages draw without a swatch of its own. */
const NEUTRAL = '#5a5f69';
/** "Off" is drawn dark grey rather than black, so its pad can still be seen. */
const OFF_SHOWN: [number, number, number] = [90, 90, 90];
/** The pages mix pale colours towards cream (web/operator/app.js), so whites read as warm light. */
const CREAM = [241, 236, 228];

/** A swatch as the iPad draws it, as 0-255 red, green and blue. */
function shownRgb(hex: string | null): [number, number, number] {
  const n = hex && /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : parseInt(NEUTRAL.slice(1), 16);
  const rgb: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(...rgb);
  if (max <= 0) return OFF_SHOWN;
  const chroma = (max - Math.min(...rgb)) / max;
  if (chroma >= 0.65) return rgb;
  const k = max / 255;
  return rgb.map((v, i) => Math.round(((v / k) * 0.4 + CREAM[i]! * 0.6) * k)) as [number, number, number];
}

/** The mk2's RGB SysEx for one pad: each of red, green and blue (0-255) as two 7-bit bytes. */
export function rgbSysex(pad: number, r: number, g: number, b: number): number[] {
  const two = (v: number) => [(v >> 7) & 1, v & 0x7f];
  return [0xf0, 0x47, 0x7f, 0x4f, 0x24, 0x00, 0x08, pad, pad, ...two(r), ...two(g), ...two(b), 0xf7];
}

const note = (n: number, velocity: number) => [0x90, n, velocity];

/** Every LED for this layout and stage. */
export function apcLeds(model: ApcModel, layout: ApcLayout, state: ApcState, opts: ApcLedOptions = {}): ApcLeds {
  const leds: ApcLeds = new Map();
  const standard = opts.standard ?? true;
  /** A pad: off, or (mk2) its swatch at a brightness, or (older model) green or yellow. */
  const pad = (n: number, lit: { swatch: string | null; level: number; mk1: number } | null) => {
    if (model === 'mk1') return leds.set(n, note(n, lit?.mk1 ?? OFF));
    if (!lit) return leds.set(n, rgbSysex(n, 0, 0, 0));
    const [r, g, b] = shownRgb(lit.swatch).map((v) => Math.round(v * lit.level)) as [number, number, number];
    return leds.set(n, rgbSysex(n, r, g, b));
  };

  // A running-order item: bright on stage, dim when next, low otherwise.
  const onStage = stageIndexOf(layout, state);
  const nextId = nextItemId(layout, state);
  const songPad = (n: number, k: number) => {
    const item = layout.runningOrder[k];
    if (!item) return pad(n, null);
    const swatch = item.swatch ?? (item.id === layout.basicLights ? layout.basicSwatch : null);
    if (k === onStage) return pad(n, { swatch, level: STAGE, mk1: GREEN });
    if (item.id === nextId) return pad(n, { swatch, level: NEXT, mk1: YELLOW });
    return pad(n, { swatch, level: ITEM, mk1: OFF });
  };

  // Without the standard layout, every pad and button is dark unless a key is assigned to it.
  if (!standard) {
    for (const msg of apcAllOff(model)) {
      if (model === 'mk2' && msg[1]! < PADS) pad(msg[1]!, null);
      else leds.set(msg[1]!, msg);
    }
    return assignedLeds(model, layout, state, opts.keys ?? [], leds, pad, songPad);
  }

  // Running order: the top row, then the row below.
  for (let k = 0; k < 16; k++) songPad(k < 8 ? 56 + k : 48 + (k - 8), k);

  // Colours: column N is group N, colour 1 at the top of the block.
  const groups = lightGroups(layout);
  for (let col = 0; col < 8; col++) {
    const group = groups[col];
    const colours = group ? colourList(group) : [];
    const running = group ? state.groups[group.id]?.preset : null;
    for (let c = 0; c < 6; c++) {
      const n = (5 - c) * 8 + col;
      const colour = colours[c];
      if (!colour) pad(n, null);
      else if (colour.id === running) pad(n, { swatch: colour.swatch, level: STAGE, mk1: GREEN });
      else pad(n, { swatch: colour.swatch, level: COLOUR, mk1: YELLOW });
    }
  }

  // Buttons. Flash does nothing during Blackout (the iPad shows none then either).
  const b = BUTTONS[model];
  const blackedOut = state.look === 'blackout';
  const flashing = (id: string) => !blackedOut && state.flashing.includes(id);
  for (let k = 0; k < 8; k++) {
    const group = groups[k];
    leds.set(b.track + k, note(b.track + k, group && flashing(group.id) ? ON : OFF));
  }
  const scene = [
    nextId !== null ? ON : OFF,
    state.lookChanged ? ON : OFF,
    OFF, // Undo
    state.look === 'safe' ? ON : OFF,
    groups.length > 0 && groups.every((g) => flashing(g.id)) ? ON : OFF,
    blackedOut ? BLINK : OFF,
    OFF,
    OFF,
  ];
  scene.forEach((v, k) => leds.set(b.scene + k, note(b.scene + k, v)));
  return assignedLeds(model, layout, state, opts.keys ?? [], leds, pad, songPad);
}

type PadLit = { swatch: string | null; level: number; mk1: number } | null;

/**
 * The pads and buttons that have keys of their own. A song lights like a running-order pad, a quick look when
 * the stage matches it; anything else on a pad is a low neutral. A button lights for a song on stage, a quick
 * look on stage, a group flashing, or (blinking) Blackout.
 */
function assignedLeds(
  model: ApcModel, layout: ApcLayout, state: ApcState, keys: { number: number; does: KeyTarget }[], leds: ApcLeds,
  pad: (n: number, lit: PadLit) => unknown, songPad: (n: number, k: number) => unknown,
): ApcLeds {
  const b = BUTTONS[model];
  const blackedOut = state.look === 'blackout';
  const onStage = stageIndexOf(layout, state);
  for (const { number: n, does } of keys) {
    const isPad = n < PADS;
    const isButton = (n >= b.track && n < b.track + 8) || (n >= b.scene && n < b.scene + 8);
    if (!isPad && !isButton) continue;
    const songAt = does.kind === 'song' ? layout.runningOrder.findIndex((i) => i.id === does.id) : -1;
    if (isPad) {
      if (does.kind === 'song') songPad(n, songAt < 0 ? layout.runningOrder.length : songAt);
      else if (does.kind === 'quickLook') {
        const q = layout.quickLooks?.find((x) => x.id === does.id);
        if (!q) pad(n, null);
        else if (quickLookShown(layout, state, q.id)) pad(n, { swatch: q.swatch, level: STAGE, mk1: GREEN });
        else pad(n, { swatch: q.swatch, level: ITEM, mk1: OFF });
      } else pad(n, { swatch: NEUTRAL, level: ITEM, mk1: OFF });
      continue;
    }
    let v = OFF;
    if (does.kind === 'song') v = songAt >= 0 && songAt === onStage ? ON : OFF;
    else if (does.kind === 'quickLook') v = quickLookShown(layout, state, does.id) ? ON : OFF;
    else if (does.kind === 'flash') v = !blackedOut && state.flashing.includes(does.group) ? ON : OFF;
    else if (does.kind === 'flashAll') {
      const groups = lightGroups(layout);
      v = !blackedOut && groups.length > 0 && groups.every((g) => state.flashing.includes(g.id)) ? ON : OFF;
    } else if (does.kind === 'blackout') v = blackedOut ? BLINK : OFF;
    leds.set(n, note(n, v));
  }
  return leds;
}

/** The messages for the LEDs that differ from what was sent before (all of them when nothing was). */
export function ledChanges(before: ApcLeds | null, after: ApcLeds): number[][] {
  const out: number[][] = [];
  for (const [n, msg] of after) {
    const was = before?.get(n);
    if (!was || was.length !== msg.length || was.some((v, i) => v !== msg[i])) out.push(msg);
  }
  return out;
}

/**
 * What to send first. The mk2 wants its introduction before anything else (Akai's protocol): application 0,
 * version 0.1.0. It answers with where its faders are.
 */
export function apcIntro(model: ApcModel): number[][] {
  return model === 'mk2' ? [[0xf0, 0x47, 0x7f, 0x4f, 0x60, 0x00, 0x04, 0x00, 0x00, 0x01, 0x00, 0xf7]] : [];
}

/** Every LED off, for when Light Runner lets go of the APC. */
export function apcAllOff(model: ApcModel): number[][] {
  const b = BUTTONS[model];
  const notes = [...Array(PADS).keys(), ...[...Array(8).keys()].map((k) => b.track + k), ...[...Array(8).keys()].map((k) => b.scene + k)];
  return notes.map((n) => note(n, 0));
}
