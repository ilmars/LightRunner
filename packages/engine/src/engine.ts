// The lighting engine. Pure: no timers, no network, no files. The caller
// passes `now` (seconds on a monotonic clock) and gets DMX buffers back, so the
// same code drives output, tests, blind preview and the soak test.

import {
  BLACKOUT, BLACKOUT_PRESET, HEX_COLOUR, SAFE, SAFE_LIGHT as SAFE_COLOUR, SAFE_PRESET, findProfile, livePresetId, parseLivePreset,
  type StageCommand, type LiveState, type Look, type LookEntry, type ManualTarget, type OutputStatus,
  type Palette, type RuntimeState, type Show,
} from '../../shared/src/index.ts';
import { Crossfade, Ramp } from './fade.ts';
import { compilePreset, fixedPreset, renderPreset, type CompiledPreset, type LayerContext } from './layers.ts';
import { copy, dark, fromHex, mix, mix2, type Light } from './light.ts';
import { planChannels, writeFixture, writeSmoke, type ChannelPlan } from './output.ts';

/** Safe's fixed warm white stage wash. */
const SAFE_LIGHT = fromHex(SAFE_COLOUR.hex, SAFE_COLOUR.white, SAFE_COLOUR.intensity);
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
}

interface PresetRun {
  preset: CompiledPreset;
  /** Effect time in seconds, advanced by speed × elapsed time. */
  time: number;
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
    c.i += (t.i - c.i) * a;
  }
}

class GroupRun {
  readonly id: string;
  /** Fixture indices, in group order. */
  fixtures: number[] = [];
  /** Fixture index → position in this group. */
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
  /** This group's light for each of its fixtures, in group order. */
  out: Light[] = [];

  constructor(id: string) {
    this.id = id;
  }

  setFixtures(fixtures: number[]): void {
    this.fixtures = fixtures;
    this.position = new Map(fixtures.map((f, k) => [f, k]));
    while (this.out.length < fixtures.length) this.out.push(dark());
    this.out.length = fixtures.length;
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
  /** Final light after manual and master, before gamma. */
  light: Light = dark();

  constructor(id: string, plan: ChannelPlan) {
    this.id = id;
    this.plan = plan;
  }
}

function smokeRefusal(name: string): string {
  return `"${name}" is a smoke machine: use its slider or Puff`;
}

/** True when two presets are one static layer of the same light. */
function sameLight(a: CompiledPreset, b: CompiledPreset): boolean {
  if (a.layers.length !== 1 || b.layers.length !== 1) return false;
  const x = a.layers[0]!.light, y = b.layers[0]!.light;
  const near = (p: number, q: number) => Math.abs(p - q) < 1e-9;
  return near(x.r, y.r) && near(x.g, y.g) && near(x.b, y.b) && near(x.w, y.w) && near(x.i, y.i);
}

export interface Frame {
  /** DMX data per universe, 512 bytes each. */
  universes: Map<number, Uint8Array>;
  /** Display colour per fixture (show order), 3 bytes RGB each, for the visualiser. */
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
  private look: string | null = null;
  private lookStart = 0;
  private lookDur = 0;
  /** Each group's preset before Blackout, so any look brings the whole stage back. */
  private beforeBlackout: Record<string, string | null> | null = null;
  /** Stage snapshots before each look or preset change, newest last. */
  private history: Snapshot[] = [];
  /** True when the last apply() added an Undo step. */
  recorded = false;
  private lastLook: string | null = null;
  /** Operator's fade time for look and preset changes; null = each look's own. */
  private fadeTime: number | null = null;
  private last: number | null = null;
  private scratch: Light[] = [];
  private scratchWeights: number[] = [];
  private scratchLights: Light[] = [];

  constructor(show: Show, now = 0) {
    this.setShow(show, now);
  }

  /** Load a new or edited show without disturbing what is on stage. */
  setShow(show: Show, now: number): void {
    this.show = show;
    const palettes = new Map<string, Palette>(show.palettes.map((p) => [p.id, p]));
    this.presets = new Map(show.presets.map((p) => [p.id, compilePreset(p, palettes)]));
    this.looks = new Map(show.looks.map((l) => [l.id, l]));

    const oldFixtures = new Map(this.fixtures.map((f) => [f.id, f]));
    this.fixtures = [];
    this.fixtureIndex = new Map();
    for (const f of show.fixtures) {
      const profile = findProfile(show, f.profile);
      if (!profile) continue;
      const plan = planChannels(f, profile, show.settings.gamma);
      const run = oldFixtures.get(f.id) ?? new FixtureRun(f.id, plan);
      run.plan = plan;
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
      run.setFixtures(g.fixtures.map((id) => this.fixtureIndex.get(id)).filter((i): i is number => i !== undefined));
      // Running presets pick up edits; deleted ones keep running until they fade out.
      run.presets.update((key, item) => {
        const fresh = this.presets.get(key);
        return fresh ? { ...item, preset: fresh } : item;
      });
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
    this.visual = new Uint8Array(this.fixtures.length * 3);

    for (const id of this.flash) if (!this.groups.has(id)) this.flash.delete(id);
    for (const id of this.puffStart.keys()) if (!this.flash.has(id)) this.puffStart.delete(id);
    this.updateFlashed();
    this.adoptSaved();
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
      if (!(key === SAFE_ID || key === BLACKOUT_ID || parseLivePreset(key))) continue;
      const saved = this.show.presets.find((p) => p.id === entry.preset);
      const target = this.presets.get(entry.preset);
      const running = group.presets.current?.preset;
      if (!saved?.custom || !target || !running || target.group !== group.id) continue;
      if (!sameLight(target, running)) continue;
      group.presets.rekey(key, target.id, { preset: target, time: group.presets.current!.time });
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
    if (cmd.type === 'undo') return this.undo(now);
    if (cmd.type === 'look' || cmd.type === 'quickLook' || cmd.type === 'groupPreset' || cmd.type === 'groupColour' || cmd.type === 'safe' || cmd.type === 'blackout' || cmd.type === 'backToLook') {
      const before = this.snapshot();
      const error = this.run(cmd, now);
      const after = this.snapshot();
      if (!error && JSON.stringify(before) !== JSON.stringify(after)) {
        this.history.push(before);
        if (this.history.length > UNDO_STEPS) this.history.shift();
        this.recorded = true;
      }
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
    return { look: this.look, lastLook: this.lastLook, groups, levels, beforeBlackout: this.beforeBlackout ? { ...this.beforeBlackout } : null };
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
    this.lastLook = prev.lastLook;
    this.setLook(prev.look ?? '', now, UNDO_FADE);
    if (!prev.look) this.look = null;
    return null;
  }

  private presetFor(pid: string | null, group: string): CompiledPreset | undefined {
    if (pid === SAFE_ID) return fixedPreset(SAFE_ID, group, SAFE_LIGHT, SAFE_FADE);
    if (pid === BLACKOUT_ID) return fixedPreset(BLACKOUT_ID, group, dark(), BLACKOUT_FADE);
    const live = pid ? parseLivePreset(pid) : null;
    if (live) return live.group === group ? fixedPreset(pid!, group, fromHex(live.colour), DEFAULT_FADE) : undefined;
    return pid ? this.presets.get(pid) : undefined;
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
        const preset = this.presetFor(livePresetId(cmd.group, cmd.colour), cmd.group)!;
        this.setPreset(group, preset, cmd.fade ?? this.fadeTime ?? preset.fade, now);
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
      case 'fadeTime': this.fadeTime = cmd.value; return null;
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
    if (entry && own) return { preset: own, level: 1, fade: entry.fade ?? own.fade };
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
  private setPreset(group: GroupRun, preset: CompiledPreset, fade: number, now: number, own = true): void {
    // A smoke group runs no presets: nothing but its level drives it.
    if (group.smoke) return;
    group.presets.push(preset.id, () => ({ preset, time: 0 }), now, fade);
    if (own) this.takeOwnership(group, now, fade);
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
      m.target.r = c.r; m.target.g = c.g; m.target.b = c.b; m.target.w = c.w;
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
    const ctx: LayerContext = { index: 0, count: 0, time: 0 };
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
      for (const w of mix0) w.item.time += dt * speed;
      const level = group.level.value(now);
      const manual = this.liveManual(group, now, dt);
      ctx.count = group.fixtures.length;
      for (let k = 0; k < group.fixtures.length; k++) {
        ctx.index = k;
        const out = group.out[k];
        if (mix0.length === 0) copy(out, dark());
        else {
          parts.length = 0;
          weights.length = 0;
          for (let n = 0; n < mix0.length; n++) {
            ctx.time = mix0[n].item.time;
            if (!this.scratchLights[n]) this.scratchLights[n] = dark();
            parts.push(renderPreset(this.scratchLights[n], mix0[n].item.preset, ctx));
            weights.push(mix0[n].weight);
          }
          mix(out, parts, weights);
        }
        if (manual) mix2(out, out, manual.current, manual.weight.value(now));
        out.i *= level;
      }
    }

    // 4–6. Each fixture takes its owning group's light, then manual and master, then gamma and channels.
    const master = this.master.value(now);
    const flashing = this.flashed.size > 0 && !blackedOut;
    for (const buf of this.universes.values()) buf.fill(0);
    for (let f = 0; f < this.fixtures.length; f++) {
      const run = this.fixtures[f];
      if (run.smokeGroups.length) {
        this.frameSmoke(f, run);
        continue;
      }
      const owners = run.owners.weights(now);
      parts.length = 0;
      weights.length = 0;
      for (const o of owners) {
        const group = this.groups.get(o.item);
        const pos = group?.position.get(f);
        if (!group || pos === undefined) continue;
        parts.push(group.out[pos]);
        weights.push(o.weight);
      }
      const light = run.light;
      if (parts.length === 0) copy(light, dark());
      else if (parts.length === 1) copy(light, parts[0]);
      else mix(light, parts, weights);
      const manual = this.liveManual(run, now, dt);
      if (manual) mix2(light, light, manual.current, manual.weight.value(now));
      light.i *= master;
      // Flash overrides everything above, but not Blackout.
      if (flashing && this.flashed.has(f)) copy(light, FLASH_LIGHT);

      const buf = this.universes.get(run.plan.universe);
      if (buf) writeFixture(buf, run.plan, light);
      const v = f * 3;
      this.visual[v] = Math.round(Math.min(1, light.r + light.w) * light.i * 255);
      this.visual[v + 1] = Math.round(Math.min(1, light.g + light.w) * light.i * 255);
      this.visual[v + 2] = Math.round(Math.min(1, light.b + light.w) * light.i * 255);
    }
    return { universes: this.universes, visual: this.visual };
  }

  /**
   * A smoke machine: the highest output of its smoke groups, untouched by
   * Master, Flash and any light group it is also in. Shown as quiet grey.
   */
  private frameSmoke(f: number, run: FixtureRun): void {
    let level = 0;
    for (const g of run.smokeGroups) level = Math.max(level, g.smokeOut);
    const light = run.light;
    copy(light, dark());
    light.i = level;
    const buf = this.universes.get(run.plan.universe);
    if (buf) writeSmoke(buf, run.plan, level);
    const grey = Math.round(level * 140);
    this.visual[f * 3] = this.visual[f * 3 + 1] = this.visual[f * 3 + 2] = grey;
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

  /** Final light of every fixture (after master, before gamma), in show order. */
  lights(): readonly Light[] {
    return this.fixtures.map((f) => f.light);
  }

  fixtureIds(): string[] {
    return this.fixtures.map((f) => f.id);
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
      output,
      outputProblem: null,
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
    // Smoke groups are left out: looks never set them.
    for (const entry of look?.groups ?? []) {
      const group = this.groups.get(entry.group);
      if (group && !group.smoke && differs(group, entry.preset, safe ? 1 : entry.level ?? 1)) return true;
    }
    // Basic lights puts every group the safe look doesn't list on the built-in safe light at full.
    if (safe) {
      for (const group of this.groups.values()) {
        if (!group.smoke && !listed.has(group.id) && differs(group, SAFE_ID, 1)) return true;
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
      levels,
      lastLook: this.lastLook,
      fadeTime: this.fadeTime,
      ...(this.beforeBlackout ? { beforeBlackout: { ...this.beforeBlackout } } : {}),
    };
  }

  /** Put the stage back as it was saved, with no fade, so a restart matches what the node is holding. */
  restore(rt: RuntimeState, now: number): void {
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
    this.fadeTime = rt.fadeTime ?? null;
    this.beforeBlackout = rt.beforeBlackout ?? null;
    this.look = rt.look;
    this.lastLook = rt.lastLook ?? (rt.look && this.looks.has(rt.look) ? rt.look : null);
    this.lookStart = now;
    this.lookDur = 0;
  }
}
