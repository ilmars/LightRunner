import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { Engine } from '../../packages/engine/src/index.ts';
import { TimelineRunner, timelineLength } from '../src/timeline.ts';
import { STAGE_LAYER, Timeline, ensureEffects, isEffectPreset, parseShow, stateAt, type RuntimeState, type Show, type StageCommand } from '../../packages/shared/src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseShow = (): Show => ensureEffects(parseShow(JSON.parse(readFileSync(seedPath, 'utf8'))));
const LIGHT_GROUPS = ['front-wash', 'back-wall', 'audience', 'pulpit'];

/** A timeline from its parts (blocks get a rise of 0 unless they say). */
function timeline(id: string, layers: { group: string; blocks: any[] }[], extra: Record<string, unknown> = {}): Timeline {
  return Timeline.parse({ id, name: `Timeline ${id}`, layers, ...extra });
}

/**
 * Dark at 0 (rise 2), the front wash warm at 3 (rise 2), the back wall amber from 5 to 8 (rise 1), everything full at 10 (rise 4).
 * It ends at 10.
 */
const christmas = (extra: Record<string, unknown> = {}) => timeline('xmas', [
  { group: STAGE_LAYER, blocks: [
    { id: 'dark', start: 0, rise: 2, what: { kind: 'dark' } },
    { id: 'full', start: 10, rise: 4, what: { kind: 'full' } },
  ] },
  { group: 'front-wash', blocks: [{ id: 'front', start: 3, rise: 2, what: { kind: 'colour', preset: 'front-warm', level: 0.8 } }] },
  { group: 'back-wall', blocks: [{ id: 'back', start: 5, end: 8, rise: 1, what: { kind: 'colour', preset: 'back-amber', level: 1 } }] },
], extra);

/** A runner on a fake clock that keeps every command and follow value it sends, with the time it was sent. */
function rig(show: Show, opts: { before?: RuntimeState | null } = {}) {
  let clock = 100; // the clock's zero is not the timeline's
  const sent: { at: number; cmd: StageCommand }[] = [];
  const follows: { at: number; group: string; value: number | null }[] = [];
  const stops: string[] = [];
  let current = show;
  const runner = new TimelineRunner({
    show: () => current,
    apply: (cmd, o) => {
      assert.equal(o.quiet, true);
      sent.push({ at: clock - 100, cmd });
    },
    follow: (group, value) => follows.push({ at: clock - 100, group, value }),
    now: () => clock,
    onStop: (why) => stops.push(why),
  });
  return {
    runner, sent, follows, stops,
    setShow(s: Show) { current = s; },
    get time() { return clock - 100; },
    /** Moves the clock on by `seconds`, ticking every 25 ms like the server does. */
    run(seconds: number) {
      const steps = Math.round(seconds / 0.025);
      for (let i = 0; i < steps; i++) {
        clock += 0.025;
        runner.tick();
      }
    },
    start(t: Timeline, at = 0) { runner.start(t, at, opts.before ?? null); },
    cmds(type: string, group?: string) {
      return sent.filter((s) => s.cmd.type === type && (group === undefined || (s.cmd as any).group === group));
    },
  };
}

const showWith = (...timelines: Timeline[]): Show => ({ ...baseShow(), timelines });

// ---- The runner on its own (fake clock) ----

test('the runner sends each block at its time, with its rise, and stops at the end', () => {
  const t = christmas();
  const r = rig(showWith(t));
  r.start(t);
  // Start at 0:00: Dark on every light group, over its rise.
  assert.deepEqual(r.sent.map((s) => s.cmd), LIGHT_GROUPS.map((group) => ({ type: 'groupLevel', group, value: 0, fade: 2 })));
  assert.deepEqual(r.runner.state, { id: 'xmas', name: 'Timeline xmas', pos: 0, duration: 10, playing: true });

  r.run(3.1);
  const front = r.cmds('groupPreset', 'front-wash');
  assert.equal(front.length, 1);
  assert.deepEqual(front[0]!.cmd, { type: 'groupPreset', group: 'front-wash', preset: 'front-warm', fade: 2 });
  assert.ok(Math.abs(front[0]!.at - 3) < 0.03, `front at ${front[0]!.at}`);
  assert.deepEqual(r.cmds('groupLevel', 'front-wash').at(-1)!.cmd, { type: 'groupLevel', group: 'front-wash', value: 0.8, fade: 2 });

  r.run(2);
  assert.deepEqual(r.cmds('groupPreset', 'back-wall').map((s) => s.cmd), [{ type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 1 }]);
  assert.deepEqual(r.cmds('groupLevel', 'back-wall').at(-1)!.cmd, { type: 'groupLevel', group: 'back-wall', value: 1, fade: 1 });

  // At 8 the back wall's block ends: it goes back to Dark, over the block's rise.
  const before = r.sent.length;
  r.run(5);
  const back = r.sent.slice(before).filter((s) => (s.cmd as any).group === 'back-wall');
  assert.equal(back[0]!.cmd.type, 'groupLevel');
  assert.deepEqual(back[0]!.cmd, { type: 'groupLevel', group: 'back-wall', value: 0, fade: 1 });
  assert.ok(Math.abs(back[0]!.at - 8) < 0.03);
  // At 10 everything full over 4 s, and that is the end: the runner stops, the stage stays.
  for (const group of LIGHT_GROUPS) assert.deepEqual(r.cmds('groupLevel', group).at(-1)!.cmd, { type: 'groupLevel', group, value: 1, fade: 4 });
  assert.equal(r.runner.state, null);
  assert.deepEqual(r.stops, ['end']);
  // Never a real Blackout or Basic lights.
  assert.ok(r.sent.every((s) => s.cmd.type !== 'blackout' && s.cmd.type !== 'safe'));
  const count = r.sent.length;
  r.run(2);
  assert.equal(r.sent.length, count, 'nothing after the end');
});

test('a page that stops reporting: the runner carries on by itself to the end and stops (RF 1)', () => {
  const t = christmas();
  const r = rig(showWith(t));
  r.start(t);
  for (let i = 0; i < 8; i++) {
    r.run(0.25);
    r.runner.report(r.time, true);
  }
  // The page goes away. Nothing reports any more.
  r.run(30);
  assert.equal(r.runner.state, null);
  assert.deepEqual(r.stops, ['end']);
  // It got to the end on its own clock: everything full.
  assert.ok(r.cmds('groupLevel').some((s) => (s.cmd as any).value === 1 && (s.cmd as any).fade === 4));
});

test('a page that paused and then went away: after a while the runner plays on to the end', () => {
  const t = christmas();
  const r = rig(showWith(t));
  r.start(t);
  r.run(1);
  for (let i = 0; i < 8; i++) {
    r.runner.report(1, false);
    r.run(0.25);
  }
  assert.equal(r.runner.state!.playing, false);
  assert.equal(r.runner.state!.pos, 1);
  r.run(30);
  assert.equal(r.runner.state, null);
  assert.deepEqual(r.stops, ['end']);
});

test('reports keep the runner on the sound: pause holds it, small differences are eased, a seek jumps', () => {
  const t = christmas();
  const r = rig(showWith(t));
  r.start(t);
  r.run(1);
  // The page is paused at 1.0: the runner holds there.
  r.runner.report(1, false);
  r.run(1);
  assert.equal(r.runner.state!.pos, 1);
  // Playing again, slightly behind: eased, not jumped.
  r.runner.report(0.95, true);
  assert.ok(r.runner.state!.pos > 0.95 && r.runner.state!.pos < 1);
  // A seek far ahead: jumps.
  r.runner.report(6, true);
  assert.equal(r.runner.state!.pos, 6);
});

test('Start in the middle and every seek fade over 1 s; time passing uses the rise (RF 3)', () => {
  const t = christmas();
  const r = rig(showWith(t));
  r.start(t, 6);
  // At 6: front wash warm 0.8 (from 3), back wall amber (5 to 8), the rest dark — all over 1 s.
  const first = r.sent.map((s) => s.cmd);
  assert.ok(first.length > 0);
  for (const cmd of first) assert.equal((cmd as any).fade, 1, JSON.stringify(cmd));
  assert.deepEqual(first.filter((c) => (c as any).group === 'back-wall'), [
    { type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 1 },
    { type: 'groupLevel', group: 'back-wall', value: 1, fade: 1 },
  ]);
  // Back and forth while playing.
  let n = r.sent.length;
  r.run(0.5);
  r.runner.report(2, true);
  r.run(0.05);
  const back = r.sent.slice(n);
  assert.ok(back.length > 0);
  for (const s of back) assert.equal((s.cmd as any).fade, 1);
  // Before the front wash's block: it falls back to Dark (no colour of its own).
  assert.deepEqual(back.filter((s) => (s.cmd as any).group === 'front-wash').map((s) => s.cmd), [{ type: 'groupLevel', group: 'front-wash', value: 0, fade: 1 }]);
  // Played on from 2 past 3: the front wash's block comes with its own rise again.
  n = r.sent.length;
  r.run(1.2);
  assert.deepEqual(r.sent.slice(n).filter((s) => s.cmd.type === 'groupPreset').map((s) => s.cmd), [{ type: 'groupPreset', group: 'front-wash', preset: 'front-warm', fade: 2 }]);

  // Many seeks in a row, some tiny, some large, never throw, and every change after a jump fades 1 s.
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 300; i++) {
    const pos = random() * 9.5;
    const from = r.sent.length;
    r.runner.report(pos, random() < 0.8);
    const jumped = Math.abs(r.runner.state!.pos - pos) < 1e-9 && r.sent.length === from;
    r.run(0.025);
    if (jumped) for (const s of r.sent.slice(from)) assert.equal((s.cmd as any).fade, 1);
  }
  // Wherever it ends up, the last command for each group is what the timeline gives there.
  r.runner.report(9, false);
  r.run(0.1);
  const at = stateAt(t, showWith(t), 9);
  for (const group of LIGHT_GROUPS) {
    const level = r.cmds('groupLevel', group).at(-1)!.cmd as any;
    assert.equal(level.value, at.get(group)!.level, group);
  }
});

test('seeking back and forth while playing never steps a light more than 5% a frame, on a real engine (RF 3)', () => {
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const loudness = Buffer.from(Array.from({ length: 25 * 30 }, () => Math.floor(random() * 256))).toString('base64');
  const t = timeline('seeks', [
    { group: STAGE_LAYER, blocks: [
      { id: 'dark', start: 0, rise: 2, what: { kind: 'dark' } },
      { id: 'look', start: 6, rise: 3, what: { kind: 'look', look: 'worship' } },
      { id: 'full', start: 14, rise: 4, what: { kind: 'full' } },
    ] },
    { group: 'front-wash', blocks: [{ id: 'front', start: 3, rise: 2, what: { kind: 'colour', preset: 'front-warm', level: 0.8 } }] },
    { group: 'back-wall', blocks: [{ id: 'back', start: 5, end: 8, rise: 1, what: { kind: 'colour', preset: 'back-amber', level: 1 } }] },
    { group: 'audience', blocks: [{ id: 'voice', start: 9, end: 20, rise: 1, what: { kind: 'follow', low: 0.1, high: 1 } }] },
  ], { recording: { id: 'r', name: 'r.wav', duration: 30, loudness, peaks: '' } });
  const show = showWith(t);
  let clock = 0;
  const engine = new Engine(show, 0);
  const runner = new TimelineRunner({
    show: () => show,
    apply: (cmd, o) => assert.equal(engine.apply(cmd, clock, o), null, JSON.stringify(cmd)),
    follow: (group, value) => engine.setLevelFollow(group, value, clock),
    now: () => clock,
  });
  runner.start(t, 0);
  let prev = engine.visibleLevels();
  let worst = 0;
  let seeks = 0;
  let nextSeek = 1;
  for (let n = 1; n <= 40 * 120; n++) {
    clock = n * 0.025;
    if (clock >= nextSeek && runner.running) {
      runner.report(random() * 25, random() < 0.9);
      seeks++;
      nextSeek = clock + 0.1 + random();
    }
    runner.tick();
    engine.frame(clock);
    const now = engine.visibleLevels();
    const own = engine.ownMotion();
    for (let k = 0; k < now.length; k++) worst = Math.max(worst, Math.abs(now[k]! - prev[k]!) - own[k]!);
    prev = now;
  }
  assert.ok(seeks > 100, `${seeks} seeks`);
  assert.ok(worst <= 0.05, `largest step ${(worst * 100).toFixed(2)}%`);
  assert.equal(engine.liveState(clock, 'off').canUndo, false, 'no Undo steps');
});

test('offsetMs: the lights run later than the sound by that much', () => {
  const t = christmas({ offsetMs: 400 });
  const r = rig(showWith(t));
  r.start(t);
  r.run(3.2);
  assert.equal(r.cmds('groupPreset', 'front-wash').length, 0, 'not yet at sound 3.2');
  r.run(0.3);
  const front = r.cmds('groupPreset', 'front-wash');
  assert.equal(front.length, 1);
  assert.ok(Math.abs(front[0]!.at - 3.4) < 0.03, `at ${front[0]!.at}`);
  // And earlier, with a negative offset.
  const early = christmas({ offsetMs: -400 });
  const e = rig(showWith(early));
  e.start(early);
  e.run(2.7);
  const ef = e.cmds('groupPreset', 'front-wash');
  assert.equal(ef.length, 1);
  assert.ok(Math.abs(ef[0]!.at - 2.6) < 0.03, `at ${ef[0]!.at}`);
});

test('blocks that point at something gone are skipped, with no crash (RF 5)', () => {
  const t = timeline('gone', [
    { group: STAGE_LAYER, blocks: [{ id: 'l', start: 0, what: { kind: 'look', look: 'no-such-look' } }] },
    { group: 'no-such-group', blocks: [{ id: 'g', start: 0, what: { kind: 'level', level: 0.5 } }] },
    { group: 'front-wash', blocks: [
      { id: 'p', start: 0, what: { kind: 'colour', preset: 'no-such-colour', level: 1 } },
      { id: 'e', start: 0.5, what: { kind: 'effect', preset: 'no-such-effect' } },
      { id: 'w', start: 1, what: { kind: 'colour', preset: 'back-amber', level: 1 } }, // another group's colour
      { id: 'ok', start: 1.5, rise: 1, what: { kind: 'level', level: 0.3 } },
    ] },
  ]);
  const r = rig(showWith(t));
  r.start(t);
  r.run(3);
  assert.deepEqual(r.sent.map((s) => s.cmd), [{ type: 'groupLevel', group: 'front-wash', value: 0.3, fade: 1 }]);
  assert.deepEqual(r.stops, ['end']);
});

test('a look on Whole stage is sent as the look itself; a group block at the same time comes after it', () => {
  const t = timeline('song', [
    { group: STAGE_LAYER, blocks: [
      { id: 'dark', start: 0, rise: 1, what: { kind: 'dark' } },
      { id: 'w', start: 1, rise: 3, what: { kind: 'look', look: 'worship' } },
    ] },
    { group: 'audience', blocks: [{ id: 'a', start: 1, rise: 2, what: { kind: 'colour', preset: 'aud-blue', level: 0.5 } }] },
  ]);
  const r = rig(showWith(t));
  r.start(t);
  const n = r.sent.length;
  r.run(1.1);
  assert.deepEqual(r.sent.slice(n).map((s) => s.cmd), [
    { type: 'look', id: 'worship', fade: 3 },
    { type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 2 },
    { type: 'groupLevel', group: 'audience', value: 0.5, fade: 2 },
  ]);
});

test('a look with no rise fades with its own fade time', () => {
  const t = timeline('song', [{ group: STAGE_LAYER, blocks: [{ id: 'w', start: 0, what: { kind: 'look', look: 'worship' } }] }]);
  const r = rig(showWith(t));
  r.start(t);
  assert.deepEqual(r.sent.map((s) => s.cmd), [{ type: 'look', id: 'worship' }]);
});

test('an effect is sent as the group\'s effect, with the block\'s own speed when it has one', () => {
  const show = baseShow();
  const fx = show.presets.find((p) => p.group === 'back-wall' && isEffectPreset(p))!;
  assert.ok(fx, 'the demo show has an effect for the back wall');
  const t = timeline('fx', [{ group: 'back-wall', blocks: [
    { id: 'a', start: 0, rise: 1, what: { kind: 'effect', preset: fx.id } },
    { id: 'b', start: 1, rise: 1, what: { kind: 'effect', preset: fx.id, speed: { seconds: 4 } } },
  ] }]);
  const r = rig({ ...show, timelines: [t] });
  r.start(t);
  assert.deepEqual(r.sent[0]!.cmd, { type: 'groupPreset', group: 'back-wall', preset: fx.id, fade: 1 });
  r.run(1.1);
  const own = r.cmds('groupEffect', 'back-wall');
  assert.equal(own.length, 1);
  const cmd = own[0]!.cmd as Extract<StageCommand, { type: 'groupEffect' }>;
  assert.deepEqual(cmd.effect.speed, { seconds: 4 });
  assert.equal(cmd.fade, 1);
  assert.equal(cmd.effect.effect, (fx.layers.find((l) => l.kind === 'effect') as any).effect);
});

test('a group with no block left goes back to how it was when the timeline started', () => {
  const t = timeline('back', [{ group: 'back-wall', blocks: [{ id: 'a', start: 1, end: 2, rise: 1.5, what: { kind: 'colour', preset: 'back-amber', level: 1 } }] }], { recording: { id: 'r', name: 'r.wav', duration: 4, loudness: '', peaks: '' } });
  const before: RuntimeState = { look: 'worship', groups: { 'back-wall': 'back-purple', 'front-wash': 'front-warm' }, master: 1, speed: 1, levels: { 'back-wall': 0.6, 'front-wash': 1 } };
  const r = rig(showWith(t), { before });
  r.start(t);
  r.run(1.1);
  const n = r.sent.length;
  r.run(1);
  assert.deepEqual(r.sent.slice(n).map((s) => s.cmd), [
    { type: 'groupPreset', group: 'back-wall', preset: 'back-purple', fade: 1.5 },
    { type: 'groupLevel', group: 'back-wall', value: 0.6, fade: 1.5 },
  ]);
  // Runs on to the recording's end (4 s), later than the last block.
  assert.equal(timelineLength(t), 4);
  r.run(1.8);
  assert.notEqual(r.runner.state, null);
  r.run(0.3);
  assert.equal(r.runner.state, null);
});

test('Follow the voice: the level rides the recording between low and high, and is let go at its end and at the end', () => {
  // 10 s of loudness: silent for 3 s, then loud.
  const bytes = Array.from({ length: 250 }, (_, i) => (i < 75 ? 0 : 255));
  const loudness = Buffer.from(bytes).toString('base64');
  const t = timeline('voice', [
    { group: STAGE_LAYER, blocks: [{ id: 'dark', start: 0, what: { kind: 'dark' } }] },
    { group: 'audience', blocks: [{ id: 'f', start: 2, end: 6, rise: 1, what: { kind: 'follow', low: 0.2, high: 0.9 } }] },
    { group: 'pulpit', blocks: [{ id: 'g', start: 2, rise: 1, what: { kind: 'follow', low: 0.1, high: 0.5 } }] },
  ], { recording: { id: 'r', name: 'r.wav', duration: 8, loudness, peaks: '' } });
  const r = rig(showWith(t));
  r.start(t);
  r.run(2.1);
  // The level comes up to full over the rise; the follow rides it.
  assert.deepEqual(r.cmds('groupLevel', 'audience').at(-1)!.cmd, { type: 'groupLevel', group: 'audience', value: 1, fade: 1 });
  const quiet = r.follows.filter((f) => f.group === 'audience').at(-1)!;
  assert.ok(Math.abs(quiet.value! - 0.2) < 1e-6, `quiet ${quiet.value}`);
  r.run(2);
  const loud = r.follows.filter((f) => f.group === 'audience').at(-1)!;
  assert.ok(Math.abs(loud.value! - 0.9) < 1e-6, `loud ${loud.value}`);
  // Sent on every tick, so a restarted engine gets it again.
  const ticks = r.follows.filter((f) => f.group === 'audience' && f.at > 3 && f.at <= 4).length;
  assert.ok(ticks >= 39, `${ticks} follow values in a second`);
  // Its block ends at 6: let go, and back to the level the timeline gives (Dark) over 1 s.
  r.run(2);
  const after = r.follows.filter((f) => f.group === 'audience' && f.at > 6.05);
  assert.deepEqual(after, []);
  assert.equal(r.follows.filter((f) => f.group === 'audience' && f.value === null).length, 1);
  assert.deepEqual(r.cmds('groupLevel', 'audience').at(-1)!.cmd, { type: 'groupLevel', group: 'audience', value: 0, fade: 1 });
  // The pulpit follows to the end, and is let go there.
  r.run(2.1);
  assert.deepEqual(r.stops, ['end']);
  assert.equal(r.follows.at(-1)!.group, 'pulpit');
  assert.equal(r.follows.at(-1)!.value, null);
});

test('Stop lets every follow go and leaves the stage as it is', () => {
  const loudness = Buffer.from(Array(250).fill(128)).toString('base64');
  const t = timeline('voice', [{ group: 'audience', blocks: [{ id: 'f', start: 0, what: { kind: 'follow', low: 0, high: 1 } }] }], { recording: { id: 'r', name: 'r.wav', duration: 10, loudness, peaks: '' } });
  const r = rig(showWith(t));
  r.start(t);
  r.run(1);
  const n = r.sent.length;
  r.runner.stop();
  assert.deepEqual(r.follows.at(-1), { at: r.time, group: 'audience', value: null });
  assert.equal(r.sent.length, n, 'no commands on Stop');
  assert.deepEqual(r.stops, ['stopped']);
  assert.equal(r.runner.state, null);
  r.run(1);
  assert.equal(r.sent.length, n);
});

test('a timeline deleted from the show while it runs stops it; an edited one takes effect', () => {
  const t = christmas();
  const r = rig(showWith(t));
  r.start(t);
  r.run(1);
  // The front wash's block is moved to 1.5.
  const edited = timeline('xmas', t.layers.map((l) => l.group === 'front-wash' ? { ...l, blocks: [{ ...l.blocks[0]!, start: 1.5 }] } : l));
  r.setShow(showWith(edited));
  r.run(0.6);
  assert.equal(r.cmds('groupPreset', 'front-wash').length, 1);
  r.setShow(showWith());
  r.run(0.1);
  assert.equal(r.runner.state, null);
  assert.deepEqual(r.stops, ['gone']);
});

// ---- In the server, over the WebSocket ----

const tempDir = () => mkdtempSync(join(tmpdir(), 'light-runner-'));

async function waitFor<T>(get: () => T | null | undefined | false, ms = 3000, what = 'a condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function page(app: App, headers?: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers });
  const seen: any[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) seen.push(JSON.parse(String(data)));
  });
  await new Promise((r) => ws.once('open', r));
  let ref = 0;
  const latest = (type: string, key = type) => seen.findLast((m) => m.type === type)?.[key];
  const reply = async (msg: Record<string, unknown>) => {
    const mine = ++ref;
    ws.send(JSON.stringify({ ...msg, ref: mine }));
    return (await waitFor(() => seen.find((m) => m.type === 'result' && m.ref === mine), 3000, `the reply to ${JSON.stringify(msg)}`)).error;
  };
  return {
    ws, seen,
    state: () => latest('state'),
    draft: () => latest('draftState', 'state'),
    send: (cmd: unknown) => reply({ type: 'command', cmd }),
    timeline: (msg: Record<string, unknown>) => reply(msg),
    report: (id: string, pos: number, playing = true) => ws.send(JSON.stringify({ type: 'timelinePosition', id, pos, playing })),
  };
}

async function withApp(fn: (app: App, dir: string, logs: string[]) => Promise<void>) {
  const dir = tempDir();
  const logs: string[] = [];
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: (m) => logs.push(m) });
  try {
    await app.start();
    await fn(app, dir, logs);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function liveShow(app: App): Promise<Show> {
  const res = await fetch(`http://127.0.0.1:${app.port}/api/show`);
  return parseShow(await res.json());
}

/** Short timelines for the server tests: a = Dark, then the back wall amber at 0.3, ends at 1.2; b = the audience low at 0, ends at 0.8. */
const shortA = () => timeline('a', [
  { group: STAGE_LAYER, blocks: [{ id: 'a-dark', start: 0, rise: 0.2, what: { kind: 'dark' } }] },
  { group: 'back-wall', blocks: [{ id: 'a-back', start: 0.3, rise: 0.2, what: { kind: 'colour', preset: 'back-amber', level: 1 } }] },
  { group: 'audience', blocks: [{ id: 'a-aud', start: 1.2, rise: 0.2, what: { kind: 'level', level: 0.5 } }] },
]);
const shortB = () => timeline('b', [{ group: 'audience', blocks: [
  { id: 'b-aud', start: 0, rise: 0.2, what: { kind: 'colour', preset: 'aud-blue', level: 0.7 } },
  { id: 'b-end', start: 0.8, rise: 0.2, what: { kind: 'level', level: 0.6 } },
] }]);
/** Runs for a minute, Dark at 0.2 (its own Dark must not stop it). */
const long = () => timeline('long', [
  { group: STAGE_LAYER, blocks: [{ id: 'l-dark', start: 0.2, rise: 0.2, what: { kind: 'dark' } }] },
  { group: 'pulpit', blocks: [{ id: 'l-end', start: 60, what: { kind: 'full' } }] },
]);

async function withTimelines(app: App, ...timelines: Timeline[]) {
  await app.setShow({ ...(await liveShow(app)), timelines });
}

test('server: a live timeline runs on the stage, shows in the live state, adds no Undo step, and stops at its end', () => withApp(async (app) => {
  await withTimelines(app, shortA());
  const p = await page(app);
  await waitFor(p.state);
  assert.equal(p.state().timeline, null);
  assert.equal(p.state().canUndo, false);
  assert.equal(await p.timeline({ type: 'timelineStart', id: 'a', at: 0 }), null);
  const running = await waitFor(() => p.state()?.timeline, 2000, 'the timeline in the live state');
  assert.equal(running.id, 'a');
  assert.equal(running.name, 'Timeline a');
  assert.equal(running.duration, 1.2);
  assert.equal(running.playing, true);
  await waitFor(() => p.state()?.groups['back-wall'].preset === 'back-amber', 2000, 'the back wall amber');
  await waitFor(() => p.state()?.timeline === null, 3000, 'the timeline to end');
  await waitFor(() => p.state()?.groups.audience.level === 0.5, 2000, 'the last block');
  assert.equal(p.state().groups['front-wash'].level, 0);
  assert.equal(p.state().canUndo, false, 'no Undo steps');
  p.ws.close();
}));

test('server: the page that started it goes away; the server carries on to the end (RF 1)', () => withApp(async (app) => {
  await withTimelines(app, shortA());
  const p = await page(app);
  await waitFor(p.state);
  assert.equal(await p.timeline({ type: 'timelineStart', id: 'a', at: 0 }), null);
  p.report('a', 0.1, true);
  await sleep(100);
  p.report('a', 0.2, true);
  p.ws.terminate();
  const q = await page(app);
  await waitFor(() => q.state()?.timeline, 1000, 'still running');
  await waitFor(() => q.state()?.timeline === null, 3000, 'the end');
  assert.equal(q.state().groups['back-wall'].preset, 'back-amber');
  q.ws.close();
}));

test('server: a paused page stays paused while it is there; when it goes the timeline plays on to the end', () => withApp(async (app) => {
  await withTimelines(app, shortA());
  const p = await page(app);
  const q = await page(app);
  await waitFor(p.state);
  assert.equal(await p.timeline({ type: 'timelineStart', id: 'a', at: 0 }), null);
  p.report('a', 0.1, false);
  await waitFor(() => q.state()?.timeline?.playing === false, 2000, 'paused');
  const held = q.state().timeline.pos;
  // Longer than the runner's own report timeout: the page is still there (its reports may be slowed in a background tab).
  await sleep(2300);
  assert.equal(q.state().timeline.playing, false);
  assert.equal(q.state().timeline.pos, held);
  p.ws.close();
  await waitFor(() => q.state()?.timeline?.playing === true, 2000, 'playing on by itself');
  await waitFor(() => q.state()?.timeline === null, 3000, 'the end');
  q.ws.close();
}));

test('server: Blackout, Basic lights and a song from another tablet stop it; its own Dark and a quick change do not', () => withApp(async (app) => {
  await withTimelines(app, long());
  const p = await page(app);
  const other = await page(app);
  await waitFor(p.state);
  for (const cmd of [{ type: 'blackout' }, { type: 'safe' }, { type: 'look', id: 'worship' }]) {
    assert.equal(await p.timeline({ type: 'timelineStart', id: 'long', at: 0 }), null);
    await waitFor(() => other.state()?.timeline?.id === 'long', 2000, 'running');
    // Its own Dark comes at 0.2.
    await waitFor(() => other.state()?.groups['front-wash'].level === 0, 2000, 'its Dark');
    await sleep(100);
    assert.equal(other.state().timeline?.id, 'long', 'its own Dark does not stop it');
    // Its Dark is levels, never a real Blackout.
    if (cmd.type === 'blackout') assert.notEqual(other.state().look, 'blackout');
    // A level from the other tablet does not stop it either.
    assert.equal(await other.send({ type: 'groupLevel', group: 'pulpit', value: 0.4 }), null);
    await sleep(100);
    assert.equal(other.state().timeline?.id, 'long');
    assert.equal(await other.send(cmd), null);
    await waitFor(() => other.state()?.timeline === null, 2000, `${cmd.type} to stop it`);
  }
  p.ws.close();
  other.ws.close();
}));

test('server: a device (HTTP) Blackout stops it too', () => withApp(async (app) => {
  await withTimelines(app, long());
  const p = await page(app);
  await waitFor(p.state);
  assert.equal(await p.timeline({ type: 'timelineStart', id: 'long', at: 0 }), null);
  await waitFor(() => p.state()?.timeline, 2000, 'running');
  assert.equal(await app.device({ kind: 'blackout' } as any, 'http'), null);
  await waitFor(() => p.state()?.timeline === null, 2000, 'stopped');
  p.ws.close();
}));

test('server: a second live Start stops the first; Stop from any page stops the live one (RF 2)', () => withApp(async (app) => {
  await withTimelines(app, long(), { ...long(), id: 'b', name: 'Timeline b' });
  const a = await page(app);
  const b = await page(app);
  await waitFor(a.state);
  assert.equal(await a.timeline({ type: 'timelineStart', id: 'long', at: 0 }), null);
  await waitFor(() => b.state()?.timeline?.id === 'long', 2000, 'long running');
  // A second page with the same timeline open sends nothing; only its Start counts.
  assert.equal(await b.timeline({ type: 'timelineStart', id: 'long', at: 30 }), null);
  await waitFor(() => (b.state()?.timeline?.pos ?? 0) >= 30, 2000, 'the second Start');
  // The first page's reports no longer move it.
  a.report('long', 1, true);
  await sleep(100);
  assert.ok(b.state().timeline.pos >= 30);
  assert.equal(await a.timeline({ type: 'timelineStart', id: 'b', at: 0 }), null);
  await waitFor(() => b.state()?.timeline?.id === 'b', 2000, 'b instead');
  // Stop with the wrong id leaves it; Stop with none stops it.
  assert.equal(await b.timeline({ type: 'timelineStop', id: 'long' }), null);
  await sleep(50);
  assert.equal(b.state().timeline?.id, 'b');
  assert.equal(await b.timeline({ type: 'timelineStop' }), null);
  await waitFor(() => b.state()?.timeline === null, 2000, 'stopped');
  a.ws.close();
  b.ws.close();
}));

test('server: a Prepare timeline changes only that page\'s draft while a live one runs (RF 2)', () => withApp(async (app) => {
  await withTimelines(app, long(), shortB());
  const live = await page(app);
  const prep = await page(app);
  await waitFor(live.state);
  assert.equal(await live.send({ type: 'look', id: 'worship', fade: 0 }), null);
  await waitFor(() => live.state()?.look === 'worship', 2000, 'worship');
  assert.equal(await live.timeline({ type: 'timelineStart', id: 'long', at: 0 }), null);
  await waitFor(() => live.state()?.groups['front-wash'].level === 0, 2000, 'the live Dark');
  // Prepare on the other page: it gets a draft of its own, made for it.
  assert.equal(await prep.timeline({ type: 'timelineStart', id: 'b', at: 0, prepare: true }), null);
  const draft = await waitFor(() => prep.draft()?.timeline?.id === 'b' && prep.draft(), 2000, 'the draft timeline');
  assert.equal(draft.timeline.playing, true);
  await waitFor(() => prep.draft()?.groups.audience.preset === 'aud-blue', 2000, 'the draft blue');
  // The stage is untouched by it, and the live one runs on.
  assert.equal(live.state().groups.audience.preset, 'aud-low');
  assert.equal(live.state().timeline.id, 'long');
  // A tap in Prepare doesn't stop the live timeline.
  assert.equal(await prep.send({ type: 'draft', cmd: { type: 'look', id: 'word' } }), null);
  await sleep(100);
  assert.equal(live.state().timeline?.id, 'long');
  // The Prepare one ended with that tap (a song in Prepare stops the Prepare timeline).
  await waitFor(() => prep.draft()?.timeline === null, 2000, 'the Prepare timeline stopped');
  // Started again, it runs to its end in the draft and stops there; the draft stays.
  assert.equal(await prep.timeline({ type: 'timelineStart', id: 'b', at: 0, prepare: true }), null);
  await waitFor(() => prep.draft()?.timeline?.id === 'b', 2000, 'again');
  await waitFor(() => prep.draft()?.timeline === null, 3000, 'its end');
  await waitFor(() => prep.draft()?.groups.audience.level === 0.6, 2000, 'its last block in the draft');
  // On the stage the audience is as the live timeline's Dark left it.
  assert.equal(live.state().groups.audience.level, 0);
  assert.equal(live.state().groups.audience.preset, 'aud-low');
  assert.equal(app.drafts, 1);
  // Stop from the Prepare page with prepare only touches its own.
  assert.equal(await prep.timeline({ type: 'timelineStart', id: 'b', at: 0, prepare: true }), null);
  await waitFor(() => prep.draft()?.timeline?.id === 'b', 2000, 'started once more');
  assert.equal(await prep.timeline({ type: 'timelineStop', id: 'b', prepare: true }), null);
  await waitFor(() => prep.draft()?.timeline === null, 2000, 'stopped in Prepare');
  assert.equal(live.state().timeline?.id, 'long');
  // Leaving Prepare (the page closes) ends its timeline with its draft.
  assert.equal(await prep.timeline({ type: 'timelineStart', id: 'b', at: 0, prepare: true }), null);
  prep.ws.close();
  await waitFor(() => app.drafts === 0, 2000, 'the draft gone');
  assert.equal(live.state().groups.audience.preset, 'aud-low');
  live.ws.close();
}));

test('server: follow values go to the engine while the timeline follows, and are let go at the end', () => withApp(async (app) => {
  const loudness = Buffer.from(Array(50).fill(200)).toString('base64');
  await withTimelines(app, timeline('v', [{ group: 'audience', blocks: [{ id: 'f', start: 0, what: { kind: 'follow', low: 0, high: 1 } }] }], { recording: { id: 'r', name: 'r.wav', duration: 0.6, loudness, peaks: '' } }));
  const seen: [string, number | null][] = [];
  const real = app.followLevel.bind(app);
  app.followLevel = (group, value) => {
    seen.push([group, value]);
    real(group, value);
  };
  const p = await page(app);
  await waitFor(p.state);
  assert.equal(await p.timeline({ type: 'timelineStart', id: 'v', at: 0 }), null);
  await waitFor(() => p.state()?.timeline === null && seen.length > 3, 3000, 'the end');
  assert.ok(seen.slice(0, -1).every(([g, v]) => g === 'audience' && Math.abs(v! - 200 / 255) < 1e-6));
  assert.deepEqual(seen.at(-1), ['audience', null]);
  p.ws.close();
}));

test('server: only the programmer starts a timeline; anyone can stop the live one; bad messages are refused', () => withApp(async (app) => {
  await withTimelines(app, long());
  const res = await fetch(`http://127.0.0.1:${app.port}/api/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ next: '2468' }) });
  assert.equal(res.status, 200);
  const login = await fetch(`http://127.0.0.1:${app.port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '2468' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const programmer = await page(app, { cookie });
  const operator = await page(app);
  await waitFor(operator.state);
  assert.match(await operator.timeline({ type: 'timelineStart', id: 'long', at: 0 }) ?? '', /programmer/i);
  assert.match(await programmer.timeline({ type: 'timelineStart', id: 'nope', at: 0 }) ?? '', /no timeline/i);
  assert.match(await programmer.timeline({ type: 'timelineStart', id: 'long', at: -1 }) ?? '', /invalid/i);
  assert.equal(await programmer.timeline({ type: 'timelineStart', id: 'long', at: 0 }), null);
  await waitFor(() => operator.state()?.timeline, 2000, 'running');
  // An operator's position reports are ignored.
  operator.report('long', 40, true);
  await sleep(100);
  assert.ok(operator.state().timeline.pos < 5);
  assert.equal(await operator.timeline({ type: 'timelineStop' }), null);
  await waitFor(() => operator.state()?.timeline === null, 2000, 'stopped by the operator page');
  programmer.ws.close();
  operator.ws.close();
}));

test('server: the page\'s reports move the live timeline (a seek)', () => withApp(async (app) => {
  await withTimelines(app, long());
  const p = await page(app);
  await waitFor(p.state);
  assert.equal(await p.timeline({ type: 'timelineStart', id: 'long', at: 0 }), null);
  p.report('long', 20, false);
  await waitFor(() => p.state()?.timeline?.pos === 20 && p.state().timeline.playing === false, 2000, 'paused at 20');
  await sleep(300);
  assert.equal(p.state().timeline.pos, 20);
  p.ws.close();
}));
