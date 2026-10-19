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
  /** Any colour: run this exact colour (with optional white, amber and UV) on a group, as a live preset. */
  z.object({
    type: z.literal('groupColour'), group: id, colour: hex,
    white: unit.optional(), amber: unit.optional(), uv: unit.optional(), fade,
  }),
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
]);
export type Command = z.infer<typeof Command>;

const SHOW_EDITS = ['saveItem', 'addSong', 'renameItem', 'deleteItem', 'moveItem', 'saveQuickLook'] as const;
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

/** White, amber and UV levels (0..1) that go with a colour. */
export interface ColourExtras {
  white?: number;
  amber?: number;
  uv?: number;
}

/** A live colour: the group, its #rrggbb colour and any white, amber and UV (only those above 0 are set). */
export interface LiveColour extends ColourExtras {
  group: string;
  colour: string;
}

const EXTRA_PARTS = [['white', 'w'], ['amber', 'a'], ['uv', 'u']] as const;

/** A level 0..1 as a whole percentage, the way live preset ids carry it. */
const percent = (v: number | undefined) => Math.round(Math.min(1, Math.max(0, v ?? 0)) * 100);

/**
 * A preset id that stands for "this group in this exact colour" (the Any colour
 * pick). It is not a preset in the show; Save turns it into a custom one.
 * White, amber and UV follow as whole percentages, leaving out the ones at 0:
 * `live:key-lights:#ff0000:w40:a20`. Without them it is `live:<group>:<#hex>`, as it always was.
 */
export function livePresetId(group: string, colour: string, extras: ColourExtras = {}): string {
  let id = `live:${group}:${colour.toLowerCase()}`;
  for (const [name, letter] of EXTRA_PARTS) {
    const p = percent(extras[name]);
    if (p > 0) id += `:${letter}${p}`;
  }
  return id;
}

/**
 * A #rrggbb colour to show for a colour with white, amber and UV, as the
 * visualiser draws them: white adds to all three, amber (about #ffbf00) to red
 * and green, UV a faint violet; scaled back if a channel goes over full.
 */
export function displayColour(colour: string, extras: ColourExtras = {}): string {
  const w = extras.white ?? 0, a = extras.amber ?? 0, u = extras.uv ?? 0;
  if (!w && !a && !u) return colour.toLowerCase();
  const n = parseInt(colour.slice(1), 16);
  const rgb = [
    ((n >> 16) & 255) / 255 + w + a + 0.25 * u,
    ((n >> 8) & 255) / 255 + w + (0xbf / 255) * a,
    (n & 255) / 255 + w + 0.4 * u,
  ];
  const scale = 1 / Math.max(1, ...rgb);
  return `#${rgb.map((c) => Math.round(c * scale * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function parseLivePreset(id: string): LiveColour | null {
  const m = /^live:([^:]+):(#[0-9a-f]{6})(?::w(\d{1,3}))?(?::a(\d{1,3}))?(?::u(\d{1,3}))?$/.exec(id);
  if (!m) return null;
  const out: LiveColour = { group: m[1]!, colour: m[2]! };
  for (let k = 0; k < EXTRA_PARTS.length; k++) {
    const part = m[3 + k];
    if (part === undefined) continue;
    const p = Number(part);
    if (p > 100) return null;
    if (p > 0) out[EXTRA_PARTS[k]![0]] = p / 100;
  }
  return out;
}
