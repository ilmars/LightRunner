// What a MIDI message says (a note or a control change, on which channel), and what a key is called on
// screen: "APC mini mk2 · pad 1,3", "nanoKONTROL2 · control 16". Pure.

import type { ControlKey } from '../../packages/shared/src/index.ts';
import { apcModel, apcPlace } from './apc.ts';

/** A note on or off (velocity 0 is off), or a control change with its value 0 to 1. */
export type MidiMessage =
  | { type: 'note'; channel: number; number: number; on: boolean }
  | { type: 'cc'; channel: number; number: number; value: number };

/** The note or control change in a MIDI message, or null for anything else (clock, program change, SysEx). */
export function parseMidi(bytes: readonly number[]): MidiMessage | null {
  const status = bytes[0];
  if (status === undefined || bytes.length < 3 || status >= 0xf0) return null;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const number = bytes[1]!, value = bytes[2]!;
  if (number > 127 || value > 127) return null;
  if (type === 0x90) return { type: 'note', channel, number, on: value > 0 };
  if (type === 0x80) return { type: 'note', channel, number, on: false };
  if (type === 0xb0) return { type: 'cc', channel, number, value: Math.round((value / 127) * 10000) / 10000 };
  return null;
}

/** A key's id among one device's keys. */
export const keyId = (k: Pick<ControlKey, 'type' | 'channel' | 'number'>) => `${k.type}:${k.channel}:${k.number}`;

/**
 * Where a key is on its controller: the APC mini's pads, buttons and faders by their places; on any other
 * controller "button 36" for a note and "control 16" for a control change (a fader or knob), with the
 * channel when it isn't 1.
 */
export function keyPlace(key: ControlKey): string {
  const model = apcModel(key.device);
  if (model && key.channel === 1) {
    const place = apcPlace(model, key.type, key.number);
    if (place) return place;
  }
  const what = key.type === 'note' ? `button ${key.number}` : `control ${key.number}`;
  return key.channel === 1 ? what : `${what} (channel ${key.channel})`;
}

/** A key's whole name: the device and its place. */
export function keyLabel(key: ControlKey): string {
  return `${key.device} · ${keyPlace(key)}`;
}

/** A key's place in as few characters as a small chip needs: "1,3" for an APC mini pad, "side 1", "fader 9", "36" for button 36. */
export function keyShort(key: ControlKey): string {
  const place = keyPlace(key);
  const pad = /^pad (\d,\d)$/.exec(place);
  if (pad) return pad[1]!;
  const button = /^(side|lower) button (\d)$/.exec(place);
  if (button) return `${button[1]} ${button[2]}`;
  return place.replace(/^(button|control) /, '').replace(/ \(channel (\d+)\)$/, '/$1');
}
