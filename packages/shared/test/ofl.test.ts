import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeMode, expandModeChannels, oflToProfile, parseShow, type OflFixture } from '../src/index.ts';

const load = (name: string): OflFixture => JSON.parse(readFileSync(new URL(`./ofl/${name}.json`, import.meta.url), 'utf8'));
const lightkeyShow = () => parseShow(JSON.parse(readFileSync(new URL('../../../shows/dieva-majas-l1.json', import.meta.url), 'utf8')));
const roles = (p: { channels: { role: string; default?: number }[] }) => p.channels.map((c) => `${c.role}${c.default ? `=${c.default}` : ''}`);

test('SonicPulse 39-channel mode matches the layout imported from Lightkey', () => {
  const fixture = load('stairville-sonicpulse-led-bar-10');
  const k = fixture.modes.findIndex((m) => m.shortName === '39ch');
  const profile = oflToProfile(fixture, k, 'stairville', 'sonicpulse-led-bar-10', 'Stairville');
  assert.equal(profile.channels.length, 39);
  assert.equal(profile.id, 'stairville-sonicpulse-led-bar-10-39ch');
  const lightkey = lightkeyShow().profiles.find((p) => p.id === 'stairville-sonicpulse-led-bar-10-39-ch')!;
  assert.deepEqual(roles(profile), roles(lightkey));
});

test('Wild Wash 6-channel mode matches Lightkey too', () => {
  const fixture = load('stairville-wild-wash-132-led-rgb-dmx');
  const k = fixture.modes.findIndex((m) => m.name === '6-channel');
  const profile = oflToProfile(fixture, k, 'stairville', 'wild-wash-132-led-rgb-dmx', 'Stairville');
  assert.deepEqual(profile.channels.map((c) => c.role), ['dimmer', 'strobe', 'red', 'green', 'blue', 'other']);
  // Strobe parks on its "open" range, the sound channel on "off".
  const strobe = fixture.availableChannels![Object.keys(fixture.availableChannels!).find((n) => /strobe/i.test(n))!];
  const open = (strobe.capabilities ?? []).find((c) => c.shutterEffect === 'Open');
  assert.equal(profile.channels[1].default ?? 0, open?.dmxRange?.[0] ?? 0);
});

test('colour temperature, fine channels and 2D matrices', () => {
  const fixture: OflFixture = {
    name: 'Test Panel',
    availableChannels: {
      Dimmer: { capability: { type: 'Intensity' }, fineChannelAliases: ['Dimmer fine'] },
      CCT: { capability: { type: 'ColorTemperature', colorTemperatureStart: '2800K', colorTemperatureEnd: '6500K' } },
      Strobe: { capabilities: [{ type: 'ShutterStrobe', shutterEffect: 'Closed', dmxRange: [0, 9] }, { type: 'ShutterStrobe', shutterEffect: 'Open', dmxRange: [10, 19] }, { type: 'ShutterStrobe', shutterEffect: 'Strobe', dmxRange: [20, 255] }] },
      Macro: { defaultValue: '50%', capabilities: [{ type: 'Effect', dmxRange: [0, 255] }] },
    },
    templateChannels: {
      'Red $pixelKey': { capability: { type: 'ColorIntensity', color: 'Red' } },
      'Warm White $pixelKey': { capability: { type: 'ColorIntensity', color: 'Warm White' } },
    },
    matrix: { pixelCount: [2, 2, 1] },
    modes: [
      { name: 'Simple', channels: ['Dimmer', 'Dimmer fine', 'CCT', 'Strobe', 'Macro', null] },
      { name: 'Pixels', channels: ['Dimmer', { insert: 'matrixChannels', repeatFor: 'eachPixelABC', channelOrder: 'perChannel', templateChannels: ['Red $pixelKey', 'Warm White $pixelKey'] }] },
    ],
  };
  const simple = oflToProfile(fixture, 0, 'acme', 'test-panel', 'Acme');
  assert.deepEqual(simple.channels.map((c) => [c.role, c.fine ?? false, c.default ?? null]), [
    ['dimmer', false, null], ['dimmer', true, null], ['cct', false, null], ['strobe', false, 10], ['other', false, 128], ['other', false, 0],
  ]);
  assert.deepEqual(simple.channels[2].kelvin, { min: 2800, max: 6500 });
  const pixels = expandModeChannels(fixture, fixture.modes[1]);
  assert.deepEqual(pixels, ['Dimmer', 'Red (1, 1)', 'Red (2, 1)', 'Red (1, 2)', 'Red (2, 2)', 'Warm White (1, 1)', 'Warm White (2, 1)', 'Warm White (1, 2)', 'Warm White (2, 2)']);
  assert.deepEqual(describeMode(fixture, fixture.modes[1]), { channels: 9, roles: ['dimmer', 'red', 'white'] });
  // The profile is valid in a show.
  const show = { ...lightkeyShow(), profiles: [simple] };
  show.fixtures = [{ id: 'p', name: 'Panel', profile: simple.id, universe: 1, address: 1, x: 0.5, y: 0.5 }];
  show.groups = []; show.presets = []; show.looks = []; show.operator = { looks: [], groups: [], manualForOperators: false };
  parseShow(show);
});
