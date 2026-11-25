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
