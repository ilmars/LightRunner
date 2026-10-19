// Commands every input (tablet, HTTP, OSC, MIDI) turns into, and the live
// state every device receives back. The server is the single source of truth.

import { z } from 'zod';
import { QuickTab } from './schema.ts';

const id = z.string().min(1).max(64);
/** A #rrggbb colour. */
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const hex = z.string().regex(HEX_COLOUR);
const unit = z.number().min(0).max(1);
const fade = z.number().min(0).max(600).optional();

export const ManualTarget = z.union([
  z.object({ group: id }),
  z.object({ fixture: id }),
]);
export type ManualTarget = z.infer<typeof ManualTarget>;

export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('look'), id, fade }),
  /** Set only the groups a look lists, leaving the current look and the other groups alone. */
  z.object({ type: z.literal('quickLook'), id, fade }),
  z.object({ type: z.literal('groupPreset'), group: id, preset: id, fade }),
  /** Any colour: run this exact colour on a group, as a live preset. */
  z.object({ type: z.literal('groupColour'), group: id, colour: hex, fade }),
  /** Hold the groups at full white while `on`; snaps, and is not saved or undone. */
  z.object({ type: z.literal('flash'), groups: z.array(id).max(64), on: z.boolean() }),
  z.object({ type: z.literal('manual'), target: ManualTarget, colour: hex.optional(), intensity: unit.optional() }),
  z.object({ type: z.literal('release'), target: ManualTarget }),
  z.object({ type: z.literal('releaseAll') }),
  z.object({ type: z.literal('backToLook') }),
  z.object({ type: z.literal('safe') }),
  z.object({ type: z.literal('blackout') }),
  z.object({ type: z.literal('master'), value: unit }),
  z.object({ type: z.literal('speed'), value: z.number().min(0.5).max(2) }),
  z.object({ type: z.literal('groupLevel'), group: id, value: unit }),
  z.object({ type: z.literal('undo') }),
  /** Fade time for every look and preset change; null = each look's own fade. */
  z.object({ type: z.literal('fadeTime'), value: z.number().min(0).max(600).nullable() }),
  // Edits to the show from the operator page. The server handles these itself; the engine never sees them.
  /** Store the stage (where it is going) in a running-order item. */
  z.object({ type: z.literal('saveItem'), id }),
  /** A new song holding the stage, right after `after`. */
  z.object({ type: z.literal('addSong'), after: id }),
  z.object({ type: z.literal('renameItem'), id, name: z.string() }),
  z.object({ type: z.literal('deleteItem'), id }),
  /** Move a running-order item to position `to` (0 is Basic lights). */
  z.object({ type: z.literal('moveItem'), id, to: z.number().int() }),
  /** A new quick look from the chosen groups of the stage. */
  z.object({ type: z.literal('saveQuickLook'), name: z.string(), tab: QuickTab, groups: z.array(id).min(1).max(64) }),
  /** Keep an Any colour pick: add it to a group's colour list, or to every group of its kind. */
  z.object({ type: z.literal('addColour'), group: id, colour: hex, name: z.string(), allGroups: z.boolean() }),
]);
export type Command = z.infer<typeof Command>;

const SHOW_EDITS = ['saveItem', 'addSong', 'renameItem', 'deleteItem', 'moveItem', 'saveQuickLook', 'addColour'] as const;
/** Commands that change the show rather than the stage. */
export type ShowEdit = Extract<Command, { type: (typeof SHOW_EDITS)[number] }>;
/** Commands the engine runs. */
export type StageCommand = Exclude<Command, ShowEdit>;

export function isShowEdit(cmd: Command): cmd is ShowEdit {
  return (SHOW_EDITS as readonly string[]).includes(cmd.type);
}

/** Commands that need manual control rights. */
export function isManualCommand(cmd: Command): boolean {
  return cmd.type === 'manual' || cmd.type === 'release' || cmd.type === 'releaseAll';
}

export interface GroupStatus {
  /** Preset the group is running or fading into; null if it has never been set. */
  preset: string | null;
  /** Differs from the current look's preset for this group. */
  changed: boolean;
  /** Under manual control. */
  manual: boolean;
  /** Fade progress 0..1, 1 when settled. */
  progress: number;
  level: number;
}

export type OutputStatus = 'ok' | 'lost' | 'off';

export interface LiveState {
  /** Current look id, or "safe" / "blackout". Null before the first look. */
  look: string | null;
  /** Progress of the latest look fade, 1 when settled. */
  lookProgress: number;
  /** Seconds left in the latest look fade, 0 when settled. */
  lookFadeLeft: number;
  /** The last real look (not Safe or Blackout), for the Next button. */
  lastLook: string | null;
  /** A group the current look lists runs another preset or level than the look says. */
  lookChanged: boolean;
  /** Undo has something to go back to. */
  canUndo: boolean;
  /** Fade time chosen on the operator page, or null for each look's own fade. */
  fadeTime: number | null;
  groups: Record<string, GroupStatus>;
  fixturesManual: string[];
  /** Groups being flashed (full white) right now. */
  flashing: string[];
  master: number;
  speed: number;
  output: OutputStatus;
  /** Why output is lost, in plain words (node not answering, another desk sending). */
  outputProblem: string | null;
}

/** What is saved to disk so a restart restores the stage as it was. */
export interface RuntimeState {
  look: string | null;
  groups: Record<string, string | null>;
  master: number;
  speed: number;
  levels: Record<string, number>;
  lastLook?: string | null;
  fadeTime?: number | null;
  /** Each group's preset before Blackout, so the next look restores the whole stage. */
  beforeBlackout?: Record<string, string | null>;
}

export const SAFE = 'safe';
export const BLACKOUT = 'blackout';

/** Preset ids the engine gives its own Safe light and Blackout. They are never in a show. */
export const SAFE_PRESET = '__safe';
export const BLACKOUT_PRESET = '__blackout';
/** Safe's fixed warm white stage wash, as Basic lights shows it. The engine builds its light from this. */
export const SAFE_LIGHT = { hex: '#ffd2a0', white: 0.5, intensity: 0.8 } as const;

/**
 * A preset id that stands for "this group in this exact colour" (the Any colour
 * pick). It is not a preset in the show; Save turns it into a custom one.
 */
export function livePresetId(group: string, colour: string): string {
  return `live:${group}:${colour.toLowerCase()}`;
}

export function parseLivePreset(id: string): { group: string; colour: string } | null {
  const m = /^live:([^:]+):(#[0-9a-f]{6})$/.exec(id);
  return m ? { group: m[1]!, colour: m[2]! } : null;
}
