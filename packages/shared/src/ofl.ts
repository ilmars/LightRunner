// Open Fixture Library (open-fixture-library.org) fixtures → Light Runner
// profiles. OFL describes each channel by what it does (capabilities); this
// maps them onto the roles the engine drives, and parks everything else on a
// safe fixed value (shutter open, effects and sound modes off).

import type { ChannelRole, Profile, ProfileChannel } from './schema.ts';

/* OFL's JSON is large and loosely shaped; only the parts used here are typed. */
interface OflCapability {
  type: string;
  dmxRange?: [number, number];
  color?: string;
  shutterEffect?: string;
  colorTemperature?: string;
  colorTemperatureStart?: string;
  colorTemperatureEnd?: string;
  brightness?: string;
  brightnessStart?: string;
}

interface OflChannel {
  capability?: OflCapability;
  capabilities?: OflCapability[];
  defaultValue?: number | string;
  fineChannelAliases?: string[];
}

interface OflMatrixInsert {
  insert: 'matrixChannels';
  repeatFor: string | string[];
  channelOrder: 'perPixel' | 'perChannel';
  templateChannels: (string | null)[];
}

interface OflMode {
  name: string;
  shortName?: string;
  channels: (string | null | OflMatrixInsert)[];
}

export interface OflFixture {
  name: string;
  shortName?: string;
  categories?: string[];
  availableChannels?: Record<string, OflChannel>;
  templateChannels?: Record<string, OflChannel>;
  matrix?: {
    pixelCount?: [number, number, number];
    pixelKeys?: (string | null)[][][];
    pixelGroups?: Record<string, unknown>;
  };
  modes: OflMode[];
}

/** Pixel keys of a matrix fixture, in OFL's order. */
function pixelKeys(fixture: OflFixture): string[] {
  const m = fixture.matrix;
  if (!m) return [];
  if (m.pixelKeys) return m.pixelKeys.flat(2).filter((k): k is string => typeof k === 'string');
  const [x, y, z] = m.pixelCount ?? [0, 0, 0];
  const keys: string[] = [];
  for (let k = 1; k <= z; k++) {
    for (let j = 1; j <= y; j++) {
      for (let i = 1; i <= x; i++) {
        keys.push(y === 1 && z === 1 ? `${i}` : z === 1 ? `(${i}, ${j})` : `(${i}, ${j}, ${k})`);
      }
    }
  }
  return keys;
}

/** A mode's channel list with matrix inserts expanded into plain channel names. */
export function expandModeChannels(fixture: OflFixture, mode: OflMode): (string | null)[] {
  const out: (string | null)[] = [];
  for (const ch of mode.channels) {
    if (ch === null || typeof ch === 'string') {
      out.push(ch);
      continue;
    }
    let keys: string[];
    if (Array.isArray(ch.repeatFor)) keys = ch.repeatFor;
    else if (ch.repeatFor === 'eachPixelGroup') keys = Object.keys(fixture.matrix?.pixelGroups ?? {});
    else keys = pixelKeys(fixture);
    const name = (template: string | null, key: string) => (template === null ? null : template.replaceAll('$pixelKey', key));
    if (ch.channelOrder === 'perChannel') {
      for (const t of ch.templateChannels) for (const key of keys) out.push(name(t, key));
    } else {
      for (const key of keys) for (const t of ch.templateChannels) out.push(name(t, key));
    }
  }
  return out;
}

/** Find a channel definition by its (expanded) name, including fine aliases and templates. */
function lookup(fixture: OflFixture, name: string): { channel: OflChannel; fine: boolean } | null {
  const available = fixture.availableChannels ?? {};
  if (available[name]) return { channel: available[name], fine: false };
  for (const ch of Object.values(available)) if (ch.fineChannelAliases?.includes(name)) return { channel: ch, fine: true };
  for (const [template, ch] of Object.entries(fixture.templateChannels ?? {})) {
    const pattern = new RegExp(`^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\$pixelKey', '.+')}$`);
    if (pattern.test(name)) return { channel: ch, fine: false };
    for (const alias of ch.fineChannelAliases ?? []) {
      const aliasPattern = new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\$pixelKey', '.+')}$`);
      if (aliasPattern.test(name)) return { channel: ch, fine: true };
    }
  }
  return null;
}

const COLOUR_ROLES: Record<string, ChannelRole> = {
  Red: 'red', Green: 'green', Blue: 'blue',
  White: 'white', 'Warm White': 'white', 'Cold White': 'white',
  Amber: 'amber', UV: 'uv',
};

/** "2700K" → 2700. Keywords map to typical values. */
function kelvin(text: string | undefined, fallback: number): number {
  if (!text) return fallback;
  const n = Number.parseFloat(text);
  if (/k$/i.test(text) && Number.isFinite(n)) return n;
  return ({ warm: 2700, CTO: 3200, default: 4500, CTB: 5600, cold: 6500 } as Record<string, number>)[text] ?? fallback;
}

function dmxDefault(channel: OflChannel): number | undefined {
  const v = channel.defaultValue;
  if (typeof v === 'number') return Math.max(0, Math.min(255, Math.round(v)));
  if (typeof v === 'string' && v.endsWith('%')) return Math.round((Number.parseFloat(v) / 100) * 255);
  return undefined;
}

function toChannel(name: string | null, fixture: OflFixture): ProfileChannel {
  if (name === null) return { role: 'other', default: 0, name: 'No function' };
  const found = lookup(fixture, name);
  if (!found) return { role: 'other', default: 0, name };
  const { channel, fine } = found;
  const caps = channel.capabilities ?? (channel.capability ? [channel.capability] : []);
  const real = caps.filter((c) => c.type !== 'NoFunction');
  const types = new Set(real.map((c) => c.type));
  const only = (t: string) => types.size === 1 && types.has(t);

  if (only('Intensity')) return { role: 'dimmer', name, ...(fine ? { fine: true } : {}) };
  // A smoke or haze machine's output: its level is the dimmer, which only a smoke group drives (linear, no gamma).
  const fog = real.filter((c) => c.type === 'Fog' || c.type === 'FogOutput');
  if (fog.length && fog.length === real.length) return { role: 'dimmer', name, ...(fine ? { fine: true } : {}) };
  // Fog mixed with other functions on one channel: parked at 0 so its default can never make smoke.
  if (fog.length) return { role: 'other', name, default: 0 };
  if (only('ColorIntensity') && real.length === 1) {
    const role = COLOUR_ROLES[real[0].color ?? ''];
    if (role) return { role, name, ...(fine ? { fine: true } : {}) };
  }
  if (only('ColorTemperature')) {
    const c = real[0];
    const min = kelvin(c.colorTemperatureStart ?? c.colorTemperature, 2700);
    const max = kelvin(c.colorTemperatureEnd ?? c.colorTemperature, 6500);
    if (max > min) return { role: 'cct', name, kelvin: { min, max }, ...(fine ? { fine: true } : {}) };
  }
  if (types.has('ShutterStrobe')) {
    // Park the shutter open.
    const open = caps.find((c) => c.type === 'ShutterStrobe' && c.shutterEffect === 'Open');
    return { role: 'strobe', name, default: open?.dmxRange?.[0] ?? dmxDefault(channel) ?? 0 };
  }
  // Effects, colour macros, sound and auto modes: a fixed value that does nothing.
  const off = caps.find((c) => c.type === 'NoFunction');
  return { role: 'other', name, default: dmxDefault(channel) ?? off?.dmxRange?.[0] ?? 0 };
}

export function oflProfileId(manufacturerKey: string, fixtureKey: string, mode: OflMode): string {
  const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug(`${manufacturerKey}-${fixtureKey}-${mode.shortName ?? mode.name}`);
}

/** Turn one mode of an OFL fixture into a Light Runner profile. */
export function oflToProfile(fixture: OflFixture, modeIndex: number, manufacturerKey: string, fixtureKey: string, manufacturerName: string): Profile {
  const mode = fixture.modes[modeIndex];
  if (!mode) throw new Error(`fixture has no mode ${modeIndex}`);
  const channels = expandModeChannels(fixture, mode).map((name) => toChannel(name, fixture));
  return {
    id: oflProfileId(manufacturerKey, fixtureKey, mode),
    name: `${manufacturerName} ${fixture.name} (${mode.name})`,
    channels,
    source: { ofl: `${manufacturerKey}/${fixtureKey}`, mode: mode.name },
  };
}

/** What a mode drives, for showing modes to choose from. */
export function describeMode(fixture: OflFixture, mode: OflMode): { channels: number; roles: string[] } {
  const chans = expandModeChannels(fixture, mode).map((name) => toChannel(name, fixture));
  const roles = [...new Set(chans.filter((c) => c.role !== 'other' && c.role !== 'strobe').map((c) => c.role))];
  return { channels: chans.length, roles };
}
