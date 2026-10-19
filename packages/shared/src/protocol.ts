// Commands every input (tablet, HTTP, OSC, MIDI) turns into, and the live
// state every device receives back. The server is the single source of truth.

import { z } from 'zod';

const id = z.string().min(1).max(64);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const unit = z.number().min(0).max(1);
const fade = z.number().min(0).max(600).optional();

export const ManualTarget = z.union([
  z.object({ group: id }),
  z.object({ fixture: id }),
]);
export type ManualTarget = z.infer<typeof ManualTarget>;

export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('look'), id, fade }),
  z.object({ type: z.literal('groupPreset'), group: id, preset: id, fade }),
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
]);
export type Command = z.infer<typeof Command>;

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
  /** Undo has something to go back to. */
  canUndo: boolean;
  /** Fade time chosen on the operator page, or null for each look's own fade. */
  fadeTime: number | null;
  groups: Record<string, GroupStatus>;
  fixturesManual: string[];
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
