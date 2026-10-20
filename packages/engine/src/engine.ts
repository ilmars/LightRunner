// The lighting engine. Pure: no timers, no network, no files. The caller
// passes `now` (seconds on a monotonic clock) and gets DMX buffers back, so the
// same code drives output, tests, blind preview and the soak test.

import {
  BLACKOUT, BLACKOUT_PRESET, HEX_COLOUR, LiveEffectLayer, SAFE, SAFE_LIGHT as SAFE_COLOUR, SAFE_PRESET, displayColour, effectKey, findProfile,
  liveEffectId, livePresetId, parseLiveEffect, parseLivePreset, resolveColour,
  type StageCommand, type EffectLayer, type LiveState, type Look, type LookEntry, type ManualTarget, type OutputStatus,
  type GroupStatus, type Layer, type Palette, type Preset, type RuntimeState, type Show, type StageState,
} from '../../shared/src/index.ts';
import { SafeRates } from './effects.ts';
import { Crossfade, Ramp } from './fade.ts';
import { advancePhases, compilePreset, fixedPreset, moves, renderPreset, type CompiledPreset, type LayerContext } from './layers.ts';
import { copy, dark, fromHex, mix, mix2, withoutUv, type Light } from './light.ts';
import { hasWideColour, planChannels, visibleCells, visibleLevel, visualOf, writeCells, writeSmoke, type ChannelPlan } from './output.ts';

/** Safe's fixed warm white stage wash. */
const SAFE_LIGHT = fromHex(SAFE_COLOUR.hex, SAFE_COLOUR.white, SAFE_COLOUR.intensity);
const DARK = dark();
/** Flash: full white, snapping on and off. */
const FLASH_LIGHT = fromHex('#ffffff');
const SAFE_FADE = 1;
/**
 * Safe also brings master, speed and group levels back to default. Those
 * multiply with the wash fading in, so they move over 2 s to keep the
 * combined change under 5% per frame.
 */
const SAFE_RESET = 2;
const BLACKOUT_FADE = 1;
/** A look fades each group's level over the preset's fade time multiplied by this. */
const LEVEL_FADE_FACTOR = 1;
/** Fader and dial moves are smoothed over this long so they never step. */
const SMOOTH = 0.2;
/** Manual takes over this fast, and follows the finger with this smoothing. */
const MANUAL_IN = 0.2;
/** Release fades back to the running preset over this long. */
const MANUAL_OUT = 1;
const DEFAULT_FADE = 3;
/** The stage tempo (beats per minute) until a look or the tempo command sets one. */
const DEFAULT_TEMPO = 120;
/** Tempo commands this close together (seconds) are one Undo step. */
const TEMPO_RUN_SECONDS = 3;

/** A held Puff runs a smoke machine at this level, whatever its slider says. */
const PUFF_LEVEL = 1;
/** A Puff held longer than this (seconds) ends by itself, even with the button still down. */
const PUFF_MAX = 15;
/** Basic lights and Blackout turn smoke off over this long (keeps the 5% rule). */
const SMOKE_OFF = 1;

/** Undo fades back over this long, and keeps this many steps. */
const UNDO_FADE = 2;
const UNDO_STEPS = 20;

const SAFE_ID = SAFE_PRESET;
const BLACKOUT_ID = BLACKOUT_PRESET;

interface Snapshot {
  look: string | null;
  lastLook: string | null;
  groups: Record<string, string | null>;
  /** Each group's level target. */
  levels: Record<string, number>;
  beforeBlackout: Record<string, string | null> | null;
  /** Stage tempo in beats per minute. */
  bpm: number;
}

interface PresetRun {
  preset: CompiledPreset;
  /** Effect time in seconds, advanced by speed × elapsed time. */
  time: number;
  /** Beat phase in beats, advanced by tempo ÷ 60 × speed × elapsed time. */
  beats: number;
  /** Each layer's phase in cycles, advanced at its safe rate (see advancePhases). */
  cycles: number[];
  /**
   * For a preset that moves: how bright it made each segment of the line look
   * last frame (NaN before its first frame), for ownMotion.
   */
  levels: number[];
}

function newRun(preset: CompiledPreset, cycles: number[]): PresetRun {
  return { preset, time: 0, beats: 0, cycles, levels: [] };
}

class ManualRun {
  target: Light;
  current: Light;
  weight = new Ramp(0);
  releasing = false;

  constructor(start: Light, now: number) {
    this.target = copy(dark(), start);
    this.current = copy(dark(), start);
    this.weight.set(1, now, MANUAL_IN);
  }

  /** Follow the target with a one-pole filter that settles in about 0.2 s. */
  follow(dt: number): void {
    const a = 1 - Math.exp(-dt / (MANUAL_IN / 3));
    const t = this.target, c = this.current;
    c.r += (t.r - c.r) * a;
    c.g += (t.g - c.g) * a;
    c.b += (t.b - c.b) * a;
    c.w += (t.w - c.w) * a;
    c.a += (t.a - c.a) * a;
    c.u += (t.u - c.u) * a;
    c.i += (t.i - c.i) * a;
  }
}

class GroupRun {
  readonly id: string;
  /** Fixture indices, in group order. */
  fixtures: number[] = [];
  /**
   * The group's line of segments: its fixtures in group order, each fixture's
   * segments in order (backwards when it is reversed). The fixture of each segment.
   */
  line: number[] = [];
  /** Fixture index → where its segments start in the line. */
  position = new Map<number, number>();
  presets = new Crossfade<PresetRun>();
  manual: ManualRun | null = null;
  level = new Ramp(1);
  /**
   * A smoke or haze machine. It has no presets: its output is its level (or
   * PUFF_LEVEL while Puff is held), and only its slider, Puff, Basic lights
   * and Blackout change it.
   */
  smoke = false;
  /** A smoke group's output this frame. */
  smokeOut = 0;
  /** This group's light for each segment of its line. */
  out: Light[] = [];
  /** For each segment of its line: the largest change any of its running presets made by itself this frame. */
  motion: number[] = [];

  constructor(id: string) {
    this.id = id;
  }

  setFixtures(fixtures: number[], runs: readonly FixtureRun[]): void {
    this.fixtures = fixtures;
    this.position = new Map();
    this.line = [];
    for (const f of fixtures) {
      this.position.set(f, this.line.length);
      for (let c = 0; c < runs[f].cells.length; c++) this.line.push(f);
    }
    while (this.out.length < this.line.length) this.out.push(dark());
    this.out.length = this.line.length;
    this.motion = new Array<number>(this.line.length).fill(0);
  }
}

class FixtureRun {
  readonly id: string;
  plan: ChannelPlan;
  /** Which group drives this fixture. The most recent change wins, and the handover fades. */
  owners = new Crossfade<string>();
  manual: ManualRun | null = null;
  /** Smoke groups this fixture is in. When there are any, only they drive it. */
  smokeGroups: GroupRun[] = [];
  /** Hung the other way round: its segments run backwards along a group's line. */
  reversed = false;
  /** Where this fixture's first segment is in the visual, counted in segments. */
  visualAt = 0;
  /** Final light of each segment after manual and master, before gamma. */
  cells: Light[] = [];
  /** Each segment's own motion this frame: the most a preset running there changed it by itself. */
  motion: number[] = [];
  /** It has a colour channel shared by all its segments, so one segment's motion shows on all of them. */
  wide = false;

  constructor(id: string, plan: ChannelPlan) {
    this.id = id;
    this.plan = plan;
    this.setPlan(plan);
  }

  /** The fixture's first segment (the whole fixture when it has one). */
  get light(): Light {
    return this.cells[0]!;
  }

  setPlan(plan: ChannelPlan): void {
    this.plan = plan;
    while (this.cells.length < plan.cells) this.cells.push(dark());
    this.cells.length = plan.cells;
    this.motion = new Array<number>(plan.cells).fill(0);
    this.wide = hasWideColour(plan);
  }
}

/** An Any colour pick as the operator page shows it, or null for any other preset. */
function liveView(preset: string | null): GroupStatus['live'] {
  const live = preset ? parseLivePreset(preset) : null;
  if (!live) return null;
  const { colour, white = 0, amber = 0, uv = 0 } = live;
  return { colour, white, amber, uv, display: displayColour(colour, live) };
}

function smokeRefusal(name: string): string {
  return `"${name}" is a smoke machine: use its slider or Puff`;
}

/** True when two presets are one static layer of the same light (never an effect). */
function sameLight(a: CompiledPreset, b: CompiledPreset): boolean {
  if (a.layers.length !== 1 || b.layers.length !== 1) return false;
  const p = a.layers[0]!, q = b.layers[0]!;
  if (p.kind !== 'static' || q.kind !== 'static') return false;
  const x = p.light, y = q.light;
  const near = (p: number, q: number) => Math.abs(p - q) < 1e-9;
  return near(x.r, y.r) && near(x.g, y.g) && near(x.b, y.b) && near(x.w, y.w) && near(x.a, y.a) && near(x.u, y.u) && near(x.i, y.i);
}

/** A preset's layers with palette colours looked up, so two layers compare by the light they make. */
function resolvedLayers(layers: Layer[], palettes: Palette[]): Layer[] {
  const byId = new Map(palettes.map((p) => [p.id, p]));
  return layers.map((l) => (l.kind === 'static'
    ? { ...l, colour: resolveColour(l.colour, byId) }
    : { ...l, colours: l.colours.map((c) => resolveColour(c, byId)) }));
}

/** True when the group runs (or is fading into) a preset with an effect in it, as Save sees it (isEffectPreset). */
function runsEffect(group: GroupRun): boolean {
  return group.presets.current?.preset.layers.some((l) => l.kind === 'effect') ?? false;
}

/** The stage's beat and seconds clocks, which every new effect run starts from (see Engine.adoptClock). */
export interface StageClock {
  beats: number;
  seconds: number;
}

export interface Frame {
  /** DMX data per universe, 512 bytes each. */
  universes: Map<number, Uint8Array>;
  /** Display colour per segment, 3 bytes RGB each, for the visualiser: fixtures in show order, each fixture's segments in channel order. */
  visual: Uint8Array;
}

export class Engine {
  private show!: Show;
  private presets = new Map<string, CompiledPreset>();
  private looks = new Map<string, Look>();
  private groups = new Map<string, GroupRun>();
  private fixtures: FixtureRun[] = [];
  private fixtureIndex = new Map<string, number>();
  private universes = new Map<number, Uint8Array>();
  private visual = new Uint8Array(0);

  /** Groups being flashed, and the fixtures in them (recomputed when either changes). */
  private flash = new Set<string>();
  private flashed = new Set<number>();
  /** When each smoke group's Puff started, for the PUFF_MAX cap. */
  private puffStart = new Map<string, number>();

  private master = new Ramp(1);
  private speed = new Ramp(1);
  /** Stage tempo in beats per minute. */
  private bpm = DEFAULT_TEMPO;
  /**
   * The stage's one beat clock (beats, at the tempo and the speed dial) and seconds
   * clock (with the speed dial), never reset: every effect starts in step with them.
   */
  private stageBeats = 0;
  private stageSeconds = 0;
  private look: string | null = null;
  private lookStart = 0;
  private lookDur = 0;
  /** Each group's preset before Blackout, so any look brings the whole stage back. */
  private beforeBlackout: Record<string, string | null> | null = null;
  /** Stage snapshots before each look or preset change, newest last. */
  private history: Snapshot[] = [];
  /** True when the last apply() added an Undo step. */
  recorded = false;
  /** The group and live preset of the last Any colour (or live effect) send that added an Undo step, for the drag it starts. */
  private lastColourStep: { group: string; key: string } | null = null;
  /** When the last tempo command of the current run was applied (stage seconds), or null when there is no run to join. */
  private tempoRunAt: number | null = null;
  /**
   * Live effects (groupEffect) by their `fx:<group>:<n>` id, and their compiled presets. Kept while
   * the stage, Blackout or an Undo step still names them (see pruneLiveEffects).
   */
  private liveEffects = new Map<string, EffectLayer>();
  private liveCompiled = new Map<string, CompiledPreset>();
  /** Effects' safe rates, kept from one show edit to the next so only new or changed effects are measured. */
  private rates = new SafeRates();
  /** The `n` of the next live effect id. */
  private nextEffect = 1;
  private lastLook: string | null = null;
  /** Operator's fade time for look and preset changes; null = each look's own. */
  private fadeTime: number | null = null;
  private last: number | null = null;
  private scratch: Light[] = [];
  private scratchWeights: number[] = [];
  private scratchLights: Light[] = [];
  /** A fixture's owning groups this frame, where its segments start in each, and their weights. */
  private scratchOwners: GroupRun[] = [];
  private scratchStarts: number[] = [];
  private scratchOwnerWeights: number[] = [];

  constructor(show: Show, now = 0) {
    this.setShow(show, now);
  }

  /** Load a new or edited show without disturbing what is on stage. */
  setShow(show: Show, now: number): void {
    const before = this.show as Show | undefined;
    this.show = show;
    const palettes = new Map<string, Palette>(show.palettes.map((p) => [p.id, p]));
    this.presets = new Map(show.presets.map((p) => [p.id, compilePreset(p, palettes, this.rates)]));
    this.rates.prune();
    this.looks = new Map(show.looks.map((l) => [l.id, l]));

    const oldFixtures = new Map(this.fixtures.map((f) => [f.id, f]));
    this.fixtures = [];
    this.fixtureIndex = new Map();
    for (const f of show.fixtures) {
      const profile = findProfile(show, f.profile);
      if (!profile) continue;
      const plan = planChannels(f, profile, show.settings.gamma);
      const run = oldFixtures.get(f.id) ?? new FixtureRun(f.id, plan);
      run.setPlan(plan);
      run.reversed = f.reversed ?? false;
      this.fixtureIndex.set(f.id, this.fixtures.length);
      this.fixtures.push(run);
    }

    const oldGroups = this.groups;
    this.groups = new Map();
    for (const g of show.groups) {
      const run = oldGroups.get(g.id) ?? new GroupRun(g.id);
      const smoke = g.kind === 'smoke';
      if (smoke && !run.smoke) {
        // A new smoke group, or a light group that became one, starts off. A flash held on it is no Puff.
        run.level.set(0, now, 0);
        run.presets = new Crossfade<PresetRun>();
        run.manual = null;
        this.flash.delete(g.id);
      } else if (!smoke && run.smoke) {
        // Back to a light group: a light's dimmer starts at full, not at whatever the smoke was.
        run.level.set(1, now, 0);
        this.flash.delete(g.id);
        this.puffStart.delete(g.id);
      }
      run.smoke = smoke;
      run.setFixtures(g.fixtures.map((id) => this.fixtureIndex.get(id)).filter((i): i is number => i !== undefined), this.fixtures);
      // A colour (or effect) edited while it is lit fades to the new one instead of snapping.
      const lit = this.editedColour(run, before, now);
      // Running presets pick up edits; deleted ones keep running until they fade out.
      run.presets.update((key, item) => {
        const fresh = this.presets.get(key);
        return fresh ? { ...item, preset: fresh } : item;
      });
      if (lit) {
        const started = this.setPreset(run, lit.preset, this.fadeTime ?? lit.preset.fade, now, false);
        // An edited effect carries on from where it was, so only its settings change across the fade.
        if (started && moves(lit.preset)) {
          started.time = lit.was.time;
          started.beats = lit.was.beats;
          started.cycles = lit.was.cycles.slice();
        }
      }
      this.groups.set(g.id, run);
    }

    // A fixture nobody has driven yet belongs to its first group. A fixture in a smoke group is a smoke machine.
    for (const f of this.fixtures) f.smokeGroups = [];
    for (const g of this.groups.values()) {
      for (const f of g.fixtures) {
        const run = this.fixtures[f];
        if (run.owners.size === 0) run.owners.push(g.id, () => g.id, now, 0);
        if (g.smoke) {
          run.smokeGroups.push(g);
          run.manual = null;
        }
      }
    }

    this.universes = new Map();
    for (const f of this.fixtures) {
      if (!this.universes.has(f.plan.universe)) this.universes.set(f.plan.universe, new Uint8Array(512));
    }
    let segments = 0;
    for (const f of this.fixtures) {
      f.visualAt = segments;
      segments += f.cells.length;
    }
    this.visual = new Uint8Array(segments * 3);

    for (const id of this.flash) if (!this.groups.has(id)) this.flash.delete(id);
    for (const id of this.puffStart.keys()) if (!this.flash.has(id)) this.puffStart.delete(id);
    this.updateFlashed();
    this.adoptSaved();
    if (before) {
      this.adoptAdded(before);
      this.releaseRemoved(before);
    }
  }

  /** The look whose entries the operator page compares the stage with: the current look, or the safe look on Basic lights. */
  private currentLook(): Look | undefined {
    if (!this.look || this.look === BLACKOUT) return undefined;
    const id = this.look === SAFE ? this.show.operator.safeLook : this.look;
    return id ? this.looks.get(id) : undefined;
  }

  /**
   * After Save, a look's entry names a custom preset for what a group was
   * already showing (an Any colour pick, Basic lights or Off). The group then
   * runs that preset under its own id, with no fade, so the look no longer
   * reads as changed. Groups running anything else are left alone.
   */
  private adoptSaved(): void {
    const look = this.currentLook();
    if (!look) return;
    for (const entry of look.groups) {
      const group = this.groups.get(entry.group);
      const key = group?.presets.currentKey;
      if (!group || group.smoke || !key || key === entry.preset) continue;
      const effect = this.liveEffects.get(key);
      if (!(key === SAFE_ID || key === BLACKOUT_ID || parseLivePreset(key) || effect)) continue;
      const saved = this.show.presets.find((p) => p.id === entry.preset);
      const target = this.presets.get(entry.preset);
      const running = group.presets.current?.preset;
      if (!saved?.custom || !target || !running || target.group !== group.id) continue;
      // A live effect is the same as a saved one when its one layer is that effect; the run (and its phase) carries on.
      const same = effect
        ? saved.layers.length === 1 && saved.layers[0]!.kind === 'effect' && effectKey(saved.layers[0]!) === effectKey(effect)
        : sameLight(target, running);
      if (!same) continue;
      group.presets.rekey(key, target.id, { ...group.presets.current!, preset: target });
    }
  }

  /**
   * The group runs a one-layer preset (a plain colour or an effect) whose layer the new show
   * changed: the running copy is set aside under a spare key to fade out, and the new one to
   * fade in. Returns the new preset to start and the run set aside, or null (everything else
   * just takes the edit in place).
   */
  private editedColour(group: GroupRun, before: Show | undefined, now: number): { preset: CompiledPreset; was: PresetRun } | null {
    const key = group.presets.currentKey;
    const running = group.presets.current;
    if (!before || !key || !running) return null;
    const was = before.presets.find((p) => p.id === key);
    const is = this.show.presets.find((p) => p.id === key);
    const fresh = this.presets.get(key);
    if (!was || !is || !fresh || was.layers.length !== 1 || is.layers.length !== 1) return null;
    // Compared with palette colours looked up, so a palette edit that moves a lit colour fades like any other edit.
    if (JSON.stringify(resolvedLayers(was.layers, before.palettes)) === JSON.stringify(resolvedLayers(is.layers, this.show.palettes))) return null;
    if (!group.presets.rekey(key, `${key}~${now}`, running)) return null;
    return { preset: fresh, was: running };
  }

  /**
   * A colour added to a group's list (Add to colours) while the group runs that
   * same colour live: the group runs the new preset under its own id, with no
   * fade, so the picker shows its name. Only presets that weren't in the show
   * before count, and only when the light is identical.
   */
  private adoptAdded(before: Show): void {
    const known = new Set(before.presets.map((p) => p.id));
    const added = this.show.presets.filter((p) => !known.has(p.id) && !p.custom);
    if (!added.length) return;
    for (const group of this.groups.values()) {
      const key = group.presets.currentKey;
      const running = group.presets.current;
      if (!key || !running || !parseLivePreset(key)) continue;
      const found = added.find((p) => p.group === group.id && sameLight(this.presets.get(p.id)!, running.preset));
      const target = found && this.presets.get(found.id);
      if (target) group.presets.rekey(key, target.id, { ...running, preset: target });
    }
  }

  /**
   * The reverse, for an Undo of that edit: a group running a plain single-colour
   * preset the new show no longer has carries on as the same colour live, rather than
   * naming a preset that isn't there (the next Save would refuse it).
   */
  private releaseRemoved(before: Show): void {
    const gone = new Map(before.presets.filter((p) => !this.presets.has(p.id)).map((p) => [p.id, p]));
    if (!gone.size) return;
    /** The live colour that is the same light as a removed plain preset, or null. */
    const liveOf = (old: Preset | undefined, group: string): string | null => {
      if (!old || old.group !== group || old.layers.length !== 1) return null;
      const layer = old.layers[0]!;
      if (layer.kind !== 'static' || !('hex' in layer.colour) || layer.intensity !== 1) return null;
      // White, amber and UV go with it, so the stage keeps the same light.
      return livePresetId(group, layer.colour.hex, layer.colour);
    };
    for (const group of this.groups.values()) {
      const key = group.presets.currentKey;
      const running = group.presets.current;
      const id = key ? liveOf(gone.get(key), group.id) : null;
      const live = id ? this.presetFor(id, group.id) : undefined;
      if (key && running && live) group.presets.rekey(key, live.id, { ...running, preset: live });
    }
    // Blackout remembers what each group ran; the next look brings that back, so it must not name a removed preset.
    if (this.beforeBlackout) {
      for (const [gid, pid] of Object.entries(this.beforeBlackout)) {
        if (pid && gone.has(pid)) this.beforeBlackout[gid] = liveOf(gone.get(pid), gid);
      }
    }
  }

  /** Fixtures that light groups are flashing. A smoke group's flash is its Puff, worked out per group. */
  private updateFlashed(): void {
    this.flashed = new Set();
    for (const id of this.flash) {
      const group = this.groups.get(id);
      if (group && !group.smoke) for (const f of group.fixtures) this.flashed.add(f);
    }
  }

  /** Apply a command. Returns an error message, or null when it worked. */
  apply(cmd: StageCommand, now: number): string | null {
    this.recorded = false;
    if (cmd.type === 'undo') {
      this.lastColourStep = null;
      this.tempoRunAt = null;
      return this.undo(now);
    }
    // A later send of the same Any colour (or effect) drag joins the drag's one Undo step,
    // as long as nothing else has changed the group since.
    const drag = cmd.type === 'groupColour' || cmd.type === 'groupEffect';
    if (drag && cmd.continues) {
      const step = this.lastColourStep;
      const group = this.groups.get(cmd.group);
      if (step && group && step.group === cmd.group && group.presets.currentKey === step.key) {
        const error = this.run(cmd, now);
        step.key = group.presets.currentKey ?? step.key;
        if (cmd.type === 'groupEffect') this.pruneLiveEffects();
        return error;
      }
    }
    // Tempo commands within 3 s of the last one (tapping along, or holding + or −) join that run's one Undo step.
    if (cmd.type === 'tempo' && this.tempoRunAt !== null && now - this.tempoRunAt <= TEMPO_RUN_SECONDS && this.history.length) {
      const error = this.run(cmd, now);
      if (!error) this.tempoRunAt = now;
      return error;
    }
    // A send that doesn't continue starts a new drag, so it never joins the last one's step.
    if (drag && !cmd.continues) this.lastColourStep = null;
    if (cmd.type === 'look' || cmd.type === 'quickLook' || cmd.type === 'groupPreset' || drag || cmd.type === 'safe' || cmd.type === 'blackout' || cmd.type === 'backToLook' || cmd.type === 'tempo' || cmd.type === 'applyStage') {
      // Any other step ends a run of tempo commands.
      if (cmd.type !== 'tempo') this.tempoRunAt = null;
      const before = this.snapshot();
      const error = this.run(cmd, now);
      const after = this.snapshot();
      if (!error && JSON.stringify(before) !== JSON.stringify(after)) {
        this.history.push(before);
        if (this.history.length > UNDO_STEPS) this.history.shift();
        this.recorded = true;
        const key = drag ? this.groups.get(cmd.group)?.presets.currentKey : null;
        this.lastColourStep = key && drag ? { group: cmd.group, key } : null;
        this.tempoRunAt = cmd.type === 'tempo' ? now : null;
      }
      // Only once the Undo step is kept: it may be all that still names the effect the group ran before.
      if (cmd.type === 'groupEffect' || cmd.type === 'applyStage') this.pruneLiveEffects();
      return error;
    }
    return this.run(cmd, now);
  }

  private snapshot(): Snapshot {
    const groups: Record<string, string | null> = {};
    const levels: Record<string, number> = {};
    for (const g of this.groups.values()) {
      groups[g.id] = g.presets.currentKey;
      levels[g.id] = g.level.target;
    }
    return { look: this.look, lastLook: this.lastLook, groups, levels, beforeBlackout: this.beforeBlackout ? { ...this.beforeBlackout } : null, bpm: this.bpm };
  }

  /** Fade back to how the stage was before the last look or preset change. */
  private undo(now: number): string | null {
    const prev = this.history.pop();
    if (!prev) return 'nothing to undo';
    for (const group of this.groups.values()) {
      // Undo never turns smoke on or off.
      if (group.smoke) continue;
      // A group that had no preset yet was dark.
      const preset = this.presetFor(prev.groups[group.id] ?? BLACKOUT_ID, group.id);
      if (preset && group.presets.currentKey !== preset.id) {
        this.setPreset(group, preset, UNDO_FADE, now, preset.id !== SAFE_ID && preset.id !== BLACKOUT_ID);
      }
      const level = prev.levels[group.id] ?? 1;
      if (group.level.target !== level) group.level.set(level, now, UNDO_FADE);
    }
    this.beforeBlackout = prev.beforeBlackout;
    this.bpm = prev.bpm;
    this.lastLook = prev.lastLook;
    this.setLook(prev.look ?? '', now, UNDO_FADE);
    if (!prev.look) this.look = null;
    return null;
  }

  private presetFor(pid: string | null, group: string): CompiledPreset | undefined {
    if (pid === SAFE_ID) return fixedPreset(SAFE_ID, group, SAFE_LIGHT, SAFE_FADE);
    if (pid === BLACKOUT_ID) return fixedPreset(BLACKOUT_ID, group, dark(), BLACKOUT_FADE);
    const live = pid ? parseLivePreset(pid) : null;
    if (live) return live.group === group ? fixedPreset(pid!, group, fromHex(live.colour, live), DEFAULT_FADE) : undefined;
    const fx = pid ? parseLiveEffect(pid) : null;
    if (fx) return fx.group === group ? this.liveCompiled.get(pid!) : undefined;
    return pid ? this.presets.get(pid) : undefined;
  }

  /**
   * The live effect id for this effect on this group: the one it already has (so sending the
   * same effect again changes nothing), or a new `fx:<group>:<n>`.
   */
  private liveEffectFor(group: string, effect: EffectLayer): string {
    const key = effectKey(effect);
    for (const [id, layer] of this.liveEffects) {
      if (parseLiveEffect(id)?.group === group && effectKey(layer) === key) return id;
    }
    const id = liveEffectId(group, this.nextEffect++);
    this.addLiveEffect(id, effect);
    return id;
  }

  private addLiveEffect(id: string, effect: EffectLayer): void {
    const layer = structuredClone(effect);
    const group = parseLiveEffect(id)!.group;
    this.liveEffects.set(id, layer);
    this.liveCompiled.set(id, compilePreset({ id, name: 'Custom effect', group, layers: [layer], fade: DEFAULT_FADE }, new Map(), this.rates));
  }

  /** Forget the live effects nothing names any more: not a group's mix, Blackout's memory or an Undo step. */
  private pruneLiveEffects(): void {
    const named = new Set<string>();
    for (const g of this.groups.values()) for (const run of g.presets.items()) named.add(run.preset.id);
    const add = (groups: Record<string, string | null> | null) => {
      for (const id of Object.values(groups ?? {})) if (id) named.add(id);
    };
    add(this.beforeBlackout);
    for (const step of this.history) {
      add(step.groups);
      add(step.beforeBlackout);
    }
    for (const id of this.liveEffects.keys()) {
      if (named.has(id)) continue;
      this.liveEffects.delete(id);
      this.liveCompiled.delete(id);
    }
  }

  private run(cmd: StageCommand, now: number): string | null {
    switch (cmd.type) {
      case 'undo': return this.undo(now);
      case 'look': return this.goLook(cmd.id, cmd.fade, now);
      case 'quickLook': return this.quickLook(cmd.id, cmd.fade, now);
      case 'groupPreset': {
        const group = this.groups.get(cmd.group);
        const preset = this.presets.get(cmd.preset);
        if (!group) return `unknown group "${cmd.group}"`;
        if (group.smoke) return smokeRefusal(cmd.group);
        if (!preset || preset.group !== cmd.group) return `unknown preset "${cmd.preset}" for group "${cmd.group}"`;
        this.setPreset(group, preset, cmd.fade ?? this.fadeTime ?? preset.fade, now);
        return null;
      }
      case 'groupColour': {
        const group = this.groups.get(cmd.group);
        if (!group) return `unknown group "${cmd.group}"`;
        if (group.smoke) return smokeRefusal(cmd.group);
        if (!HEX_COLOUR.test(cmd.colour)) return `bad colour "${cmd.colour}"`;
        const extras = { white: cmd.white, amber: cmd.amber, uv: cmd.uv };
        const preset = this.presetFor(livePresetId(cmd.group, cmd.colour, extras), cmd.group)!;
        this.setPreset(group, preset, cmd.fade ?? this.fadeTime ?? preset.fade, now);
        return null;
      }
      case 'groupEffect': {
        const group = this.groups.get(cmd.group);
        if (!group) return `unknown group "${cmd.group}"`;
        if (group.smoke) return smokeRefusal(cmd.group);
        const id = this.liveEffectFor(cmd.group, cmd.effect);
        const preset = this.presetFor(id, cmd.group)!;
        const was = group.presets.current;
        const fresh = !group.presets.items().some((r) => r.preset.id === id);
        const started = this.setPreset(group, preset, cmd.fade ?? this.fadeTime ?? preset.fade, now);
        // A later send of a drag carries on from where the pattern is, so moving a slider never restarts it.
        if (cmd.continues && fresh && started && was && moves(was.preset)) {
          started.time = was.time;
          started.beats = was.beats;
          started.cycles = [was.cycles[was.preset.layers.length - 1] ?? 0];
        }
        return null;
      }
      case 'flash': {
        for (const id of cmd.groups) if (!this.groups.has(id)) return `unknown group "${id}"`;
        for (const id of cmd.groups) {
          const smoke = this.groups.get(id)!.smoke;
          // A smoke group's flash is its Puff, and only happens on its own: Flash All never puffs.
          if (cmd.on && smoke && cmd.groups.length > 1) continue;
          // The 15 s cap counts from the start of a Puff; another "on" while it is held doesn't restart it.
          if (cmd.on && smoke && !this.flash.has(id)) this.puffStart.set(id, now);
          if (!cmd.on) this.puffStart.delete(id);
          if (cmd.on) this.flash.add(id);
          else this.flash.delete(id);
        }
        this.updateFlashed();
        return null;
      }
      case 'manual': return this.setManual(cmd.target, cmd.colour, cmd.intensity, now);
      case 'release': return this.release(cmd.target, now);
      case 'releaseAll': this.releaseAll(now); return null;
      case 'backToLook': return this.backToLook(now);
      case 'safe': this.goSafe(now); return null;
      case 'blackout': this.goBlackout(now); return null;
      case 'master': this.master.set(cmd.value, now, SMOOTH); return null;
      case 'speed': this.speed.set(cmd.value, now, SMOOTH); return null;
      case 'tempo': this.bpm = cmd.bpm; return null;
      case 'fadeTime': this.fadeTime = cmd.value; return null;
      case 'applyStage': return this.applyStage(cmd.stage, cmd.fade, now);
      case 'groupLevel': {
        const group = this.groups.get(cmd.group);
        if (!group) return `unknown group "${cmd.group}"`;
        // Blackout keeps smoke off: its slider waits until the lights are back, like Puff.
        if (group.smoke && this.look === BLACKOUT) return 'Blackout is on.';
        group.level.set(cmd.value, now, SMOOTH);
        return null;
      }
    }
  }

  private goLook(id: string, fade: number | undefined, now: number): string | null {
    const look = this.looks.get(id);
    if (!look) return `unknown look "${id}"`;
    const listed = new Set<string>();
    let longest = this.applyEntries(look.groups, fade, now, listed);
    // Coming out of Blackout, groups the look leaves alone return to what they ran before.
    if (this.beforeBlackout) {
      for (const [gid, pid] of Object.entries(this.beforeBlackout)) {
        const group = this.groups.get(gid);
        const preset = this.presetFor(pid, gid);
        if (!group || listed.has(gid) || !preset || preset.id === BLACKOUT_ID) continue;
        const t = fade ?? this.fadeTime ?? DEFAULT_FADE;
        // The built-in safe light is set for every group at once, so it doesn't take shared fixtures.
        this.setPreset(group, preset, t, now, preset.id !== SAFE_ID);
        longest = Math.max(longest, t);
      }
      this.beforeBlackout = null;
    }
    this.bpm = look.tempo ?? DEFAULT_TEMPO;
    this.setLook(id, now, longest);
    this.lastLook = id;
    return null;
  }

  /** Like a look, but only for the groups it lists; the current look stays. */
  private quickLook(id: string, fade: number | undefined, now: number): string | null {
    const look = this.looks.get(id);
    if (!look) return `unknown look "${id}"`;
    this.applyEntries(look.groups, fade, now);
    return null;
  }

  /**
   * Set each listed group to its preset and level, both over the same fade.
   * Returns the longest fade used. `listed` collects the groups that were set.
   */
  private applyEntries(entries: readonly LookEntry[], fade: number | undefined, now: number, listed?: Set<string>): number {
    let longest = 0;
    for (const entry of entries) {
      const group = this.groups.get(entry.group);
      const preset = this.presets.get(entry.preset);
      // Looks never touch smoke, even an imported look that lists a smoke group.
      if (!group || group.smoke || !preset) continue;
      const t = fade ?? this.fadeTime ?? entry.fade ?? preset.fade;
      this.setPreset(group, preset, t, now);
      group.level.set(entry.level ?? 1, now, t * LEVEL_FADE_FACTOR);
      listed?.add(group.id);
      longest = Math.max(longest, t);
    }
    return longest;
  }

  private goSafe(now: number): void {
    for (const group of this.groups.values()) {
      if (group.smoke) continue;
      const { preset } = this.safeTarget(group);
      this.setPreset(group, preset, SAFE_FADE, now, false);
    }
    this.releaseAll(now);
    this.master.set(1, now, SAFE_RESET);
    this.speed.set(1, now, SAFE_RESET);
    // Basic lights recovers the stage: every dimmer back to full, and smoke off.
    for (const group of this.groups.values()) {
      if (group.smoke) group.level.set(0, now, SMOKE_OFF);
      else group.level.set(1, now, SAFE_RESET);
    }
    this.beforeBlackout = null;
    this.setLook(SAFE, now, SAFE_FADE);
  }

  /**
   * What Safe (Basic lights) sets for a group: the safe look's preset, or the built-in
   * warm wash. The level is always full: Basic lights doesn't keep dimmer levels.
   */
  private safeTarget(group: GroupRun): { preset: CompiledPreset; level: number; fade: number } {
    const safeLook = this.show.operator.safeLook ? this.looks.get(this.show.operator.safeLook) : undefined;
    const entry = safeLook?.groups.find((e) => e.group === group.id);
    const own = entry && this.presets.get(entry.preset);
    // Basic lights is always still: an effect in its look gives way to the built-in wash.
    if (entry && own && !moves(own)) return { preset: own, level: 1, fade: entry.fade ?? own.fade };
    return { preset: fixedPreset(SAFE_ID, group.id, SAFE_LIGHT, SAFE_FADE), level: 1, fade: SAFE_FADE };
  }

  private goBlackout(now: number): void {
    if (!this.beforeBlackout) {
      this.beforeBlackout = {};
      for (const group of this.groups.values()) this.beforeBlackout[group.id] = group.presets.currentKey;
    }
    for (const group of this.groups.values()) {
      if (group.smoke) group.level.set(0, now, SMOKE_OFF);
      else this.setPreset(group, fixedPreset(BLACKOUT_ID, group.id, dark(), BLACKOUT_FADE), BLACKOUT_FADE, now, false);
    }
    this.releaseAll(now);
    this.setLook(BLACKOUT, now, BLACKOUT_FADE);
  }

  private backToLook(now: number): string | null {
    this.releaseAll(now);
    if (this.look === SAFE) {
      // Basic lights is not a look in the show; put back what Safe set (dimmers at full), but leave Master and speed.
      for (const group of this.groups.values()) {
        if (group.smoke) {
          group.level.set(0, now, SMOKE_OFF);
          continue;
        }
        const { preset, level, fade } = this.safeTarget(group);
        const t = preset.id === SAFE_ID ? fade : this.fadeTime ?? fade;
        this.setPreset(group, preset, t, now, false);
        group.level.set(level, now, t * LEVEL_FADE_FACTOR);
      }
      return null;
    }
    const look = this.look ? this.looks.get(this.look) : undefined;
    if (!look) return null;
    this.applyEntries(look.groups, undefined, now);
    return null;
  }

  /**
   * Fade the whole stage to `stage` (Blind's Go): each light group it names to its preset and level,
   * the tempo, and the current look as if that look had started. On Auto each group fades over its
   * look entry's fade (the safe look's on Basic lights), else its preset's. A Basic-lights stage puts
   * the groups it has no preset for on the safe light. Smoke, Master and speed are left alone, and
   * Blackout's memory is cleared. A group naming a preset it can't run (gone, or another group's) is left as it is
   * (on Basic lights it gets the safe light).
   */
  private applyStage(stage: StageState, fade: number | undefined, now: number): string | null {
    if (stage.look === BLACKOUT) return 'The stage to send is in Blackout.';
    const safe = stage.look === SAFE;
    const lookId = safe ? this.show.operator.safeLook : stage.look;
    const look = lookId ? this.looks.get(lookId) : undefined;
    let longest = 0;
    for (const group of this.groups.values()) {
      if (group.smoke) continue;
      const pid = stage.groups[group.id] ?? null;
      const preset = (pid ? this.stagePreset(pid, group.id, stage.effects) : undefined) ?? (safe ? this.safeTarget(group).preset : undefined);
      if (!preset) continue;
      const entry = look?.groups.find((e) => e.group === group.id && e.preset === preset.id);
      const t = fade ?? this.fadeTime ?? entry?.fade ?? preset.fade;
      const level = stage.levels[group.id] ?? 1;
      // Only what changes moves: a group already there keeps its run (an effect carries on) and its fixtures.
      if (group.presets.currentKey !== preset.id) {
        this.setPreset(group, preset, t, now, preset.id !== SAFE_ID && preset.id !== BLACKOUT_ID);
        longest = Math.max(longest, t);
      }
      if (group.level.target !== level) {
        group.level.set(level, now, t * LEVEL_FADE_FACTOR);
        longest = Math.max(longest, t * LEVEL_FADE_FACTOR);
      }
    }
    this.beforeBlackout = null;
    if (stage.tempo !== undefined) this.bpm = stage.tempo;
    if (stage.look && this.looks.has(stage.look)) this.lastLook = stage.look;
    else if (stage.lastLook) this.lastLook = stage.lastLook;
    this.setLook(stage.look ?? '', now, longest);
    if (!stage.look) this.look = null;
    return null;
  }

  /**
   * The preset a stage names for a group, as this engine runs it. A live effect is the stage's
   * own layer, under this engine's id for it (the stage's numbering may clash with this one's).
   */
  private stagePreset(pid: string, group: string, effects: StageState['effects']): CompiledPreset | undefined {
    const fx = parseLiveEffect(pid);
    let preset: CompiledPreset | undefined;
    if (fx) {
      const layer = LiveEffectLayer.safeParse(effects?.[pid]);
      if (fx.group === group && layer.success) preset = this.presetFor(this.liveEffectFor(group, layer.data), group);
    } else preset = this.presetFor(pid, group);
    return preset?.group === group ? preset : undefined;
  }

  private setLook(id: string, now: number, dur: number): void {
    this.look = id;
    this.lookStart = now;
    this.lookDur = dur;
  }

  /**
   * Fade a group to a preset. Normally the group also takes over any fixtures
   * it shares with other groups. Safe and Blackout set every group at once,
   * so handing fixtures over would only add a second fade on top.
   */
  private setPreset(group: GroupRun, preset: CompiledPreset, fade: number, now: number, own = true): PresetRun | null {
    // A smoke group runs no presets: nothing but its level drives it.
    if (group.smoke) return null;
    const run = group.presets.push(preset.id, () => newRun(preset, this.startPhases(preset)), now, fade);
    if (own) this.takeOwnership(group, now, fade);
    return run;
  }

  /**
   * Where a new run of a preset starts each of its effects: at the stage clock (its beats ÷
   * the effect's beats, or seconds ÷ its seconds), so effects on different groups stay in
   * step however late they start. Taken round its colour list, so the colours are in step too.
   */
  private startPhases(preset: CompiledPreset): number[] {
    return preset.layers.map((l) => {
      if (l.kind !== 'effect') return 0;
      const cycles = 'beats' in l.speed ? this.stageBeats / l.speed.beats : this.stageSeconds / l.speed.seconds;
      return cycles % l.colours.length;
    });
  }

  /** The most recent change to a group wins its fixtures, including ones shared with other groups. */
  private takeOwnership(group: GroupRun, now: number, fade: number): void {
    for (const f of group.fixtures) {
      const run = this.fixtures[f];
      if (run.owners.currentKey !== group.id) run.owners.push(group.id, () => group.id, now, fade);
    }
  }

  private setManual(target: ManualTarget, colour: string | undefined, intensity: number | undefined, now: number): string | null {
    let holder: { manual: ManualRun | null };
    let showing: Light;
    if ('group' in target) {
      const group = this.groups.get(target.group);
      if (!group) return `unknown group "${target.group}"`;
      if (group.smoke) return smokeRefusal(target.group);
      holder = group;
      showing = group.out[0] ?? dark();
      this.takeOwnership(group, now, MANUAL_IN);
    } else {
      const index = this.fixtureIndex.get(target.fixture);
      if (index === undefined) return `unknown fixture "${target.fixture}"`;
      if (this.fixtures[index].smokeGroups.length) return smokeRefusal(target.fixture);
      holder = this.fixtures[index];
      showing = this.fixtures[index].light;
    }
    let m = holder.manual;
    if (!m || m.releasing) {
      // Start from what the fixture shows now, so taking control never jumps.
      const start = m && m.releasing ? m.current : showing;
      m = new ManualRun(start, now);
      if (holder.manual) m.weight = holder.manual.weight;
      m.weight.set(1, now, MANUAL_IN);
      holder.manual = m;
    }
    if (colour) {
      const c = fromHex(colour);
      m.target.r = c.r; m.target.g = c.g; m.target.b = c.b; m.target.w = c.w; m.target.a = c.a; m.target.u = c.u;
      if (intensity === undefined && c.i < 1) m.target.i = c.i;
    }
    if (intensity !== undefined) m.target.i = intensity;
    return null;
  }

  private release(target: ManualTarget, now: number): string | null {
    let holder: { manual: ManualRun | null } | undefined;
    if ('group' in target) holder = this.groups.get(target.group);
    else {
      const index = this.fixtureIndex.get(target.fixture);
      holder = index === undefined ? undefined : this.fixtures[index];
    }
    if (!holder) return `unknown target`;
    if (holder.manual && !holder.manual.releasing) {
      holder.manual.releasing = true;
      holder.manual.weight.set(0, now, MANUAL_OUT);
    }
    return null;
  }

  private releaseAll(now: number): void {
    for (const g of this.groups.values()) if (g.manual) this.release({ group: g.id }, now);
    for (const f of this.fixtures) if (f.manual) this.release({ fixture: f.id }, now);
  }

  /** Render one frame at time `now`. */
  frame(now: number): Frame {
    const dt = this.last === null ? 0 : Math.min(0.5, Math.max(0, now - this.last));
    this.last = now;
    const speed = this.speed.value(now);
    const beatsPerSecond = this.bpm / 60 * speed;
    this.stageBeats += dt * beatsPerSecond;
    this.stageSeconds += dt * speed;
    const ctx: LayerContext = { index: 0, count: 0, time: 0, beats: 0, cycles: [] };
    const parts = this.scratch;
    const weights = this.scratchWeights;

    // 1–3. Each group renders and blends its presets, then its manual override and level.
    const blackedOut = this.look === BLACKOUT;
    for (const group of this.groups.values()) {
      if (group.smoke) {
        // A Puff that has run its 15 s ends here, as if the button had been let go.
        const started = this.puffStart.get(group.id);
        if (started !== undefined && now - started >= PUFF_MAX) {
          this.flash.delete(group.id);
          this.puffStart.delete(group.id);
        }
        // Puff (its own flash) runs it at full, but not during Blackout.
        group.smokeOut = this.flash.has(group.id) && !blackedOut ? PUFF_LEVEL : group.level.value(now);
        continue;
      }
      const mix0 = group.presets.weights(now);
      const length = group.line.length;
      for (const w of mix0) {
        const item = w.item;
        item.time += dt * speed;
        item.beats += dt * beatsPerSecond;
        advancePhases(item.cycles, item.preset, dt, beatsPerSecond, speed);
        // A preset that moves remembers each segment's level, to tell its own motion from fades.
        if (moves(item.preset) && item.levels.length !== length) item.levels = new Array<number>(length).fill(NaN);
      }
      const level = group.level.value(now);
      const manual = this.liveManual(group, now, dt);
      const motion = group.motion;
      // One light per segment of the group's line.
      ctx.count = length;
      for (let k = 0; k < length; k++) {
        ctx.index = k;
        const out = group.out[k];
        motion[k] = 0;
        // A fixture without UV mixes only the light it can make, so its intensity is what it shows.
        const plan = this.fixtures[group.line[k]!]!.plan;
        const noUv = !plan.hasUv;
        if (mix0.length === 0) copy(out, DARK);
        else {
          parts.length = 0;
          weights.length = 0;
          for (let n = 0; n < mix0.length; n++) {
            const item = mix0[n].item;
            ctx.time = item.time;
            ctx.beats = item.beats;
            ctx.cycles = item.cycles;
            if (!this.scratchLights[n]) this.scratchLights[n] = dark();
            const part = renderPreset(this.scratchLights[n], item.preset, ctx);
            parts.push(noUv ? withoutUv(part) : part);
            weights.push(mix0[n].weight);
            if (moves(item.preset)) {
              const seen = visibleLevel(plan, part);
              // The change since last frame (NaN on its first frame, which never counts).
              const change = Math.abs(seen - item.levels[k]!);
              if (change > motion[k]) motion[k] = change;
              item.levels[k] = seen;
            }
          }
          mix(out, parts, weights);
        }
        if (manual) mix2(out, out, manual.current, manual.weight.value(now));
        out.i *= level;
      }
    }

    // 4–6. Each segment of a fixture takes its owning groups' light, then manual and master, then gamma and channels.
    const master = this.master.value(now);
    const flashing = this.flashed.size > 0 && !blackedOut;
    const from = this.scratchOwners, starts = this.scratchStarts, ownerWeights = this.scratchOwnerWeights;
    for (const buf of this.universes.values()) buf.fill(0);
    for (let f = 0; f < this.fixtures.length; f++) {
      const run = this.fixtures[f];
      if (run.smokeGroups.length) {
        this.frameSmoke(run);
        continue;
      }
      const owners = run.owners.weights(now);
      from.length = 0;
      starts.length = 0;
      ownerWeights.length = 0;
      for (const o of owners) {
        const group = this.groups.get(o.item);
        const start = group?.position.get(f);
        if (!group || start === undefined) continue;
        from.push(group);
        starts.push(start);
        ownerWeights.push(o.weight);
      }
      const manual = this.liveManual(run, now, dt);
      const manualWeight = manual ? manual.weight.value(now) : 0;
      // Flash overrides everything above, but not Blackout.
      const flash = flashing && this.flashed.has(f);
      const cells = run.cells, n = cells.length;
      let widest = 0;
      for (let c = 0; c < n; c++) {
        // Where this segment sits in each group's line.
        const slot = run.reversed ? n - 1 - c : c;
        const light = cells[c];
        let own = 0;
        for (let j = 0; j < from.length; j++) own = Math.max(own, from[j].motion[starts[j] + slot]);
        run.motion[c] = own;
        if (own > widest) widest = own;
        if (from.length === 0) copy(light, DARK);
        else if (from.length === 1) copy(light, from[0].out[starts[0] + slot]);
        else {
          parts.length = 0;
          for (let j = 0; j < from.length; j++) parts.push(from[j].out[starts[j] + slot]);
          mix(light, parts, ownerWeights);
        }
        if (manual) mix2(light, light, manual.current, manualWeight);
        if (!run.plan.hasUv) withoutUv(light);
        light.i *= master;
        if (flash) copy(light, FLASH_LIGHT);
        visualOf(light, this.visual, (run.visualAt + c) * 3);
      }
      // A colour channel shared by all segments follows the brightest, so any segment's motion can show on all.
      if (run.wide) run.motion.fill(widest);

      const buf = this.universes.get(run.plan.universe);
      if (buf) writeCells(buf, run.plan, cells);
    }
    return { universes: this.universes, visual: this.visual };
  }

  /**
   * A smoke machine: the highest output of its smoke groups, untouched by
   * Master, Flash and any light group it is also in. Shown as quiet grey.
   */
  private frameSmoke(run: FixtureRun): void {
    let level = 0;
    for (const g of run.smokeGroups) level = Math.max(level, g.smokeOut);
    for (const light of run.cells) {
      copy(light, DARK);
      light.i = level;
    }
    run.motion.fill(0);
    const buf = this.universes.get(run.plan.universe);
    if (buf) writeSmoke(buf, run.plan, level);
    const grey = Math.round(level * 140);
    this.visual.fill(grey, run.visualAt * 3, (run.visualAt + run.cells.length) * 3);
  }

  /** The holder's manual override if it still has weight; clears it once released. */
  private liveManual(holder: { manual: ManualRun | null }, now: number, dt: number): ManualRun | null {
    const m = holder.manual;
    if (!m) return null;
    if (m.releasing && m.weight.settled(now)) {
      holder.manual = null;
      return null;
    }
    m.follow(dt);
    return m;
  }

  /** Final light of every fixture's first segment (after master, before gamma), in show order. */
  lights(): readonly Light[] {
    return this.fixtures.map((f) => f.light);
  }

  /** How many segments each fixture has, in show order. */
  segmentCounts(): number[] {
    return this.fixtures.map((f) => f.cells.length);
  }

  /**
   * How bright each segment looks (its brightest written colour channel × intensity):
   * fixtures in show order, each fixture's segments in order, as in the visual.
   */
  visibleLevels(): number[] {
    const out: number[] = [];
    for (const f of this.fixtures) visibleCells(f.plan, f.cells, out, out.length);
    return out;
  }

  /**
   * For each segment, in the order of visibleLevels(): the largest change in how bright
   * it looks that any preset running there made by itself this frame (an effect's own
   * motion: a chase stepping, a wave rolling). 0 for plain colours. The jump check
   * judges each segment's step against this plus 5 %.
   */
  ownMotion(): number[] {
    const out: number[] = [];
    for (const f of this.fixtures) for (const m of f.motion) out.push(m);
    return out;
  }

  fixtureIds(): string[] {
    return this.fixtures.map((f) => f.id);
  }

  /** The stage's beat and seconds clocks now, for another engine to adopt. */
  stageClock(): StageClock {
    return { beats: this.stageBeats, seconds: this.stageSeconds };
  }

  /**
   * Run on another engine's stage clocks (or a copy from stageClock()), so effects started here
   * (by restore too, so adopt first) are in step with the ones that engine starts. A Blind draft
   * adopts the live stage's clocks.
   */
  adoptClock(from: Engine | StageClock): void {
    const clock = from instanceof Engine ? from.stageClock() : from;
    this.stageBeats = clock.beats;
    this.stageSeconds = clock.seconds;
  }

  /** The beat phase of the preset a group is running (or fading into), in beats; undefined when it runs none. */
  beatPhase(group: string): number | undefined {
    return this.groups.get(group)?.presets.current?.beats;
  }

  /** The phase (in cycles) of the effect a group is running (or fading into); undefined when it runs none. */
  effectPhase(group: string): number | undefined {
    const run = this.groups.get(group)?.presets.current;
    if (!run || !moves(run.preset)) return undefined;
    return run.cycles[run.preset.layers.length - 1];
  }

  liveState(now: number, output: OutputStatus): LiveState {
    const look = this.look ? this.looks.get(this.look) : undefined;
    const groups: LiveState['groups'] = {};
    for (const g of this.groups.values()) {
      const preset = g.presets.currentKey;
      // Looks never set smoke, so a smoke group never counts as changed.
      const expected = g.smoke ? undefined : look?.groups.find((e) => e.group === g.id)?.preset;
      groups[g.id] = {
        preset,
        changed: expected !== undefined && expected !== preset,
        manual: g.manual !== null && !g.manual.releasing,
        progress: g.presets.progress(now),
        level: g.level.target,
        live: liveView(preset),
        effect: (preset ? this.liveEffects.get(preset) : undefined) ?? null,
      };
    }
    return {
      look: this.look,
      lookChanged: this.lookChanged(),
      lookProgress: this.lookDur > 0 ? Math.min(1, Math.max(0, (now - this.lookStart) / this.lookDur)) : 1,
      lookFadeLeft: Math.max(0, this.lookStart + this.lookDur - now),
      lastLook: this.lastLook,
      canUndo: this.history.length > 0,
      fadeTime: this.fadeTime,
      groups,
      fixturesManual: this.fixtures.filter((f) => f.manual && !f.manual.releasing).map((f) => f.id),
      flashing: [...this.flash],
      master: this.master.target,
      speed: this.speed.target,
      tempo: this.bpm,
      output,
      outputProblem: null,
      outputProblemKind: null,
    };
  }

  /** A group the current look lists runs another preset, or has another level target, than the look says. */
  private lookChanged(): boolean {
    if (!this.look || this.look === BLACKOUT) return false;
    const look = this.currentLook();
    if (!look && this.look !== SAFE) return false;
    const listed = new Set(look?.groups.map((e) => e.group));
    const differs = (group: GroupRun, preset: string, level: number) =>
      group.presets.currentKey !== preset || Math.abs(group.level.target - level) > 1e-9;
    // Basic lights keeps no dimmer levels: every group it sets should be at full.
    const safe = this.look === SAFE;
    // Basic lights is always still, so Save can't keep an effect there: a group running one
    // doesn't count as a change on Basic lights (Save leaves that group as it was).
    const skip = (group: GroupRun) => group.smoke || (safe && runsEffect(group));
    // Smoke groups are left out: looks never set them.
    for (const entry of look?.groups ?? []) {
      const group = this.groups.get(entry.group);
      if (!group || skip(group)) continue;
      // Basic lights runs its built-in wash where the safe look lists an effect.
      const preset = safe ? this.safeTarget(group).preset.id : entry.preset;
      if (differs(group, preset, safe ? 1 : entry.level ?? 1)) return true;
    }
    // Basic lights puts every group the safe look doesn't list on the built-in safe light at full.
    if (safe) {
      for (const group of this.groups.values()) {
        if (!skip(group) && !listed.has(group.id) && differs(group, SAFE_ID, 1)) return true;
      }
    }
    return false;
  }

  runtime(): RuntimeState {
    const groups: RuntimeState['groups'] = {};
    const levels: RuntimeState['levels'] = {};
    for (const g of this.groups.values()) {
      groups[g.id] = g.presets.currentKey;
      levels[g.id] = g.level.target;
    }
    return {
      look: this.look,
      groups,
      master: this.master.target,
      speed: this.speed.target,
      tempo: this.bpm,
      levels,
      lastLook: this.lastLook,
      fadeTime: this.fadeTime,
      ...(this.beforeBlackout ? { beforeBlackout: { ...this.beforeBlackout } } : {}),
      ...this.namedEffects(groups),
    };
  }

  /** The live effects the stage (or Blackout's memory) names, for the runtime state. */
  private namedEffects(groups: Record<string, string | null>): { effects?: Record<string, EffectLayer> } {
    const effects: Record<string, EffectLayer> = {};
    for (const id of [...Object.values(groups), ...Object.values(this.beforeBlackout ?? {})]) {
      const layer = id ? this.liveEffects.get(id) : undefined;
      if (layer) effects[id!] = structuredClone(layer);
    }
    return Object.keys(effects).length ? { effects } : {};
  }

  /** Put the stage back as it was saved, with no fade, so a restart matches what the node is holding. */
  restore(rt: RuntimeState, now: number): void {
    // The live effects it names come back first, so the groups can run them. A broken one is left out.
    this.liveEffects.clear();
    this.liveCompiled.clear();
    for (const [id, layer] of Object.entries(rt.effects ?? {})) {
      const fx = parseLiveEffect(id);
      const parsed = LiveEffectLayer.safeParse(layer);
      if (!fx || !parsed.success) continue;
      this.addLiveEffect(id, parsed.data);
      this.nextEffect = Math.max(this.nextEffect, fx.n + 1);
    }
    for (const group of this.groups.values()) {
      if (group.smoke) {
        // Smoke never starts by itself: after a restart it is off, whatever it was.
        group.level.set(0, now, 0);
        continue;
      }
      const preset = this.presetFor(rt.groups[group.id] ?? null, group.id);
      if (preset) this.setPreset(group, preset, 0, now);
      group.level.set(rt.levels[group.id] ?? 1, now, 0);
    }
    this.master.set(rt.master, now, 0);
    this.speed.set(rt.speed, now, 0);
    this.bpm = rt.tempo ?? DEFAULT_TEMPO;
    this.fadeTime = rt.fadeTime ?? null;
    this.beforeBlackout = rt.beforeBlackout ?? null;
    this.look = rt.look;
    this.lastLook = rt.lastLook ?? (rt.look && this.looks.has(rt.look) ? rt.look : null);
    this.lookStart = now;
    this.lookDur = 0;
  }
}
