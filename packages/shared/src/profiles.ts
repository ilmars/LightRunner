// Built-in generic fixture profiles. Real fixtures get their own profiles
// (or Open Fixture Library imports) once the rig is known.

import type { Profile } from './schema.ts';

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
];
