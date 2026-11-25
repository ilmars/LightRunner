// Built-in fixture profiles: generic ones, and real lights the Open Fixture
// Library doesn't have. Other real fixtures get their own profiles (or Open
// Fixture Library imports) once the rig is known.

import type { Profile, ProfileChannel } from './schema.ts';

// ---- Portman Lights P1 Mini LED ----
// Not in the Open Fixture Library. Channels from Portman's "P1 Mini DMX chart"
// (with user manual v1.0, both at goknight.com/content/documentation/).
// Seven pixels, each a 1800 K filament (the "main source") with an RGBW glow
// behind it. The filament is driven as amber: it is a warm, orange source of its
// own, not a master for the glow. Each pixel is one segment.
// The glow master is held at full so the glow channels carry the level, the
// strobes open (0-9), the colour wheel open (0-9), macros off (0) and the
// control channel at "no function" (0; 246-255 resets the light).

const FILAMENTS = [1, 2, 3, 4, 5, 6, 7];
const filament = (n: number, fine: boolean): ProfileChannel[] => [
  { role: 'amber', name: `Filament ${n}` },
  ...(fine ? [{ role: 'amber', fine: true, name: `Filament ${n} fine` } as ProfileChannel] : []),
];
const glow = (n: number): ProfileChannel[] => [
  { role: 'red', name: `Glow ${n} red` },
  { role: 'green', name: `Glow ${n} green` },
  { role: 'blue', name: `Glow ${n} blue` },
  { role: 'white', name: `Glow ${n} white` },
];
const glowDimmer: ProfileChannel = { role: 'other', default: 255, name: 'Glow dimmer (kept at full)' };
const tail: ProfileChannel[] = [
  { role: 'strobe', default: 0, name: 'Glow strobe' },
  { role: 'strobe', default: 0, name: 'Filament strobe' },
  { role: 'other', default: 0, name: 'Glow colour wheel' },
  { role: 'other', default: 0, name: 'Macro' },
  { role: 'other', default: 0, name: 'Macro direction' },
  { role: 'other', default: 0, name: 'Macro speed' },
  { role: 'other', default: 0, name: 'Control' },
];

const p1Mini = (mode: string, name: string, channels: ProfileChannel[]): Profile => ({
  id: `portman-p1-mini-${mode}`,
  name: `Portman P1 Mini, ${name} (${channels.length} ch)`,
  channels,
});

/** The P1 Mini's five DMX modes, in the chart's order. */
export const PORTMAN_P1_MINI: Profile[] = [
  p1Mini('simple', 'Simple', [
    ...FILAMENTS.flatMap((n) => filament(n, false)),
    { role: 'red', name: 'All glow red' },
    { role: 'green', name: 'All glow green' },
    { role: 'blue', name: 'All glow blue' },
    { role: 'white', name: 'All glow white' },
    glowDimmer, ...tail,
  ]),
  p1Mini('standard', 'Standard', [...FILAMENTS.flatMap((n) => filament(n, false)), ...FILAMENTS.flatMap(glow), glowDimmer, ...tail]),
  p1Mini('standard-fine', 'Standard fine', [...FILAMENTS.flatMap((n) => filament(n, true)), ...FILAMENTS.flatMap(glow), glowDimmer, ...tail]),
  // The pixel modes have no glow dimmer.
  p1Mini('pixel', 'Pixel', [...FILAMENTS.flatMap((n) => [...filament(n, false), ...glow(n)]), ...tail]),
  p1Mini('pixel-fine', 'Pixel fine', [...FILAMENTS.flatMap((n) => [...filament(n, true), ...glow(n)]), ...tail]),
];

export const BUILT_IN_PROFILES: Profile[] = [
  { id: 'generic-dimmer', name: 'Generic dimmer (1 ch)', channels: [{ role: 'dimmer' }] },
  { id: 'generic-rgb', name: 'Generic RGB (3 ch)', channels: [{ role: 'red' }, { role: 'green' }, { role: 'blue' }] },
  {
    id: 'generic-rgbw', name: 'Generic RGBW (4 ch)',
    channels: [{ role: 'red' }, { role: 'green' }, { role: 'blue' }, { role: 'white' }],
  },
  {
    id: 'generic-rgba', name: 'Generic RGBA (4 ch)',
    channels: [{ role: 'red' }, { role: 'green' }, { role: 'blue' }, { role: 'amber' }],
  },
  {
    id: 'generic-drgb', name: 'Generic dimmer + RGB (4 ch)',
    channels: [{ role: 'dimmer' }, { role: 'red' }, { role: 'green' }, { role: 'blue' }],
  },
  {
    id: 'generic-drgbws', name: 'Generic dimmer + RGBW + strobe (6 ch)',
    channels: [
      { role: 'dimmer' }, { role: 'red' }, { role: 'green' }, { role: 'blue' }, { role: 'white' },
      { role: 'strobe', default: 0 },
    ],
  },
  {
    id: 'generic-d16rgbw', name: 'Generic 16-bit dimmer + RGBW (6 ch)',
    channels: [
      { role: 'dimmer' }, { role: 'dimmer', fine: true },
      { role: 'red' }, { role: 'green' }, { role: 'blue' }, { role: 'white' },
    ],
  },
  ...PORTMAN_P1_MINI,
];

// ---- Built-in lights by maker ----
// Real lights among the built-in types, so Patch can list them under their maker
// in "Browse by manufacturer" and find them in the library search, next to the
// Open Fixture Library's. Picking a mode picks the built-in type.

/** Keys of built-in lights start with this, so they never clash with the library's "maker/fixture" keys. */
export const BUILT_IN_KEY = 'built-in:';

export interface BuiltInFixture {
  /** "built-in:maker/fixture". */
  key: string;
  /** The maker's key, as the library would spell it. */
  manufacturerKey: string;
  manufacturer: string;
  name: string;
  categories: string[];
  modes: { name: string; profile: Profile }[];
}

export const BUILT_IN_FIXTURES: BuiltInFixture[] = [
  {
    key: `${BUILT_IN_KEY}portman-lights/p1-mini-led`,
    manufacturerKey: 'portman-lights',
    manufacturer: 'Portman Lights',
    name: 'P1 Mini LED',
    categories: ['Color Changer', 'Dimmer'],
    modes: PORTMAN_P1_MINI.map((profile, k) => ({ name: ['Simple', 'Standard', 'Standard fine', 'Pixel', 'Pixel fine'][k], profile })),
  },
];

/** Makers of built-in lights with how many each has, like the library's manufacturer list. */
export function builtInMakers(): { key: string; name: string; count: number }[] {
  const out = new Map<string, { key: string; name: string; count: number }>();
  for (const f of BUILT_IN_FIXTURES) {
    const m = out.get(f.manufacturerKey) ?? { key: f.manufacturerKey, name: f.manufacturer, count: 0 };
    m.count++;
    out.set(f.manufacturerKey, m);
  }
  return [...out.values()];
}

const hitOf = (f: BuiltInFixture) => ({ key: f.key, manufacturer: f.manufacturer, name: f.name, categories: f.categories });

/** One maker's built-in lights, as library search hits. */
export function builtInHitsOf(manufacturerKey: string) {
  return BUILT_IN_FIXTURES.filter((f) => f.manufacturerKey === manufacturerKey).map(hitOf);
}

/** Built-in lights whose maker, name or category has every word of the query. */
export function searchBuiltIns(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || query.trim().length < 2) return [];
  return BUILT_IN_FIXTURES.filter((f) => {
    const hay = `${f.manufacturer} ${f.name} ${f.key} ${f.categories.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).map(hitOf);
}

/**
 * A built-in light's modes, shaped like the library's (index, name, channels, roles), plus `profile`:
 * the id of the built-in type that mode is. Undefined for a key that is not a built-in light.
 */
export function builtInModes(key: string) {
  const f = BUILT_IN_FIXTURES.find((x) => x.key === key);
  if (!f) return undefined;
  return {
    key: f.key, name: f.name, manufacturer: f.manufacturer,
    modes: f.modes.map((m, index) => ({
      index, name: m.name, shortName: null, channels: m.profile.channels.length,
      roles: [...new Set(m.profile.channels.filter((c) => c.role !== 'other' && c.role !== 'strobe').map((c) => c.role))],
      profile: m.profile.id,
    })),
  };
}
