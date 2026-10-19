// Runs the engine headless through hours of random look, preset, effect, tempo, manual,
// Safe, Blackout and Any colour changes (Flash is left out: it snaps by design), tapping mid-fade on purpose, and reports the
// largest jump in how bright any segment of any fixture looks (its brightest written colour
// channel times its intensity) between two frames, beyond what the effects running there move by themselves.
//
// The spec's rule: no fixture (no segment of one) jumps more than 5% during any fade, including
// interruptions and manual release. An effect's own motion (a chase stepping, a meteor's head)
// is not a fade, so each segment's step is judged against Engine.ownMotion() + 5%.
// Manual takeover, master moves and Any
// colour drags follow the finger on purpose (0.2 s), so frames right after
// those are not judged.
//
// The show gets a few effect presets for every light group (every kind, soft and hard
// edges, beats and seconds), half of the looks' entries run one, and each look has a
// tempo between 60 and 200.
// Fades are at least 1 s, the spec's shortest (Safe and Blackout): a full
// 0–100% fade shorter than 0.75 s cannot stay under 5% per frame at 40 fps.
//
//   node tools/jump-check.ts [--show path.json] [--hours 2] [--seed 1]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EffectKind, EffectLayer, parseShow, type StageCommand } from '../packages/shared/src/index.ts';
import { Engine } from '../packages/engine/src/index.ts';

const { values } = parseArgs({
  options: {
    show: { type: 'string', default: fileURLToPath(new URL('../server/seed/demo-show.json', import.meta.url)) },
    hours: { type: 'string', default: '2' },
    seed: { type: 'string', default: '1' },
    limit: { type: 'string', default: '0.05' },
  },
});

const show = parseShow(JSON.parse(readFileSync(values.show!, 'utf8')));
const limit = Number(values.limit);
const end = Number(values.hours) * 3600;
const FRAME = 1 / show.settings.frameRate;

// Small seeded generator so a failure can be replayed.
let seed = Number(values.seed) >>> 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

// Half of the looks' entries carry a saved group level, so look changes move levels too.
for (const look of show.looks) {
  for (const entry of look.groups) if (rand() < 0.5) entry.level = rand();
}
const hex = () => '#' + Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');

// Effect presets: three for every light group, going through every kind in turn.
const kinds = EffectKind.options;
let made = 0;
for (const group of show.groups) {
  if (group.kind === 'smoke') continue;
  for (let n = 0; n < 3; n++) {
    const layer = EffectLayer.parse({
      kind: 'effect',
      effect: kinds[made++ % kinds.length],
      colours: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({ hex: hex() })),
      speed: rand() < 0.8 ? { beats: pick([0.25, 0.5, 1, 2, 4, 8, 16]) } : { seconds: 1 + rand() * 29 },
      direction: pick(['ltr', 'rtl', 'centreOut', 'outsideIn'] as const),
      waves: 1 + Math.floor(rand() * 4),
      size: rand(),
      edge: rand() < 0.5 ? 'soft' : 'hard',
      intensity: rand() < 0.7 ? 1 : rand(),
    });
    show.presets.push({ id: `${group.id}-effect-${n}`, name: `Effect ${n + 1}`, group: group.id, fade: 1 + rand() * 4, layers: [layer] });
  }
}
// Half of the looks' entries run one of their group's effects; every look has a tempo.
for (const look of show.looks) {
  look.tempo = 60 + Math.round(rand() * 140);
  for (const entry of look.groups) {
    const effects = show.presets.filter((p) => p.group === entry.group && p.layers[0]!.kind === 'effect');
    if (effects.length && rand() < 0.5) entry.preset = pick(effects).id;
  }
}

function randomCommand(): { cmd: StageCommand; fast: boolean } {
  // Tempo and the speed dial change how fast effects run; neither may make one jump.
  if (rand() < 0.05) {
    if (rand() < 0.7) return { cmd: { type: 'tempo', bpm: 60 + Math.round(rand() * 140) }, fast: false };
    return { cmd: { type: 'speed', value: 0.5 + rand() * 1.5 }, fast: false };
  }
  const r = rand();
  if (r < 0.35) {
    const fade = rand() < 0.3 ? 1 + rand() * 5 : undefined;
    return { cmd: { type: rand() < 0.2 ? 'quickLook' : 'look', id: pick(show.looks).id, fade }, fast: false };
  }
  if (r < 0.55) {
    const p = pick(show.presets);
    return { cmd: { type: 'groupPreset', group: p.group, preset: p.id }, fast: false };
  }
  if (r < 0.6 && rand() < 0.4) {
    // A live effect from the Effects tab; a third are later sends of a slider drag, which carry the pattern on.
    const base = pick(show.presets.filter((p) => p.layers[0]!.kind === 'effect'));
    const layer = base.layers[0] as EffectLayer;
    const effect = { ...layer, colours: layer.colours.map((c) => ('hex' in c ? c : { hex: hex() })), size: rand() };
    const cmd = { type: 'groupEffect' as const, group: base.group, effect };
    if (rand() < 0.33) return { cmd: { ...cmd, fade: 0.2, continues: true }, fast: true };
    return { cmd, fast: false };
  }
  if (r < 0.6) {
    // Half of the Any colour picks carry white, amber or UV (each one sometimes).
    const extra = () => (rand() < 0.5 ? rand() : undefined);
    const extras = rand() < 0.5 ? { white: extra(), amber: extra(), uv: extra() } : {};
    const cmd = { type: 'groupColour' as const, group: pick(show.groups).id, colour: hex(), ...extras };
    // A third are later sends of a drag on the operator page: they follow the finger in 0.2 s, like manual.
    if (rand() < 0.33) return { cmd: { ...cmd, fade: 0.2, continues: true }, fast: true };
    return { cmd, fast: false };
  }
  if (r < 0.68) {
    const target = rand() < 0.5 ? { group: pick(show.groups).id } : { fixture: pick(show.fixtures).id };
    return { cmd: { type: 'manual', target, colour: hex(), intensity: rand() }, fast: true };
  }
  if (r < 0.76) {
    const target = rand() < 0.5 ? { group: pick(show.groups).id } : { fixture: pick(show.fixtures).id };
    return { cmd: { type: 'release', target }, fast: false };
  }
  if (r < 0.8) return { cmd: { type: 'releaseAll' }, fast: false };
  if (r < 0.85) return { cmd: { type: 'backToLook' }, fast: false };
  if (r < 0.9) return { cmd: { type: 'safe' }, fast: false };
  if (r < 0.94) return { cmd: { type: 'blackout' }, fast: false };
  if (r < 0.97) return { cmd: { type: 'master', value: rand() }, fast: true };
  return { cmd: { type: 'groupLevel', group: pick(show.groups).id, value: rand() }, fast: true };
}

const engine = new Engine(show, 0);
// One name per segment, in the order of visibleLevels(): "b3" or "b3 segment 2".
const counts = engine.segmentCounts();
const ids = engine.fixtureIds().flatMap((id, f) =>
  counts[f] === 1 ? [id] : Array.from({ length: counts[f] }, (_, c) => `${id} segment ${c + 1}`));
let prev = engine.visibleLevels();
/** The largest step beyond the segment's own motion; and, for the report, the largest own motion and frame time. */
let worst = 0;
let worstAt = '';
let mostMotion = 0;
let slowest = 0;
let judged = 0;
let commands = 0;
let skipUntil = -1;
let next = 0;
const recent: string[] = [];

const started = performance.now();
for (let n = 0; n * FRAME <= end; n++) {
  const t = n * FRAME;
  if (t >= next) {
    const { cmd, fast } = randomCommand();
    engine.apply(cmd, t);
    commands++;
    recent.push(`${t.toFixed(2)}s ${JSON.stringify(cmd)}`);
    if (recent.length > 6) recent.shift();
    if (fast) skipUntil = t + 0.25;
    // Mostly mid-fade interruptions: 0.2–4 s apart, sometimes a long settle.
    next = t + (rand() < 0.8 ? 0.2 + rand() * 4 : 5 + rand() * 30);
  }
  const before = performance.now();
  engine.frame(t);
  slowest = Math.max(slowest, performance.now() - before);
  const now = engine.visibleLevels();
  const own = engine.ownMotion();
  if (t > skipUntil) {
    judged++;
    for (let k = 0; k < now.length; k++) {
      const step = Math.abs(now[k] - prev[k]) - own[k];
      mostMotion = Math.max(mostMotion, own[k]);
      if (step > worst) {
        worst = step;
        worstAt = `${ids[k]} at ${t.toFixed(3)}s (own motion ${(own[k] * 100).toFixed(2)}%) after:\n    ${recent.join('\n    ')}`;
      }
    }
  }
  prev = now;
}

const pass = worst <= limit;
console.log(`Simulated ${values.hours} h: ${commands} commands, ${judged} frames judged, in ${((performance.now() - started) / 1000).toFixed(1)} s`);
console.log(`Largest brightness step between frames beyond the effects' own motion: ${(worst * 100).toFixed(2)}% (limit ${(limit * 100).toFixed(0)}%)`);
console.log(`Largest own motion of an effect in one frame: ${(mostMotion * 100).toFixed(2)}%; slowest frame ${slowest.toFixed(2)} ms`);
if (!pass) console.log(`Worst case: ${worstAt}`);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
