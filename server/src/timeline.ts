// The timeline runner: plays one timeline on the stage (or in a Prepare draft) in step with the recording on the page
// that pressed Start. Each tick it works out what every group should show (stateAt, from the timeline's blocks alone)
// and sends what changed as the ordinary commands, quiet (no Undo steps), through a callback the App gives it. The
// App's Stop hook never sees these: they don't go through App.run().
//
// The clock: the page's position reports are the truth while they come (a page ahead is eased in with mergeClock, a page
// slightly behind is waited for, a large difference is a seek); without them the runner goes on by itself (playing, or
// held where the page paused), and stops at the end. Only this thread's clock is used; nothing here is sent to the
// worker but commands and follow values.

import {
  STAGE_LAYER, changesBetween, followAt, mergeClock, parseLiveEffect, parseLivePreset, resolveEffect, stateAt,
  type EffectLayer, type GroupTarget, type LiveEffectLayer, type RuntimeState, type Show, type StageCommand, type Timeline, type TimelineStatus,
} from '../../packages/shared/src/index.ts';

/** How often the App ticks a runner (ms). */
export const TICK_MS = 25;
/**
 * Every change the timeline sends fades over at least this long (seconds): a rise of 0 never snaps. A change of colour and
 * level together is two eased fades multiplied (the colour's crossfade and the level), steepest at about 1.9 times the
 * average, on top of whatever else moves on a shared fixture: jump-check with timelines needs 1.5 s to stay under 5 % a
 * frame on both shows (0.8 s reaches 6.7 %, 1 s 5.8 %, 1.3 s 5.2 %).
 */
export const MIN_FADE = 1.5;
/** A seek, Start in the middle or an edit fades over this long (seconds): the spec's 1 s, raised to MIN_FADE. */
export const SEEK_FADE = MIN_FADE;
/** The end of a Follow the voice block fades back to the timeline's level over this long (seconds): the spec's 1 s, raised to MIN_FADE. */
export const FOLLOW_END_FADE = MIN_FADE;
/** A report that the sound has stopped this close to its end (seconds) means the recording has played out. */
export const END_SLACK = 0.5;

/** Why a runner stopped: its end, Stop (or Blackout, Basic lights, a song), its timeline deleted, or a problem. */
export type StopReason = 'end' | 'stopped' | 'gone' | 'problem';

export interface TimelineRunnerOptions {
  /** The show as it is now (a timeline edited while it runs takes effect from the next tick). */
  show: () => Show;
  /** Run a stage command. The runner's own changes are always quiet: no Undo step, and they never stop it. */
  apply: (cmd: StageCommand, opts: { quiet: true }) => void;
  /** What a group's level follows (0–1), or null to let it go; the engine smooths it. */
  follow: (group: string, value: number | null) => void;
  /** Seconds, on this thread's clock. */
  now: () => number;
  /** Called once when it stops, for whatever reason. */
  onStop?: (why: StopReason) => void;
  log?: (msg: string) => void;
}

/** How long a timeline runs: its last block's start or end, or its recording's length, whichever is later. */
export function timelineLength(timeline: Timeline): number {
  let end = timeline.recording?.duration ?? 0;
  for (const layer of timeline.layers) for (const b of layer.blocks) end = Math.max(end, b.end ?? b.start);
  return end;
}

/** The fade a change is sent with: its own, but never under MIN_FADE (so nothing the timeline does snaps). */
const fadeOf = (seconds: number): { fade: number } => ({ fade: Math.min(600, Math.max(MIN_FADE, seconds)) });

export class TimelineRunner {
  private readonly opts: TimelineRunnerOptions;
  private timelineId: string | null = null;
  /** Which Start this is (the App numbers them). */
  private runNo = 0;
  private name = '';
  private duration = 0;
  /** The stage when it started: a group the timeline no longer has a block for goes back to this. */
  private before: RuntimeState | null = null;
  // The sound's position: basePos at baseAt (this thread's seconds), moving on while playing.
  private basePos = 0;
  private baseAt = 0;
  private playing = false;
  /** The position never goes below this until a jump: a page slightly behind is waited for, never stepped back to. */
  private floor = 0;
  /** The page said its recording played out: the runner goes on by itself to the end (the lights may run later). */
  private soundEnded = false;
  /** Where the sound ends (the recording's length, else the timeline's), as of the last tick. */
  private soundEnd = 0;
  /** What each group was last given, and the timeline time (the lights', with the offset) of that tick. */
  private prev = new Map<string, GroupTarget>();
  private lastT = -Infinity;
  /** The next tick is a jump (Start in the middle, a seek): every change fades over SEEK_FADE. */
  private jumped = false;
  /** Groups whose level follows the voice now. */
  private readonly following = new Set<string>();

  constructor(opts: TimelineRunnerOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.timelineId !== null;
  }

  /** Which Start it runs (see TimelineStatus.run). */
  get run(): number {
    return this.runNo;
  }

  /** The id of the timeline it runs, or null. */
  get id(): string | null {
    return this.timelineId;
  }

  /** What the pages are told: null when it isn't running. */
  get state(): TimelineStatus | null {
    if (!this.timelineId) return null;
    return { id: this.timelineId, name: this.name, pos: Math.round(this.position(this.opts.now()) * 1000) / 1000, duration: this.duration, playing: this.playing, run: this.runNo };
  }

  /**
   * Play `timeline` from `at` seconds. At 0:00 its first blocks come with their rise (from whatever is on stage);
   * in the middle, the stage fades to the state there over 1 s. `before`: the stage as it is now. `run`: which Start this is.
   */
  start(timeline: Timeline, at: number, before: RuntimeState | null = null, run = 0): void {
    const now = this.opts.now();
    this.timelineId = timeline.id;
    this.runNo = run;
    this.name = timeline.name;
    this.duration = timelineLength(timeline);
    this.before = before;
    this.basePos = Math.max(0, at);
    this.baseAt = now;
    this.playing = true;
    this.floor = 0;
    this.soundEnded = false;
    this.soundEnd = timeline.recording?.duration ?? this.duration;
    this.prev = new Map();
    this.jumped = at > 0;
    this.lastT = -Infinity;
    this.tick();
  }

  /**
   * Where the page's recording is, and whether it plays. A page ahead is eased in; a page up to 0.3 s behind is waited
   * for (the lights hold, never step back); more than that either way is a seek. A stop at the recording's end (within
   * END_SLACK) means it played out: the runner goes on by itself to the timeline's end.
   */
  report(pos: number, playing: boolean): void {
    if (!this.timelineId || !Number.isFinite(pos)) return;
    pos = Math.max(0, pos);
    const atEnd = !playing && pos >= this.soundEnd - END_SLACK;
    // The page keeps saying it stopped at the end: nothing new.
    if (atEnd && this.soundEnded) return;
    const now = this.opts.now();
    const server = this.position(now);
    const merged = mergeClock(server, pos);
    if (merged.jumped) {
      this.jumped = true;
      this.floor = 0;
      this.basePos = pos;
    } else if (pos < server) {
      // Slightly behind: follow the page from where it is, but hold the lights until it has caught up.
      this.floor = server;
      this.basePos = pos;
    } else {
      this.basePos = merged.pos;
    }
    this.baseAt = now;
    this.soundEnded = atEnd;
    // A recording that played out: the lights go on by themselves (the last blocks may come later, with offsetMs).
    this.playing = playing || atEnd;
  }

  /** The page that reported has gone: the runner goes on by itself from where it is, playing if the page played, held if it was paused. */
  release(): void {
    if (!this.timelineId) return;
    const now = this.opts.now();
    this.basePos = this.position(now);
    this.baseAt = now;
    this.floor = 0;
  }

  /**
   * The engine started again (its worker restarted), or a stage Undo moved the lights: send the whole state again,
   * over the seek fade, as after a seek.
   * The follow values go again on every tick anyway.
   */
  resync(): void {
    if (!this.timelineId) return;
    this.prev = new Map();
    this.jumped = true;
  }

  /** Stop where it is: every follow is let go; the stage stays as it is. */
  stop(): void {
    this.finish('stopped');
  }

  /** One step: work out the state at the lights' time and send what changed. */
  tick(): void {
    if (!this.timelineId) return;
    try {
      this.step();
    } catch (err) {
      // Never left to throw every 25 ms: the timeline stops, the stage stays.
      this.opts.log?.(`Timeline "${this.name}" stopped because of a problem: ${(err as Error)?.stack ?? String(err)}`);
      this.finish('problem');
    }
  }

  private position(now: number): number {
    return Math.max(this.floor, this.playing ? this.basePos + (now - this.baseAt) : this.basePos);
  }

  private step(): void {
    const now = this.opts.now();
    const show = this.opts.show();
    const timeline = show.timelines.find((t) => t.id === this.timelineId);
    if (!timeline) {
      this.finish('gone');
      return;
    }
    this.name = timeline.name;
    this.duration = timelineLength(timeline);
    this.soundEnd = timeline.recording?.duration ?? this.duration;
    const pos = this.position(now);
    // The lights run offsetMs later than the sound (earlier when negative): a block at b comes when the sound is at b + offset.
    const t = Math.max(0, pos - timeline.offsetMs / 1000);
    const next = stateAt(timeline, show, t);
    // Time passing (not a jump, and forwards) uses the blocks' rise; anything else fades over 1 s.
    const passing = !this.jumped && t >= this.lastT;
    this.send(changesBetween(this.prev, next), next, timeline, show, passing, t);
    // A command can end it (a Prepare draft that met a problem stops its timeline).
    if (!this.timelineId) return;
    this.follow(next, timeline, t);
    this.prev = next;
    this.lastT = t;
    this.jumped = false;
    if (Math.min(pos, t) >= this.duration) this.finish('end');
  }

  private finish(why: StopReason): void {
    if (!this.timelineId) return;
    for (const group of this.following) this.opts.follow(group, null);
    this.following.clear();
    this.timelineId = null;
    this.prev = new Map();
    this.before = null;
    this.opts.onStop?.(why);
  }

  /** How long a group's change should take. */
  private fadeFor(next: GroupTarget | null, prev: GroupTarget | undefined, passing: boolean, t: number): number {
    if (!passing) return SEEK_FADE;
    if (!next) return prev ? prev.rise : SEEK_FADE; // its block ended: back over that block's rise
    if (next.block !== prev?.block) {
      // A block that started in this tick comes with its rise.
      if (next.started > this.lastT && next.started <= t) return next.rise;
      // A block with an end has passed: back over its rise (a Follow the voice block over 1 s).
      if (next.handedBack) return prev?.follow && !next.follow ? FOLLOW_END_FADE : next.handedBack.rise;
    }
    // A block edited while it runs.
    return SEEK_FADE;
  }

  private send(changes: { group: string; target: GroupTarget | null }[], next: Map<string, GroupTarget>, timeline: Timeline, show: Show, passing: boolean, t: number): void {
    if (!changes.length) return;
    const blocks = new Map(timeline.layers.flatMap((l) => l.blocks.map((b) => [b.id, { block: b, stage: l.group === STAGE_LAYER }] as const)));
    const lookOf = (target: GroupTarget | null | undefined) => {
      const found = target ? blocks.get(target.block) : undefined;
      return found?.stage && found.block.what.kind === 'look' ? { block: found.block.id, look: found.block.what.look } : null;
    };
    const done = new Set<string>();
    // A look on Whole stage that comes in now is sent as the look itself (its tempo, and the operator page shows the song),
    // once; the groups it lists that a later block of their own holds get theirs again after it.
    const prevBlocks = new Set([...this.prev.values()].map((p) => p.block));
    for (const change of changes) {
      const look = lookOf(change.target);
      if (!look || done.has(change.group) || prevBlocks.has(look.block)) continue;
      const entry = show.looks.find((l) => l.id === look.look);
      if (!entry) continue;
      this.opts.apply({ type: 'look', id: look.look, ...fadeOf(this.fadeFor(change.target, this.prev.get(change.group), passing, t)) }, { quiet: true });
      for (const [group, target] of next) if (target.block === look.block) done.add(group);
      for (const e of entry.groups) {
        const target = next.get(e.group);
        if (!target || target.block === look.block || done.has(e.group)) continue;
        this.sendGroup(e.group, target, this.prev.get(e.group), passing, t, show);
        done.add(e.group);
      }
      prevBlocks.add(look.block);
    }
    for (const { group, target } of changes) {
      if (done.has(group)) continue;
      this.sendGroup(group, target, this.prev.get(group), passing, t, show);
    }
  }

  /** A group's colour or effect, and its level (full while it follows the voice), over the fade its change asks for. */
  private sendGroup(group: string, target: GroupTarget | null, prev: GroupTarget | undefined, passing: boolean, t: number, show: Show): void {
    const fade = fadeOf(this.fadeFor(target, prev, passing, t));
    const apply = (cmd: StageCommand) => this.opts.apply(cmd, { quiet: true });
    if (!target) {
      // No block left for it: back to how it was when the timeline started.
      for (const cmd of this.restore(group, fade, show)) apply(cmd);
      return;
    }
    if (target.effect) apply(this.effectCommand(group, target.effect, fade, show));
    else if (target.preset) apply({ type: 'groupPreset', group, preset: target.preset, ...fade });
    // While it follows the voice the level is full and the follow (low to high) rides on it.
    apply({ type: 'groupLevel', group, value: target.follow ? 1 : target.level, ...fade });
  }

  /** The group's effect: the preset itself, or at the block's own speed as a live effect built from it. */
  private effectCommand(group: string, effect: NonNullable<GroupTarget['effect']>, fade: { fade?: number }, show: Show): StageCommand {
    const preset = show.presets.find((p) => p.id === effect.preset);
    const layer = preset?.layers.find((l): l is EffectLayer => l.kind === 'effect');
    if (!preset || !layer || !effect.speed || JSON.stringify(effect.speed) === JSON.stringify(layer.speed)) {
      return { type: 'groupPreset', group, preset: effect.preset, ...fade };
    }
    const resolved = resolveEffect(layer, new Map(show.palettes.map((p) => [p.id, p])));
    const live: LiveEffectLayer = { ...resolved, speed: effect.speed };
    return { type: 'groupEffect', group, effect: live, ...fade };
  }

  /** What puts a group back as it was at the start: its colour (a show colour, an Any colour or an effect) and level. */
  private restore(group: string, fade: { fade?: number }, show: Show): StageCommand[] {
    const before = this.before;
    if (!before) return [];
    const out: StageCommand[] = [];
    const pid = before.groups[group];
    const live = pid ? parseLivePreset(pid) : null;
    const fx = pid ? parseLiveEffect(pid) : null;
    const preset = pid ? show.presets.find((p) => p.id === pid && p.group === group) : undefined;
    if (preset) out.push({ type: 'groupPreset', group, preset: preset.id, ...fade });
    else if (live && live.group === group) {
      const { group: _g, colour, ...extras } = live;
      out.push({ type: 'groupColour', group, colour, ...extras, ...fade });
    } else if (fx && fx.group === group && before.effects?.[pid!]) {
      const layer = before.effects[pid!]!;
      out.push({ type: 'groupEffect', group, effect: resolveEffect(layer, new Map(show.palettes.map((p) => [p.id, p]))) as LiveEffectLayer, ...fade });
    }
    // Basic lights' and Blackout's own colours aren't show colours; the level still goes back.
    const level = before.groups[group] === null ? 0 : before.levels[group];
    if (level !== undefined) out.push({ type: 'groupLevel', group, value: level, ...fade });
    return out;
  }

  /** Follow the voice: each group that follows gets its value every tick (so a restarted engine has it again); the rest are let go. */
  private follow(next: Map<string, GroupTarget>, timeline: Timeline, t: number): void {
    for (const [group, target] of next) {
      if (!target.follow) continue;
      // Without a recording there is no loudness to ride: the block's high level.
      const loud = timeline.recording ? followAt(timeline.recording, t) : 1;
      this.opts.follow(group, target.follow.low + (target.follow.high - target.follow.low) * loud);
      this.following.add(group);
    }
    for (const group of [...this.following]) {
      if (next.get(group)?.follow) continue;
      this.opts.follow(group, null);
      this.following.delete(group);
    }
  }
}

