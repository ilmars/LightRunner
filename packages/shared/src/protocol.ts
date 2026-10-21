// Commands every input (tablet, HTTP, OSC, MIDI) turns into, and the live
// state every device receives back. The server is the single source of truth.

import { z } from 'zod';
import { EffectLayer, PaletteColour, QuickTab } from './schema.ts';

const id = z.string().min(1).max(64);
/** A #rrggbb colour. */
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const hex = z.string().regex(HEX_COLOUR);
const unit = z.number().min(0).max(1);
const fade = z.number().min(0).max(600).optional();

/** An effect as the operator page sends it: every colour a plain colour (never a palette reference), the base's too. */
export const LiveEffectLayer = EffectLayer.extend({
  colours: z.array(PaletteColour).min(1).max(6),
  base: z.object({ colour: PaletteColour, level: unit }).optional(),
});
export type LiveEffectLayer = z.infer<typeof LiveEffectLayer>;

const bpm = z.number().min(40).max(240);

/** A preset id as the stage names it: a show preset, an Any colour (`live:`), a live effect (`fx:`) or Safe/Blackout's own. */
const stagePreset = z.string().min(1).max(256);

/**
 * A whole stage to send at once (applyStage): the fields of RuntimeState it uses. Master, speed,
 * fade time and Blackout's memory may be there too (a runtime state has them) and are ignored.
 */
export const StageState = z.object({
  look: z.string().min(1).max(64).nullable(),
  groups: z.record(id, stagePreset.nullable()),
  levels: z.record(id, unit),
  tempo: bpm.optional(),
  /** The live effects `groups` names. */
  effects: z.record(stagePreset, EffectLayer).optional(),
  lastLook: id.nullable().optional(),
});
export type StageState = z.infer<typeof StageState>;

export const ManualTarget = z.union([
  z.object({ group: id }),
  z.object({ fixture: id }),
]);
export type ManualTarget = z.infer<typeof ManualTarget>;

/** Commands the engine runs (a Blind draft runs them too). */
const STAGE_COMMANDS = [
  z.object({ type: z.literal('look'), id, fade }),
  /** Set only the groups a look lists, leaving the current look and the other groups alone. */
  z.object({ type: z.literal('quickLook'), id, fade }),
  z.object({ type: z.literal('groupPreset'), group: id, preset: id, fade }),
  /**
   * Any colour: run this exact colour (with optional white, amber and UV) on a group, as a live preset.
   * `continues`: a later send of the same drag, which adds no Undo step of its own.
   */
  z.object({
    type: z.literal('groupColour'), group: id, colour: hex,
    white: unit.optional(), amber: unit.optional(), uv: unit.optional(), fade,
    continues: z.boolean().optional(),
  }),
  /**
   * Run this exact effect on a group, as a live preset (`fx:<group>:<n>`).
   * `continues`: a later send of the same drag, which adds no Undo step of its own and carries on from where the pattern is.
   */
  z.object({ type: z.literal('groupEffect'), group: id, effect: LiveEffectLayer, fade, continues: z.boolean().optional() }),
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
  /** The stage tempo in beats per minute. Effects count their speed in beats. */
  z.object({ type: z.literal('tempo'), bpm }),
  z.object({ type: z.literal('groupLevel'), group: id, value: unit }),
  z.object({ type: z.literal('undo') }),
  /** Fade time for every look and preset change; null = each look's own fade. */
  z.object({ type: z.literal('fadeTime'), value: z.number().min(0).max(600).nullable() }),
  /**
   * Fade the whole stage to this one (Blind's Go), as one Undo step: every light group's preset and level, the tempo
   * and the current look. Smoke is left alone. `fade` defaults to the operator's fade time, then each look's own.
   */
  z.object({ type: z.literal('applyStage'), stage: StageState, fade }),
] as const;

export const StageCommand = z.discriminatedUnion('type', STAGE_COMMANDS);
/** Commands the engine runs. */
export type StageCommand = z.infer<typeof StageCommand>;

export const Command = z.discriminatedUnion('type', [
  ...STAGE_COMMANDS,
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
  /**
   * Change a quick look: its name, its tab, the groups it sets (a group left out is dropped; a new one needs `fromStage`),
   * and/or with `fromStage` replace what it gives its groups with the stage as it is going (the draft in Blind).
   */
  z.object({
    type: z.literal('editQuickLook'), look: id, name: z.string().optional(), tab: QuickTab.optional(),
    groups: z.array(id).min(1).max(64).optional(), fromStage: z.boolean().optional(),
  }),
  /** Remove a quick look (and its look, unless the running order uses it). */
  z.object({ type: z.literal('deleteQuickLook'), look: id }),
  /** Move a quick look to place `to` (0 is first) among those on its tab. */
  z.object({ type: z.literal('moveQuickLook'), look: id, to: z.number().int() }),
  /** Change one group of a running-order item (a preset, an Any colour or an effect, and/or a level) without touching the stage. */
  z.object({
    type: z.literal('itemGroup'), item: id, group: id, preset: id.optional(), colour: hex.optional(),
    white: unit.optional(), amber: unit.optional(), uv: unit.optional(), effect: LiveEffectLayer.optional(), level: unit.optional(),
  }),
  /** Set a running-order item's tempo without touching the stage. */
  z.object({ type: z.literal('itemTempo'), item: id, bpm }),
  /** Copy a quick look's groups into a running-order item without touching the stage. */
  z.object({ type: z.literal('itemQuickLook'), item: id, look: id }),
  /** Keep an Any colour pick, or ＋ New colour: add it to a group's colour list, or to every group of its kind (`level` and `fade`: its brightness and fade, full and 3 s when left out). */
  z.object({
    type: z.literal('addColour'), group: id, colour: hex, name: z.string(), allGroups: z.boolean(),
    white: unit.optional(), amber: unit.optional(), uv: unit.optional(), level: unit.min(0.05).optional(), fade,
  }),
  /**
   * Change the name, colour, White, Amber and UV, brightness (`level`) and/or fade of a colour in a group's list; `sameName` also changes the
   * same-named ones of other groups. `shared`: a new colour changes the palette entry the colour points to, for every colour that uses it.
   */
  z.object({
    type: z.literal('editColour'), preset: id, name: z.string().optional(), colour: hex.optional(),
    level: unit.min(0.05).optional(), fade, white: unit.optional(), amber: unit.optional(), uv: unit.optional(),
    shared: z.boolean().optional(), sameName: z.boolean(),
  }),
  /** Remove a colour (or an effect) from a group's list (refused while a look uses it). */
  z.object({ type: z.literal('deleteColour'), preset: id }),
  /** A new effect in a group's effects list; an empty name becomes "Effect N". */
  z.object({ type: z.literal('addEffect'), group: id, name: z.string(), effect: LiveEffectLayer }),
  /** New settings for an effect in a group's list, with a new name when given (one Undo step); a name alone can go with editColour. */
  z.object({ type: z.literal('editEffect'), preset: id, effect: LiveEffectLayer, name: z.string().optional() }),
  // Blind, from a tablet's WebSocket only: the server keeps that tablet a draft copy of the stage.
  /** Make a fresh draft of the stage as it is now (again, if one is running). */
  z.object({ type: z.literal('blindStart') }),
  /** Throw the draft away. */
  z.object({ type: z.literal('blindEnd') }),
  /** Send the whole draft to the lights in one change (one Undo step), and leave Blind. */
  z.object({ type: z.literal('blindGo') }),
  /** Run a stage command on the draft instead of the stage. */
  z.object({ type: z.literal('draft'), cmd: StageCommand }),
]);
export type Command = z.infer<typeof Command>;

const SHOW_EDITS = [
  'saveItem', 'addSong', 'renameItem', 'deleteItem', 'moveItem', 'saveQuickLook', 'editQuickLook', 'deleteQuickLook', 'moveQuickLook', 'itemGroup', 'itemTempo', 'itemQuickLook',
  'addColour', 'editColour', 'deleteColour', 'addEffect', 'editEffect',
] as const;
/** Commands that change the show rather than the stage. */
export type ShowEdit = Extract<Command, { type: (typeof SHOW_EDITS)[number] }>;

export function isShowEdit(cmd: Command): cmd is ShowEdit {
  return (SHOW_EDITS as readonly string[]).includes(cmd.type);
}

const BLIND_COMMANDS = ['blindStart', 'blindEnd', 'blindGo', 'draft'] as const;
/** Blind's commands: the server runs them for the tablet that sent them. */
export type BlindCommand = Extract<Command, { type: (typeof BLIND_COMMANDS)[number] }>;

export function isBlindCommand(cmd: Command): cmd is BlindCommand {
  return (BLIND_COMMANDS as readonly string[]).includes(cmd.type);
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
  /** When the preset is an Any colour pick: its colour, white, amber and UV (0 when absent), and the colour to draw. */
  live: { colour: string; white: number; amber: number; uv: number; display: string } | null;
  /** When the group runs a live effect (groupEffect): the effect. */
  effect: EffectLayer | null;
  /** The effect the group runs is slowed by light safety (it would flash too fast at the tempo and speed asked for). */
  slowed: boolean;
  /** How long one round of that effect really takes, in seconds (light safety's slowing included); null when the group runs no effect. */
  round: number | null;
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
  /** Stage tempo in beats per minute. */
  tempo: number;
  output: OutputStatus;
  /** Why output is lost, in plain words (node not answering, another desk sending). */
  outputProblem: string | null;
  /**
   * What kind of problem, for the short label on the operator page: "other-desk" only when
   * every problem is another desk sending; anything else lost is "not-answering".
   */
  outputProblemKind: 'other-desk' | 'not-answering' | null;
}

/** What is saved to disk so a restart restores the stage as it was. */
export interface RuntimeState {
  look: string | null;
  groups: Record<string, string | null>;
  master: number;
  speed: number;
  /** Stage tempo in beats per minute; 120 when missing (older saves). */
  tempo?: number;
  levels: Record<string, number>;
  lastLook?: string | null;
  fadeTime?: number | null;
  /** Each group's preset before Blackout, so the next look restores the whole stage. */
  beforeBlackout?: Record<string, string | null>;
  /** The live effects (`fx:` ids) that `groups` or `beforeBlackout` name, so a restart runs the same effect. */
  effects?: Record<string, EffectLayer>;
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

/** A preset id that stands for "this group running this exact effect" (a live effect); `n` counts up. */
export function liveEffectId(group: string, n: number): string {
  return `fx:${group}:${n}`;
}

export function parseLiveEffect(id: string): { group: string; n: number } | null {
  const m = /^fx:([^:]+):(\d{1,15})$/.exec(id);
  return m ? { group: m[1]!, n: Number(m[2]) } : null;
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
