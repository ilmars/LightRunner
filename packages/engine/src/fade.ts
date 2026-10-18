// Time-based fades. Everything here takes `now` in seconds from a monotonic
// clock, never a frame count, so a late frame never slows a fade down.

/** Smooth ease-in-out, e(p) = 3p² − 2p³. */
export function ease(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return p * p * (3 - 2 * p);
}

/** A scalar that eases to each new target from wherever it is now. */
export class Ramp {
  private from: number;
  private to: number;
  private start = 0;
  private dur = 0;

  constructor(value: number) {
    this.from = value;
    this.to = value;
  }

  get target(): number {
    return this.to;
  }

  set(target: number, now: number, dur: number): void {
    this.from = this.value(now);
    this.to = target;
    this.start = now;
    this.dur = dur;
  }

  value(now: number): number {
    if (this.dur <= 0 || now >= this.start + this.dur) return this.to;
    return this.from + (this.to - this.from) * ease((now - this.start) / this.dur);
  }

  settled(now: number): boolean {
    return this.dur <= 0 || now >= this.start + this.dur;
  }
}

export interface Weighted<T> {
  item: T;
  weight: number;
}

interface Entry<T> {
  key: string;
  item: T;
  w0: number;
}

/**
 * A weighted mix of items. Pushing an item fades it in
 * from whatever the mix is at that moment, so a change mid-fade continues
 * smoothly instead of snapping. Pushing an item that is still in the mix
 * reuses its entry, so a moving effect keeps its phase.
 */
export class Crossfade<T> {
  private entries: Entry<T>[] = [];
  private incoming: Entry<T> | null = null;
  private start = 0;
  private dur = 0;
  private readonly maxEntries: number;

  constructor(maxEntries = 8) {
    this.maxEntries = maxEntries;
  }

  /** Key of the item the mix is settling on, or null when empty. */
  get currentKey(): string | null {
    return this.incoming?.key ?? null;
  }

  get current(): T | null {
    return this.incoming?.item ?? null;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Start fading to `key` over `dur` seconds. `make` builds the item if it is not in the mix. */
  push(key: string, make: () => T, now: number, dur: number): T {
    for (const e of this.entries) e.w0 = this.weightOf(e, now);
    let entry = this.entries.find((e) => e.key === key);
    if (!entry) {
      entry = { key, item: make(), w0: 0 };
      this.entries.push(entry);
    }
    this.incoming = entry;
    this.start = now;
    this.dur = dur;
    this.prune(now);
    return entry.item;
  }

  progress(now: number): number {
    if (!this.incoming || this.dur <= 0) return 1;
    return Math.min(1, Math.max(0, (now - this.start) / this.dur));
  }

  /**
   * Current weights. They sum to 1 once anything has settled; the first push
   * into an empty mix fades up from nothing, so its weight starts at 0.
   * Drops entries that have faded out.
   */
  weights(now: number): Weighted<T>[] {
    this.prune(now);
    return this.entries.map((e) => ({ item: e.item, weight: this.weightOf(e, now) }));
  }

  /** Every item still in the mix, including ones fading out. */
  items(): T[] {
    return this.entries.map((e) => e.item);
  }

  /** Replace items in place, e.g. after the show is edited. */
  update(fn: (key: string, item: T) => T): void {
    for (const e of this.entries) e.item = fn(e.key, e.item);
  }

  private weightOf(e: Entry<T>, now: number): number {
    const k = ease(this.progress(now));
    return e === this.incoming ? e.w0 + (1 - e.w0) * k : e.w0 * (1 - k);
  }

  private prune(now: number): void {
    // Outgoing entries leave once fully faded, so the mix never dips. The cap
    // only matters for very fast tapping; then the faintest entry goes first.
    this.entries = this.entries.filter((e) => e === this.incoming || this.weightOf(e, now) > 0);
    while (this.entries.length > this.maxEntries) {
      let smallest = -1;
      let min = Infinity;
      this.entries.forEach((e, i) => {
        const w = this.weightOf(e, now);
        if (e !== this.incoming && w < min) {
          min = w;
          smallest = i;
        }
      });
      this.entries.splice(smallest, 1);
    }
  }
}
