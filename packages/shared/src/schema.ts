// The show document and everything inside it. A whole show is one JSON file.
// Looks point to group presets, and presets point to groups and colours,
// never to DMX channels, so re-patching a fixture never breaks a look.

import { z } from 'zod';
import { BUILT_IN_PROFILES } from './profiles.ts';
import { routeProblems } from './routing.ts';

export const SCHEMA_VERSION = 1;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lowercase letters, digits and dashes');
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colours are #rrggbb');
const unit = z.number().min(0).max(1);
const seconds = z.number().min(0).max(600);

// ---- Fixture profiles ----

export const ChannelRole = z.enum([
  'dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'cct', 'strobe', 'other',
]);
export type ChannelRole = z.infer<typeof ChannelRole>;

export const ProfileChannel = z.object({
  role: ChannelRole,
  // The fine byte of a 16-bit pair. It must follow the coarse channel of the same role.
  fine: z.boolean().optional(),
  // Fixed value for channels the engine does not drive (strobe open, mode, ...).
  default: z.number().int().min(0).max(255).optional(),
  // Colour temperature range of a "cct" channel: DMX 0 = min, 255 = max.
  kelvin: z.object({ min: z.number().min(1000), max: z.number().max(20000) }).optional(),
  name: z.string().optional(),
});
export type ProfileChannel = z.infer<typeof ProfileChannel>;

export const Profile = z.object({
  id,
  name: z.string(),
  channels: z.array(ProfileChannel).min(1).max(512),
  gamma: z.number().min(1).max(4).optional(),
  /** Where the definition came from, e.g. { ofl: 'stairville/sonicpulse-led-bar-10', mode: '39-channel' }. */
  source: z.object({ ofl: z.string(), mode: z.string() }).optional(),
});
export type Profile = z.infer<typeof Profile>;

// ---- Patch, groups, palettes ----

export const Fixture = z.object({
  id,
  name: z.string(),
  profile: id,
  universe: z.number().int().min(0).max(32767),
  address: z.number().int().min(1).max(512),
  x: unit.default(0.5),
  y: unit.default(0.5),
  // Size on the stage plan as a fraction of its width and height; bars draw as bars.
  w: unit.optional(),
  h: unit.optional(),
  gamma: z.number().min(1).max(4).optional(),
  /** Hung the other way round: its segments run backwards along a group's line. */
  reversed: z.boolean().optional(),
});
export type Fixture = z.infer<typeof Fixture>;

/**
 * What a group drives. A smoke group is a smoke or haze machine: only its own
 * level and Puff turn it on, never looks, Basic lights or Flash All.
 */
export const GroupKind = z.enum(['light', 'smoke']);
export type GroupKind = z.infer<typeof GroupKind>;

export const Group = z.object({
  id,
  name: z.string(),
  kind: GroupKind.default('light'),
  // Order matters: waves and chases travel along it.
  fixtures: z.array(id),
});
export type Group = z.infer<typeof Group>;

export const PaletteColour = z.object({
  hex,
  white: unit.optional(),
  amber: unit.optional(),
  uv: unit.optional(),
});
export type PaletteColour = z.infer<typeof PaletteColour>;

export const Palette = z.object({
  id,
  name: z.string(),
  colours: z.array(PaletteColour).min(1).max(16),
});
export type Palette = z.infer<typeof Palette>;

// ---- Presets and layers ----

export const ColourSpec = z.union([
  PaletteColour,
  z.object({ palette: id, index: z.number().int().min(0) }),
]);
export type ColourSpec = z.infer<typeof ColourSpec>;

/** The colour a spec stands for, looking palette colours up (white if the palette or colour is missing). */
export function resolveColour(c: ColourSpec, palettes: ReadonlyMap<string, Palette>): PaletteColour {
  if (!('palette' in c)) return c;
  return palettes.get(c.palette)?.colours[c.index] ?? { hex: '#ffffff' };
}

export const StaticLayer = z.object({
  kind: z.literal('static'),
  colour: ColourSpec,
  intensity: unit.default(1),
});
export type StaticLayer = z.infer<typeof StaticLayer>;

/** The patterns an effect layer can run. */
export const EffectKind = z.enum(['colourFade', 'wave', 'chase', 'sparkle', 'breathe', 'meteor', 'fill', 'yoyo']);
export type EffectKind = z.infer<typeof EffectKind>;

/** How long one cycle takes: in beats of the stage tempo, or free-running in seconds. */
export const EffectSpeed = z.union([z.object({ beats: z.number().min(0.25).max(64) }), z.object({ seconds: z.number().min(0.25).max(600) })]);
export type EffectSpeed = z.infer<typeof EffectSpeed>;

/** A colour under an effect's animation: it shows at `level` where the animation is dark. */
export const EffectBase = z.object({ colour: ColourSpec, level: unit });
export type EffectBase = z.infer<typeof EffectBase>;

/** A moving pattern along the group's line of segments, made from a list of colours, perhaps over a base colour. */
export const EffectLayer = z.object({
  kind: z.literal('effect'),
  effect: EffectKind,
  colours: z.array(ColourSpec).min(1).max(6),
  speed: EffectSpeed,
  direction: z.enum(['ltr', 'rtl', 'centreOut', 'outsideIn']).default('ltr'),
  waves: z.number().int().min(1).max(16).default(1),
  size: unit.default(0.5),
  edge: z.enum(['soft', 'hard']).default('soft'),
  intensity: unit.default(1),
  /** A colour under the animation (none when missing). */
  base: EffectBase.optional(),
});
export type EffectLayer = z.infer<typeof EffectLayer>;

export const Layer = z.discriminatedUnion('kind', [StaticLayer, EffectLayer]);
export type Layer = z.infer<typeof Layer>;

export const Preset = z.object({
  id,
  name: z.string(),
  group: id,
  layers: z.array(Layer).min(1).max(8),
  fade: seconds.default(3),
  swatch: hex.optional(),
  /** Made by Save from an "Any colour" pick; never shown as a swatch. */
  custom: z.boolean().optional(),
});
export type Preset = z.infer<typeof Preset>;

/**
 * A key that is the same for two effect layers exactly when they run the same: every setting,
 * the colours in order and the base (a hex in any case; a palette colour by reference).
 */
export function effectKey(l: EffectLayer): string {
  const colour = (c: ColourSpec) => ('palette' in c ? [c.palette, c.index] : [c.hex.toLowerCase(), c.white ?? 0, c.amber ?? 0, c.uv ?? 0]);
  return JSON.stringify([
    l.effect,
    l.colours.map(colour),
    'beats' in l.speed ? ['beats', l.speed.beats] : ['seconds', l.speed.seconds],
    l.direction, l.waves, l.size, l.edge, l.intensity,
    ...(l.base ? [['base', colour(l.base.colour), l.base.level]] : []),
  ]);
}

/** An effect layer with every colour looked up (its base's too), as plain colours. */
export function resolveEffect(l: EffectLayer, palettes: ReadonlyMap<string, Palette>): Omit<EffectLayer, 'colours' | 'base'> & { colours: PaletteColour[]; base?: { colour: PaletteColour; level: number } } {
  const { base, colours, ...rest } = structuredClone(l);
  return {
    ...rest,
    colours: colours.map((c) => ({ ...resolveColour(c, palettes) })),
    ...(base ? { base: { colour: { ...resolveColour(base.colour, palettes) }, level: base.level } } : {}),
  };
}

/** Every colour a layer uses: its colour, or an effect's colours and its base colour. */
export function layerColours(l: Layer): ColourSpec[] {
  if (l.kind === 'static') return [l.colour];
  return l.base ? [...l.colours, l.base.colour] : l.colours;
}

/** True when a preset runs an effect (it moves), not a plain colour. */
export const isEffectPreset = (p: Preset): boolean => p.layers.some((l) => l.kind === 'effect');

export const LookEntry = z.object({
  group: id,
  preset: id,
  fade: seconds.optional(),
  /** Group level the look sets, 0..1. Missing means full. */
  level: unit.optional(),
});
export type LookEntry = z.infer<typeof LookEntry>;

export const Look = z.object({
  id,
  name: z.string(),
  swatch: hex.optional(),
  section: z.string().optional(),
  /** Beats per minute the stage runs at when this look starts; 120 when not set. */
  tempo: z.number().min(40).max(240).optional(),
  groups: z.array(LookEntry),
});
export type Look = z.infer<typeof Look>;

// ---- Layout and settings ----

export const QuickTab = z.enum(['plain', 'colours', 'effects']);
export type QuickTab = z.infer<typeof QuickTab>;

export const QuickLook = z.object({ look: id, tab: QuickTab });
export type QuickLook = z.infer<typeof QuickLook>;

export const OperatorLayout = z.object({
  looks: z.array(id).default([]),
  groups: z.array(id).default([]),
  safeLook: id.optional(),
  manualForOperators: z.boolean().default(false),
  /** The service's looks in order, as look ids. The first is always the safe look ("Basic lights"). */
  runningOrder: z.array(id).default([]),
  /** Looks offered under "Quick looks", each on a tab. */
  quickLooks: z.array(QuickLook).default([]),
  /** The ready-made effects have been added once (see ensureEffects); they are never added again. */
  effectsAdded: z.boolean().optional(),
});
export type OperatorLayout = z.infer<typeof OperatorLayout>;

export const OutputSettings = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artnet'), host: z.string().default('2.255.255.255') }),
  // Empty host = multicast; otherwise unicast to that receiver.
  z.object({ kind: z.literal('sacn'), host: z.string().default(''), priority: z.number().int().min(1).max(200).default(100) }),
  z.object({ kind: z.literal('enttec'), port: z.string() }),
  z.object({ kind: z.literal('none') }),
]);
export type OutputSettings = z.infer<typeof OutputSettings>;

/** One universe sent somewhere other than the default output (see routing.ts). */
export const OutputRoute = z.object({
  universe: z.number().int().min(0).max(32767),
  output: OutputSettings,
});
export type OutputRoute = z.infer<typeof OutputRoute>;

/** Other programs controlling the lights over OSC (UDP). Off until switched on. */
export const OscSettings = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1024).max(65535).default(8000),
});
export type OscSettings = z.infer<typeof OscSettings>;

/** Who to call when the lights have a problem (Settings > Who to call). An empty field is left out. */
export const Contact = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
});
export type Contact = z.infer<typeof Contact>;

/** The contact from the Settings form: fields trimmed, an empty one left out, nothing at all when both are empty. Throws on bad input. */
export function contactOf(input: unknown): Contact | undefined {
  const raw = z.object({ name: z.string().optional(), phone: z.string().optional() }).parse(input);
  const contact = Contact.parse({ name: raw.name?.trim() || undefined, phone: raw.phone?.trim() || undefined });
  return contact.name || contact.phone ? contact : undefined;
}

export const Settings = z.object({
  /** The default output: every universe goes here unless a route says otherwise. */
  output: OutputSettings.default({ kind: 'artnet', host: '2.255.255.255' }),
  /** Universes with their own output. Absent in older shows. */
  routes: z.array(OutputRoute).max(64).optional(),
  /** Master switch for sending DMX. Off lets another desk (e.g. Lightkey) keep the lights. */
  outputEnabled: z.boolean().default(true),
  frameRate: z.number().int().min(10).max(44).default(40),
  gamma: z.number().min(1).max(4).default(2.2),
  pinHash: z.string().optional(),
  /** Absent in older shows: OSC is off. */
  osc: OscSettings.optional(),
  /** Who to call, shown in the operator page's problem explanation. Absent when nobody is set. */
  contact: Contact.optional(),
}).superRefine((s, ctx) => {
  for (const message of routeProblems(s.output, s.routes)) ctx.addIssue({ code: 'custom', message, path: ['routes'] });
});
export type Settings = z.infer<typeof Settings>;

export const StagePlan = z.object({
  background: z.string().optional(),
  grid: z.number().int().min(0).max(100).default(10),
});
export type StagePlan = z.infer<typeof StagePlan>;

export const Show = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string(),
  profiles: z.array(Profile),
  fixtures: z.array(Fixture),
  groups: z.array(Group),
  palettes: z.array(Palette).default([]),
  presets: z.array(Preset),
  looks: z.array(Look),
  operator: OperatorLayout.default({ looks: [], groups: [], manualForOperators: false, runningOrder: [], quickLooks: [] }),
  settings: Settings.default({ output: { kind: 'artnet', host: '2.255.255.255' }, outputEnabled: true, frameRate: 40, gamma: 2.2 }),
  stage: StagePlan.default({ grid: 10 }),
});
export type Show = z.infer<typeof Show>;

/** Parse a show and check every reference inside it. Throws with a readable message. */
export function parseShow(input: unknown): Show {
  const show = Show.parse(input);
  const problems = checkReferences(show);
  if (problems.length) throw new Error(`Show has broken references:\n- ${problems.join('\n- ')}`);
  return show;
}

export function checkReferences(show: Show): string[] {
  const problems: string[] = [];
  const unique = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const i of ids) {
      if (seen.has(i)) problems.push(`duplicate ${kind} id "${i}"`);
      seen.add(i);
    }
    return seen;
  };
  const profiles = unique('profile', show.profiles.map((p) => p.id));
  for (const p of BUILT_IN_PROFILES) profiles.add(p.id);
  const fixtures = unique('fixture', show.fixtures.map((f) => f.id));
  const groups = unique('group', show.groups.map((g) => g.id));
  const palettes = new Map(show.palettes.map((p) => [p.id, p]));
  unique('palette', show.palettes.map((p) => p.id));
  const presets = new Map(show.presets.map((p) => [p.id, p]));
  unique('preset', show.presets.map((p) => p.id));
  const looks = unique('look', show.looks.map((l) => l.id));

  for (const f of show.fixtures) {
    if (!profiles.has(f.profile)) problems.push(`fixture "${f.id}" uses unknown profile "${f.profile}"`);
  }
  for (const g of show.groups) {
    for (const f of g.fixtures) if (!fixtures.has(f)) problems.push(`group "${g.id}" lists unknown fixture "${f}"`);
  }
  for (const p of show.presets) {
    if (!groups.has(p.group)) problems.push(`preset "${p.id}" belongs to unknown group "${p.group}"`);
    for (const layer of p.layers) {
      for (const c of layerColours(layer)) {
        if (!('palette' in c)) continue;
        const pal = palettes.get(c.palette);
        if (!pal) problems.push(`preset "${p.id}" uses unknown palette "${c.palette}"`);
        else if (c.index >= pal.colours.length) problems.push(`preset "${p.id}" uses colour ${c.index} of palette "${c.palette}", which has ${pal.colours.length}`);
      }
    }
  }
  for (const l of show.looks) {
    for (const e of l.groups) {
      const p = presets.get(e.preset);
      if (!groups.has(e.group)) problems.push(`look "${l.id}" lists unknown group "${e.group}"`);
      if (!p) problems.push(`look "${l.id}" uses unknown preset "${e.preset}"`);
      else if (p.group !== e.group) problems.push(`look "${l.id}" puts preset "${e.preset}" (group "${p.group}") on group "${e.group}"`);
    }
  }
  for (const l of show.operator.looks) if (!looks.has(l)) problems.push(`operator layout lists unknown look "${l}"`);
  for (const g of show.operator.groups) if (!groups.has(g)) problems.push(`operator layout lists unknown group "${g}"`);
  for (const l of show.operator.runningOrder) if (!looks.has(l)) problems.push(`running order lists unknown look "${l}"`);
  for (const q of show.operator.quickLooks) if (!looks.has(q.look)) problems.push(`quick looks list unknown look "${q.look}"`);
  if (show.operator.safeLook && !looks.has(show.operator.safeLook)) problems.push(`Safe uses unknown look "${show.operator.safeLook}"`);
  return problems;
}

/** The show's own profile with this id, else the built-in one. */
export function findProfile(show: Show, id: string): Profile | undefined {
  return show.profiles.find((p) => p.id === id) ?? BUILT_IN_PROFILES.find((p) => p.id === id);
}

/** Channels a fixture occupies, for overlap warnings. */
export function footprint(show: Show, fixture: Fixture): number {
  return findProfile(show, fixture.profile)?.channels.length ?? 0;
}

/** Fixtures whose DMX addresses overlap or run past channel 512. */
export function addressProblems(show: Show): string[] {
  const problems: string[] = [];
  const used = new Map<string, string>();
  for (const f of show.fixtures) {
    const n = footprint(show, f);
    if (f.address + n - 1 > 512) problems.push(`fixture "${f.id}" runs past channel 512`);
    for (let ch = f.address; ch < f.address + n && ch <= 512; ch++) {
      const key = `${f.universe}:${ch}`;
      const other = used.get(key);
      if (other) {
        problems.push(`fixture "${f.id}" overlaps "${other}" at universe ${f.universe} channel ${ch}`);
        break;
      }
      used.set(key, f.id);
    }
  }
  return problems;
}
