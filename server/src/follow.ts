// Auto-follow: the lights follow the presentation app's slides until someone taps. The App owns one; this keeps the
// switch, the live connection (while Planning is on) and what was last followed. What a slide means is decided by
// followDecision (packages/shared, pure); starting it on the stage is the App's.

import {
  followDecision, sectionLookOf,
  type FollowNote, type FollowPlace, type FollowStart, type LiveSlide, type LiveState, type LiveStatus, type OnStage, type SectionRef, type Show,
} from '../../packages/shared/src/index.ts';
import { isDeepStrictEqual } from 'node:util';
import { PlanningError, type Planning } from './planning/index.ts';
import { PresenterLive, type WebSocketLike } from './planning/live.ts';

export interface FollowHost {
  planning: Planning;
  show(): Show;
  /** What is on the real stage now. Throws when the engine doesn't answer. */
  onStage(): Promise<OnStage>;
  /** Start what a slide asks for on the real stage, without pausing Auto-follow. Returns an error in plain words, or null. */
  start(start: FollowStart): Promise<string | null>;
  /** The switch or what to show changed: tell the pages. */
  changed(): void;
  /** The switch changed: keep it with the runtime file. */
  saveOn(on: boolean): void;
  log(line: string): void;
  /** How the live connection opens its socket (tests); the global WebSocket when left out. */
  open?: (url: string) => WebSocketLike;
}

/** What the live connection is told to do: connect for an account (undefined: the login's first), or stay off and say why. */
export type LiveWanted = { account: string | undefined } | { problem: string } | null;

const CLOSED: LiveStatus = { state: 'closed', problem: null, presenter: null };
/** How long (ms) before looking for the planning account again, after a try that failed for another reason than there being none. */
const ACCOUNT_RETRY_MS = 30_000;

export class Follow {
  private readonly host: FollowHost;
  private onNow = false;
  private live: LiveStatus = CLOSED;
  private note: FollowNote | null = null;
  /** The last slide the presentation app showed (followed or not). */
  private lastSlide: LiveSlide | null = null;
  /** Where the last followed slide stood. */
  private place: FollowPlace | null = null;
  private presenter: PresenterLive | null = null;
  /** What the connection was made for, so a settings save that changes nothing leaves it be. */
  private wantedKey: string | null = null;
  /** Counts connects, so an account lookup that was still on its way when another came does nothing. */
  private turn = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** One slide at a time, in the order they came. */
  private busy: Promise<void> = Promise.resolve();

  constructor(host: FollowHost) {
    this.host = host;
  }

  get on(): boolean {
    return this.onNow;
  }

  /** What the pages are shown (while Planning is on). */
  view(): NonNullable<LiveState['follow']> {
    return { on: this.onNow, live: { ...this.live }, note: this.onNow ? this.note : null };
  }

  /** The switch as it was kept (at start): nothing starts. */
  restore(on: boolean): void {
    this.onNow = on;
  }

  /** The switch from a page. On starts what is on screen now, as the director's own tap would. */
  setOn(on: boolean): Promise<void> {
    if (on === this.onNow) return this.busy;
    this.onNow = on;
    this.note = null;
    this.host.saveOn(on);
    this.host.changed();
    const slide = this.lastSlide;
    if (!on || !slide) return this.busy;
    return this.queue(() => this.follow(slide, true));
  }

  /** A tap by hand: Auto-follow stays off until someone switches it on again. */
  pause(): void {
    if (!this.onNow) return;
    this.onNow = false;
    this.note = null;
    this.host.saveOn(false);
    this.host.changed();
  }

  /** A slide from the presentation app (or a test). Resolves once it has been acted on. */
  slide(s: LiveSlide): Promise<void> {
    this.lastSlide = s;
    return this.queue(() => this.follow(s, false));
  }

  /** Connect, reconnect or disconnect the live connection to fit what is wanted. `restart`: connect again even if it fits (a new login). */
  fits(wanted: LiveWanted, restart = false): void {
    const key = wanted === null ? null : JSON.stringify(wanted);
    if (key === this.wantedKey && !restart) return;
    this.wantedKey = key;
    this.disconnect();
    if (wanted === null) {
      this.setLive(CLOSED);
    } else if ('problem' in wanted) {
      this.setLive({ state: 'closed', problem: wanted.problem, presenter: null });
    } else {
      this.connect(wanted.account);
    }
  }

  stop(): void {
    this.wantedKey = null;
    this.disconnect();
  }

  // ---- Inside ----

  private queue(fn: () => Promise<void>): Promise<void> {
    const next = this.busy.then(fn).catch((err) => this.host.log(`Auto-follow: ${(err as Error)?.message ?? String(err)}`));
    this.busy = next;
    return next;
  }

  private async follow(s: LiveSlide, fresh: boolean): Promise<void> {
    // A newer slide is on its way, or it was switched off meanwhile: that one (or nothing) is followed.
    if (!this.onNow || s !== this.lastSlide) return;
    const onStage = await this.host.onStage();
    if (!this.onNow || s !== this.lastSlide) return;
    // Switched on: what is on screen starts as if it had just come.
    const decision = followDecision(this.host.show(), s, fresh ? null : this.place, onStage);
    this.place = decision.place;
    this.note = decision.note;
    if (decision.start) {
      const error = await this.host.start(decision.start);
      if (error) this.host.log(`Auto-follow: ${decision.note.item} did not start: ${error}`);
    }
    this.host.changed();
  }

  private connect(setting: string | undefined): void {
    const turn = ++this.turn;
    this.setLive({ state: 'connecting', problem: null, presenter: null });
    const account = setting !== undefined ? Promise.resolve(setting) : this.firstAccount();
    account.then(
      (id) => {
        if (turn !== this.turn) return;
        const live: PresenterLive = new PresenterLive({
          planning: this.host.planning,
          account: id,
          open: this.host.open,
          onSlide: (s) => {
            if (this.presenter === live) void this.slide(s);
          },
          onStatus: (status) => {
            if (this.presenter === live) this.setLive(status);
          },
          log: this.host.log,
        });
        this.presenter = live;
        live.start();
      },
      (err) => {
        if (turn !== this.turn) return;
        const none = err instanceof PlanningError && err.message.startsWith('No planning account');
        this.setLive({ state: 'closed', problem: err instanceof PlanningError ? err.message : 'The planning service could not be reached.', presenter: null });
        if (none) return;
        // Another reason (no internet): look again later.
        this.retryTimer = setTimeout(() => {
          if (turn === this.turn) this.connect(setting);
        }, ACCOUNT_RETRY_MS);
        this.retryTimer.unref?.();
      },
    );
  }

  private async firstAccount(): Promise<string> {
    const first = (await this.host.planning.accounts())[0];
    if (!first) throw new PlanningError('No planning account was found for this login.');
    return first.id;
  }

  private disconnect(): void {
    this.turn++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const live = this.presenter;
    this.presenter = null;
    live?.stop();
  }

  private setLive(status: LiveStatus): void {
    const was = this.live;
    if (was.state === status.state && was.problem === status.problem && was.presenter === status.presenter) return;
    this.live = { ...status };
    this.host.changed();
  }
}

/** A section on stage (or in a draft): which one, and the groups it set. */
export interface SectionOnStage {
  ref: SectionRef;
  groups: string[];
}

/** The same colour or effect: the same preset, or a live pick or live effect that a saved preset holds exactly. */
function sameShown(show: Show, preset: string, now: LiveState['groups'][string]): boolean {
  if (now.preset === preset) return true;
  const saved = show.presets.find((p) => p.id === preset);
  const layer = saved?.layers.length === 1 ? saved.layers[0] : undefined;
  if (now.live) {
    if (layer?.kind !== 'static') return false;
    const c = layer.colour;
    if (!('hex' in c)) return false;
    const pct = (v: number | undefined) => Math.round((v ?? 0) * 100);
    return c.hex.toLowerCase() === now.live.colour.toLowerCase()
      && pct(c.white) === pct(now.live.white) && pct(c.amber) === pct(now.live.amber) && pct(c.uv) === pct(now.live.uv);
  }
  if (now.effect) return !!layer && isDeepStrictEqual(layer, now.effect);
  return false;
}

/**
 * Whether a group the section set runs another colour or level than the section's look says (the save bar's cue).
 * Null when the section can't be found in the show any more (a load without its song).
 */
export function sectionState(show: Show, section: SectionOnStage, state: Pick<LiveState, 'groups'>): NonNullable<LiveState['section']> | null {
  let lookId: string;
  try {
    lookId = sectionLookOf(show, section.ref);
  } catch {
    return null;
  }
  const look = show.looks.find((l) => l.id === lookId);
  if (!look) return null;
  const changed = section.groups.some((g) => {
    const entry = look.groups.find((e) => e.group === g);
    const now = state.groups[g];
    return !!entry && !!now && (!sameShown(show, entry.preset, now) || Math.abs(now.level - (entry.level ?? 1)) > 1e-9);
  });
  return { ...section.ref, changed };
}

/** A socket that never opens: a planning service handed to the App (a fake) gets no live connection unless `liveOpen` is given too. */
export function noSocket(): WebSocketLike {
  return { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
}
