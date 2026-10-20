// Blind: a tablet's draft copy of the stage. The server keeps one per tablet in Blind, runs it
// with its own Engine (which never sends DMX) and shows only that tablet its state and picture.
// Go hands the draft's runtime to the live engine as one applyStage.

import { Engine, type StageClock } from '../../packages/engine/src/index.ts';
import type { LiveState, RuntimeState, Show, StageCommand } from '../../packages/shared/src/index.ts';

export const REAL_STAGE_ONLY = 'That works on the real stage only.';
export const BLIND_OFF = 'Blind is off.';

/** Commands that always act on the real stage (Master, Flash, Blackout, manual control, speed, Fade), and Go's own. */
const LIVE_ONLY = new Set<StageCommand['type']>(['master', 'speed', 'flash', 'blackout', 'manual', 'release', 'releaseAll', 'fadeTime', 'applyStage']);

/** Draft state goes out at most this often while fades run (plus at once after any draft command), as the live state does. */
const STATE_EVERY = 0.1;

export class BlindSession {
  readonly engine: Engine;
  private lastStateJson = '';
  private lastStateAt = -Infinity;
  private stateDue = true;

  /** A draft of the live stage: `live` is its runtime and `clock` its stage clocks, taken together. */
  constructor(show: Show, live: RuntimeState, clock: StageClock, now: number) {
    this.engine = new Engine(show, now);
    // Before restore, so the effects restore starts run in step with the live ones.
    this.engine.adoptClock(clock);
    this.engine.restore(live, now);
  }

  /** Run a command on the draft. What acts on the real stage only is refused, as is a smoke machine's dimmer. */
  apply(cmd: StageCommand, now: number, isSmoke: (group: string) => boolean): string | null {
    if (LIVE_ONLY.has(cmd.type) || (cmd.type === 'groupLevel' && isSmoke(cmd.group))) return REAL_STAGE_ONLY;
    this.stateDue = true;
    return this.engine.apply(cmd, now);
  }

  setShow(show: Show, now: number): void {
    this.engine.setShow(show, now);
    this.stateDue = true;
  }

  /**
   * Keep what stays live in step with the stage: Master, speed and the Fade setting, so the draft's
   * picture and fades look as they would on the lights.
   */
  follow(live: LiveState, now: number): void {
    const own = this.engine.runtime();
    if (own.master !== live.master) this.engine.apply({ type: 'master', value: live.master }, now);
    if (own.speed !== live.speed) this.engine.apply({ type: 'speed', value: live.speed }, now);
    if ((own.fadeTime ?? null) !== live.fadeTime) this.engine.apply({ type: 'fadeTime', value: live.fadeTime }, now);
  }

  /** One frame of the draft's picture (3 bytes per segment, like the live one). */
  visual(now: number): Uint8Array {
    return this.engine.frame(now).visual;
  }

  /**
   * The draft's state to send the tablet, or null when nothing changed (or it isn't time yet).
   * What stays live (output, Master, speed, Fade, Flash, manual control and smoke) is copied from the live state.
   */
  state(now: number, live: LiveState | null, isSmoke: (group: string) => boolean): LiveState | null {
    if (!this.stateDue && now - this.lastStateAt < STATE_EVERY) return null;
    const own = this.engine.liveState(now, live?.output ?? 'off');
    const state: LiveState = live ? {
      ...own,
      groups: Object.fromEntries(Object.entries(own.groups).map(([id, g]) => [id, isSmoke(id) ? live.groups[id] ?? g : g])),
      fadeTime: live.fadeTime,
      fixturesManual: live.fixturesManual,
      flashing: live.flashing,
      master: live.master,
      speed: live.speed,
      output: live.output,
      outputProblem: live.outputProblem,
      outputProblemKind: live.outputProblemKind,
    } : own;
    this.stateDue = false;
    this.lastStateAt = now;
    const json = JSON.stringify(state);
    if (json === this.lastStateJson) return null;
    this.lastStateJson = json;
    return state;
  }
}
