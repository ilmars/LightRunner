// What the lights do for each slide the presentation app shows (Auto-follow). Pure: it only decides.

import type { SectionRef } from './planning.ts';
import type { SectionKind } from './sections.ts';
import { sectionLookOf } from './runningorder.ts';
import type { Show } from './schema.ts';

/** The slide on screen now, as the presentation app reports it. `slide` is null for an item's Blank slide. */
export interface LiveSlide {
  service: string;
  cue: string;
  slide: string | null;
  name: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SONG_SLIDE = new RegExp(`^(${UUID})-(${UUID})-slide-\\d+$`);
const BLANK_SLIDE = new RegExp(`^(${UUID})-blank-[^-]+-slide-\\d+$`);

/** Reads `{cue}-{slide}-slide-{n}` and a song's Blank slide `{cue}-blank-{x}-slide-{n}`; anything else is null. */
export function parseSlideId(id: string): { cue: string; slide: string | null } | null {
  const song = SONG_SLIDE.exec(id);
  if (song) return { cue: song[1]!, slide: song[2]! };
  const blank = BLANK_SLIDE.exec(id);
  if (blank) return { cue: blank[1]!, slide: null };
  return null;
}

/** What is on the real stage now: the look and, when it is a song's section, which one. */
export interface OnStage {
  look: string | null;
  section: SectionRef | null;
}

/** The last item followed and the key of the header above it. */
export interface FollowPlace {
  cue: string;
  part: string | null;
}

export type FollowStart =
  | { kind: 'item'; look: string }
  /** `look` is what the section plays: its own, else the song's. */
  | { kind: 'section'; ref: SectionRef; look: string };

/** What the pill tells: the item, its section, and what Auto-follow did about it. */
export interface FollowNote {
  item: string;
  section: SectionKind | null;
  kind: 'look' | 'verse' | 'nothing' | 'not-in-order';
}

/**
 * What to start for the slide on screen, where it now stands, and what to tell. Never throws: anything it does
 * not know (another service, an unknown item, a song with no look) starts nothing.
 */
export function followDecision(
  show: Show,
  live: LiveSlide,
  last: FollowPlace | null,
  onStage: OnStage,
): { start: FollowStart | null; place: FollowPlace; note: FollowNote } {
  const service = show.operator.service;
  const at = service && service.id === live.service ? service.items.findIndex((i) => i.key === live.cue) : -1;
  if (!service || at < 0) {
    return {
      start: null,
      place: last ?? { cue: live.cue, part: null },
      note: { item: live.name, section: null, kind: 'not-in-order' },
    };
  }
  const item = service.items[at]!;

  // The header above the item is its part.
  let header = null;
  for (let i = at - 1; i >= 0 && !header; i--) if (service.items[i]!.kind === 'header') header = service.items[i]!;
  const part = header?.key ?? null;
  const place: FollowPlace = { cue: item.key, part };

  const newItem = last === null || last.cue !== item.key;
  const newPart = last === null || last.part !== part;
  const section = item.kind === 'song' && live.slide !== null ? item.sections?.find((s) => s.slides.includes(live.slide!)) : undefined;
  const done = (start: FollowStart | null, kind: FollowNote['kind'], kindOfSection: SectionKind | null = null) =>
    ({ start, place, note: { item: item.name, section: kindOfSection, kind } });

  // A slide of a section: its look, unless that section is already on stage.
  if (section && item.look !== undefined) {
    const ref: SectionRef = { song: item.look, kind: section.kind };
    if (!newItem && onStage.section?.song === ref.song && onStage.section.kind === ref.kind) return done(null, 'nothing', section.kind);
    try {
      return done({ kind: 'section', ref, look: sectionLookOf(show, ref) }, 'look', section.kind);
    } catch {
      return done(null, 'nothing', section.kind);
    }
  }
  if (section) return done(null, 'nothing', section.kind); // the song's row is gone

  // A song's Blank slide starts the song's look again (also when a section is on stage).
  if (item.kind === 'song' && live.slide === null && item.look !== undefined) {
    if (!newItem && onStage.look === item.look && onStage.section === null) return done(null, 'nothing');
    return done({ kind: 'item', look: item.look }, 'look');
  }

  if (newItem) {
    if (item.look !== undefined) return done({ kind: 'item', look: item.look }, 'look');
    if (newPart && header?.look !== undefined) return done({ kind: 'item', look: header.look }, 'look');
  }
  return done(null, item.kind === 'verse' ? 'verse' : 'nothing');
}
