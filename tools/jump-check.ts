// Runs the engine headless through hours of random look, preset, effect, tempo, manual (groups, fixtures and single segments),
// Safe, Blackout, Any colour and Blind Go changes (Flash is left out: it snaps by design), tapping mid-fade on purpose, and reports the
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
// edges, beats and seconds, a third over a base colour), half of the looks' entries run one, and each look has a
// tempo between 60 and 200.
// Timeline traffic: group levels with a fade (1 to 60 s, applied quietly as the timeline runner does), and Follow the
// voice on a few light groups, whose value jumps between 0 and 1 (or anywhere) every frame and is sometimes let go. Both
// are judged under the same 5% rule.
// Timelines: a real TimelineRunner (the server's) plays generated timelines on the same engine, alongside the random
// commands: colours, levels, effects, Dark, Everything full, looks and Follow the voice (on a made-up loudness track), with
// random rises (0 too) and now and then an explicit end, while a pretend page seeks, pauses, drifts a little ahead or
// behind, changes Lights earlier / later, plays out to the end or goes away. A song, Basic lights, Blackout, Back to saved
// or Go stops a running timeline, as in the server.
// Fades are at least 1 s, the spec's shortest (Safe and Blackout): a full
// 0–100% fade shorter than 0.75 s cannot stay under 5% per frame at 40 fps.
//
//   node tools/jump-check.ts [--show path.json] [--hours 2] [--seed 1]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EffectKind, EffectLayer, STAGE_LAYER, Timeline, isEffectPreset, parseShow, type BlockWhat, type ColourSpec, type ManualTarget, type StageCommand } from '../packages/shared/src/index.ts';
import { Engine } from '../packages/engine/src/index.ts';
import { TimelineRunner } from '../server/src/timeline.ts';

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
      // A third run over a base colour.
      base: rand() < 0.33 ? { colour: { hex: hex() }, level: rand() } : undefined,
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

/** What manual control takes or lets go: a group, a fixture or (Individual lights) one segment of one. */
function manualTarget(): ManualTarget {
  if (rand() < 0.4) return { group: pick(show.groups).id };
  const ids = engine.fixtureIds();
  const f = Math.floor(rand() * ids.length);
  if (rand() < 0.5) return { fixture: ids[f]! };
  return { fixture: ids[f]!, segment: Math.floor(rand() * engine.segmentCounts()[f]!) };
}

/** One target, or (a third of the time) a list of a few changed together, as Individual lights sends them. */
function manualTargets(): { target: ManualTarget } | { targets: ManualTarget[]; releaseSegments: boolean } {
  if (rand() < 0.67) return { target: manualTarget() };
  return { targets: Array.from({ length: 1 + Math.floor(rand() * 4) }, manualTarget), releaseSegments: rand() < 0.5 };
}

function randomCommand(): { cmd: StageCommand; fast: boolean } {
  // Tempo and the speed dial change how fast effects run; neither may make one jump.
  if (rand() < 0.05) {
    if (rand() < 0.7) return { cmd: { type: 'tempo', bpm: 60 + Math.round(rand() * 140) }, fast: false };
    return { cmd: { type: 'speed', value: 0.5 + rand() * 1.5 }, fast: false };
  }
  // Blind's Go: a draft of the stage, changed by a few random commands, sent back as one change.
  if (rand() < 0.03) {
    const draft = new Engine(show, 0);
    draft.adoptClock(engine);
    draft.restore(engine.runtime(), 0);
    for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) draft.apply(randomCommand().cmd, 0);
    const fade = rand() < 0.3 ? 1 + rand() * 5 : undefined;
    return { cmd: { type: 'applyStage', stage: draft.runtime(), fade }, fast: false };
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
    const plain = (c: ColourSpec) => ('hex' in c ? c : { hex: hex() });
    // Half keep the preset's base; the others get a new one or none.
    const under = rand() < 0.5 ? layer.base && { colour: plain(layer.base.colour), level: layer.base.level }
      : rand() < 0.5 ? { colour: { hex: hex() }, level: rand() } : undefined;
    const effect = { ...layer, colours: layer.colours.map(plain), size: rand(), base: under };
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
    // As on the page: half the held colours carry white, amber or UV, and some sends are a level alone (Level on held lights).
    if (rand() < 0.2) return { cmd: { type: 'manual', ...manualTargets(), intensity: rand() }, fast: true };
    const extra = () => (rand() < 0.5 ? rand() : undefined);
    const extras = rand() < 0.5 ? { white: extra(), amber: extra(), uv: extra() } : {};
    return { cmd: { type: 'manual', ...manualTargets(), colour: hex(), ...extras, intensity: rand() }, fast: true };
  }
  if (r < 0.76) return { cmd: { type: 'release', ...manualTargets() }, fast: false };
  if (r < 0.8) return { cmd: { type: 'releaseAll' }, fast: false };
  if (r < 0.85) return { cmd: { type: 'backToLook' }, fast: false };
  if (r < 0.9) return { cmd: { type: 'safe' }, fast: false };
  if (r < 0.94) return { cmd: { type: 'blackout' }, fast: false };
  if (r < 0.97) return { cmd: { type: 'master', value: rand() }, fast: true };
  // A timeline's level block fades over its Rise; the slider's 0.2 s smoothing follows the finger.
  if (rand() < 0.5) return { cmd: { type: 'groupLevel', group: pick(show.groups).id, value: rand(), fade: 1 + rand() * 59 }, fast: false };
  return { cmd: { type: 'groupLevel', group: pick(show.groups).id, value: rand() }, fast: true };
}

/** The light groups whose level follows a (random) voice right now. */
const following = new Set<string>();
const lightGroupIds = show.groups.filter((g) => g.kind !== 'smoke').map((g) => g.id);
/** Start or stop one group following, as a timeline's Follow-the-voice block starting or ending would. */
function toggleFollow(t: number): string {
  const id = pick(lightGroupIds);
  if (following.delete(id)) {
    engine.setLevelFollow(id, null, t);
    return `${t.toFixed(2)}s follow ${id} off`;
  }
  following.add(id);
  return `${t.toFixed(2)}s follow ${id} on`;
}
/** A loudness value for this frame: jumps between silence and full, or lands anywhere. */
const voice = () => (rand() < 0.4 ? 0 : rand() < 0.5 ? 1 : rand());

// ---- Timelines ----

/** A rise as people set them: often none, often short, sometimes long. */
const rise = () => (rand() < 0.3 ? 0 : rand() < 0.6 ? rand() * 2 : rand() * 30);
let timelineCount = 0;
/** A timeline of random blocks on Whole stage and on most light groups, with a made-up loudness track as long as it is. */
function randomTimeline(): Timeline {
  const length = 20 + rand() * 280;
  let n = 0;
  const block = (start: number, what: BlockWhat) => ({
    id: `b${n++}`, start, rise: rise(), what,
    // Now and then an explicit end: the layer is handed back.
    ...(rand() < 0.2 ? { end: start + 0.5 + rand() * 20 } : {}),
  });
  const at = () => rand() * length;
  const stage = [block(0, { kind: 'dark' })];
  for (let k = Math.floor(rand() * 6); k > 0; k--) {
    const r = rand();
    stage.push(block(at(), r < 0.4 ? { kind: 'look', look: pick(show.looks).id } : r < 0.7 ? { kind: 'dark' } : { kind: 'full' }));
  }
  const layers = [{ group: STAGE_LAYER, blocks: stage }];
  for (const group of lightGroupIds) {
    if (rand() < 0.3) continue;
    const colours = show.presets.filter((p) => p.group === group && !isEffectPreset(p));
    const effects = show.presets.filter((p) => p.group === group && isEffectPreset(p));
    const blocks = [];
    for (let k = 1 + Math.floor(rand() * 8); k > 0; k--) {
      const r = rand();
      let what: BlockWhat;
      if (r < 0.35 && colours.length) what = { kind: 'colour', preset: pick(colours).id, level: rand() };
      else if (r < 0.55) what = { kind: 'level', level: rand() };
      else if (r < 0.75 && effects.length) {
        const speed = rand() < 0.5 ? undefined : rand() < 0.5 ? { beats: pick([0.5, 1, 2, 4, 8]) } : { seconds: 1 + rand() * 20 };
        const level = rand() < 0.5 ? undefined : rand();
        what = { kind: 'effect', preset: pick(effects).id, ...(speed ? { speed } : {}), ...(level !== undefined ? { level } : {}) };
      } else {
        const low = rand(), high = rand();
        what = { kind: 'follow', low, high, ...(rand() < 0.3 && colours.length ? { preset: pick(colours).id } : {}) };
      }
      blocks.push(block(at(), what));
    }
    layers.push({ group, blocks });
  }
  // Loudness, 25 values a second: quiet stretches, loud stretches, and jumps between them.
  const bytes = new Uint8Array(Math.ceil(length * 25));
  let level = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (rand() < 0.05) level = rand() < 0.5 ? 0 : 255;
    else level = Math.min(255, Math.max(0, level + (rand() - 0.5) * 80));
    bytes[i] = Math.round(level);
  }
  return Timeline.parse({
    id: `timeline-${++timelineCount}`, name: `Timeline ${timelineCount}`, layers,
    recording: { id: 'rec', name: 'rec.wav', duration: length, loudness: Buffer.from(bytes).toString('base64'), peaks: '' },
    offsetMs: rand() < 0.5 ? 0 : Math.round(-500 + rand() * 1000),
  });
}

/** What stops a running timeline in the server: a song, Basic lights, Blackout, Back to saved, Go. */
const STOPS_TIMELINE = new Set<StageCommand['type']>(['look', 'safe', 'blackout', 'backToLook', 'applyStage']);

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
const remember = (line: string) => {
  recent.push(line);
  if (recent.length > 6) recent.shift();
};

// The timeline runner on this engine and this clock, and a pretend page playing the recording.
let clock = 0;
const runs = { started: 0, ended: 0, stopped: 0, seeks: 0, pauses: 0, drifts: 0, offsets: 0, gone: 0, sent: 0, refused: 0 };
const runner = new TimelineRunner({
  show: () => show,
  apply: (cmd, o) => {
    runs.sent++;
    if (engine.apply(cmd, clock, o)) runs.refused++;
    remember(`${clock.toFixed(2)}s timeline ${JSON.stringify(cmd)}`);
  },
  follow: (group, value) => engine.setLevelFollow(group, value, clock),
  now: () => clock,
  onStop: (why) => {
    if (why === 'end') runs.ended++;
    else runs.stopped++;
    nextTimeline = clock + 2 + rand() * 30;
  },
});
const page = { pos: 0, playing: false, there: false };
let nextTimeline = 5;
let nextPageEvent = 0;
let nextReport = 0;

/** One frame of the pretend page: it plays, now and then does something, and reports 4 times a second while it is there. */
function drivePage(t: number): void {
  const timeline = show.timelines[0]!;
  const duration = timeline.recording!.duration;
  if (page.playing) page.pos += FRAME;
  // The recording plays out: the page stops at its end.
  if (page.playing && page.pos >= duration) {
    page.pos = duration;
    page.playing = false;
  }
  if (t >= nextPageEvent) {
    const r = rand();
    if (!page.there) {
      // Back on a new connection: it takes the timeline up from where it is.
      if (r < 0.3) Object.assign(page, { there: true, pos: runner.state?.pos ?? 0, playing: runner.state?.playing ?? false });
    } else if (r < 0.35) {
      page.pos = rand() * duration;
      runs.seeks++;
    } else if (r < 0.55) {
      page.playing = !page.playing;
      runs.pauses++;
    } else if (r < 0.75) {
      // A little ahead or behind.
      page.pos = Math.max(0, page.pos + (rand() - 0.5) * 0.6);
      runs.drifts++;
    } else if (r < 0.9) {
      timeline.offsetMs = Math.round(-500 + rand() * 1000);
      runs.offsets++;
    } else {
      page.there = false;
      runner.release();
      runs.gone++;
    }
    remember(`${t.toFixed(2)}s page ${JSON.stringify(page)} offset ${timeline.offsetMs}`);
    nextPageEvent = t + 0.2 + rand() * (rand() < 0.8 ? 3 : 20);
  }
  if (page.there && t >= nextReport) {
    runner.report(page.pos, page.playing);
    nextReport = t + 0.25;
  }
}

const started = performance.now();
for (let n = 0; n * FRAME <= end; n++) {
  const t = n * FRAME;
  clock = t;
  if (t >= next) {
    let { cmd, fast } = randomCommand();
    // While a timeline runs, most of what would stop it is drawn again, so timelines get to run for a while.
    for (let k = 0; k < 10 && runner.running && STOPS_TIMELINE.has(cmd.type) && rand() < 0.9; k++) ({ cmd, fast } = randomCommand());
    if (runner.running && STOPS_TIMELINE.has(cmd.type)) runner.stop();
    // A faded level is a timeline's own change: no Undo step.
    engine.apply(cmd, t, { quiet: cmd.type === 'groupLevel' && cmd.fade !== undefined });
    commands++;
    remember(`${t.toFixed(2)}s ${JSON.stringify(cmd)}`);
    if (rand() < 0.15) remember(toggleFollow(t));
    if (fast) skipUntil = t + 0.25;
    // Mostly mid-fade interruptions: 0.2–4 s apart, sometimes a long settle.
    next = t + (rand() < 0.8 ? 0.2 + rand() * 4 : 5 + rand() * 30);
  }
  // A timeline now and then: from the start, or from the middle.
  if (!runner.running && t >= nextTimeline) {
    const timeline = randomTimeline();
    show.timelines = [timeline];
    const at = rand() < 0.6 ? 0 : rand() * timeline.recording!.duration;
    Object.assign(page, { pos: at, playing: true, there: rand() < 0.9 });
    nextReport = t + 0.25;
    nextPageEvent = t + rand() * 3;
    runs.started++;
    remember(`${t.toFixed(2)}s timeline ${timeline.id} from ${at.toFixed(2)}`);
    runner.start(timeline, at, engine.runtime());
  }
  if (runner.running) {
    drivePage(t);
    runner.tick();
  }
  // The voice moves every frame, for every group that follows it.
  for (const id of following) if (rand() < 0.5) engine.setLevelFollow(id, voice(), t);
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
console.log(`Timelines: ${runs.started} played (${runs.ended} to their end, ${runs.stopped} stopped), ${runs.sent} changes sent (${runs.refused} refused); the page sought ${runs.seeks} times, paused or played ${runs.pauses}, drifted ${runs.drifts}, changed the offset ${runs.offsets} and went away ${runs.gone}`);
console.log(`Largest brightness step between frames beyond the effects' own motion: ${(worst * 100).toFixed(2)}% (limit ${(limit * 100).toFixed(0)}%)`);
console.log(`Largest own motion of an effect in one frame: ${(mostMotion * 100).toFixed(2)}%; slowest frame ${slowest.toFixed(2)} ms`);
if (!pass) console.log(`Worst case: ${worstAt}`);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
