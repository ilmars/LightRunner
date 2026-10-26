// Types for types.js, so the tests can check it.

export type Job = 'dimmer' | 'red' | 'green' | 'blue' | 'white' | 'amber' | 'uv' | 'cct' | 'strobe' | 'other';
export interface Kelvin { min: number; max: number }
/** A channel as the show stores it (the schema's ProfileChannel). */
export interface Channel { role: Job; fine?: boolean; default?: number; kelvin?: Kelvin; name?: string }
export interface TypeLike { id: string; name: string; channels: Channel[]; gamma?: number; leds?: number; source?: { ofl: string; mode?: string } }

export interface Row {
  /** Position in the channel list of the row's coarse byte; not the rowIndex the edit functions take. */
  index: number;
  /** 1-based channel numbers; last is first + 1 when the row is 16-bit. */
  first: number;
  last: number;
  job: Job;
  label: string;
  sixteenBit: boolean;
  kelvin?: Kelvin;
  /** The fixed value, for strobe and fixed value rows. */
  value?: number;
  name?: string;
  /** 1-based segment, as the engine drives it; null for the whole light (not a colour, or a colour that appears once in a type with several segments). */
  segment: number | null;
}
export interface CompareRow { n: number; left: string | null; right: string | null; same: boolean }

export const JOBS: { job: Job; label: string }[];
export function channelRows(channels: Channel[]): Row[];
export function segmentCount(channels: Channel[]): number;
export function channelText(ch: Channel): string;
export function summary(channels: Channel[]): string;
export function compareRows(a: Channel[], b: Channel[]): CompareRow[];
export function ledsAreValid(leds: unknown): boolean;
export function validateType(name: string, channels: Channel[], leds?: number | string): string | null;

// Edits return a new list. rowIndex: the row's position in channelRows(), from 0 (a 16-bit channel is one row).
export function addChannel(channels: Channel[], job: Job): Channel[];
export function setJob(channels: Channel[], rowIndex: number, job: Job): Channel[];
export function setSixteenBit(channels: Channel[], rowIndex: number, on: boolean): Channel[];
export function setKelvin(channels: Channel[], rowIndex: number, kelvin: Kelvin): Channel[];
export function setValue(channels: Channel[], rowIndex: number, value: number | undefined): Channel[];
export function moveRow(channels: Channel[], rowIndex: number, direction: -1 | 1): Channel[];
export function removeRow(channels: Channel[], rowIndex: number): Channel[];
export function repeatLastSegment(channels: Channel[]): Channel[];

export function newTypeId(name: string, takenIds: Set<string>): string;
export function copyOf(profile: TypeLike, takenIds: Set<string>): { id: string; name: string; channels: Channel[]; gamma?: number; leds?: number };
export function isReadOnly(profile: TypeLike, builtInIds: Set<string>): boolean;
