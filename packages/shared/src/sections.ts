// The sections of a song (verse, chorus ...), read from the titles of its slides in the song library.
// Pure: the song arrives already decoded to plain JSON. Only titles and ids are read, never the lyrics.

import { z } from 'zod';

export const SectionKind = z.enum(['verse', 'pre-chorus', 'chorus', 'bridge', 'tag', 'intro', 'outro', 'interlude']);
export type SectionKind = z.infer<typeof SectionKind>;

export const SECTION_NAMES: Record<SectionKind, string> = {
  verse: 'Verse',
  'pre-chorus': 'Pre-chorus',
  chorus: 'Chorus',
  bridge: 'Bridge',
  tag: 'Tag',
  intro: 'Intro',
  outro: 'Outro',
  interlude: 'Interlude',
};

/** Slide title words (lowercase, no spaces or dashes) and the section each means. Add Latvian words here. */
const WORDS: Record<string, SectionKind> = {
  verse: 'verse',
  prechorus: 'pre-chorus',
  chorus: 'chorus',
  bridge: 'bridge',
  tag: 'tag',
  intro: 'intro',
  outro: 'outro',
  ending: 'outro',
  interlude: 'interlude',
  instrumental: 'interlude',
};

const wordOf = (text: string): SectionKind | null => {
  const word = text.replace(/[\s-]+/g, '');
  return Object.hasOwn(WORDS, word) ? WORDS[word]! : null;
};

/**
 * The section a slide title names, or null. "Verse 1a", "Chorus b EN" and "Pre-Chorus 1" work: a language mark,
 * numbers and one slide letter are ignored. The whole title is tried first, so "Tag" does not lose its "g".
 */
export function sectionKindOf(title: string): SectionKind | null {
  const text = title.toLowerCase().replace(/\s+(en|eng)$/, '').replace(/[0-9]+/g, ' ').trim();
  return wordOf(text) ?? wordOf(text.replace(/[a-z]$/, ''));
}

export const SongSection = z.object({
  kind: SectionKind,
  /** Every slide id of the song's library entry that is this kind. */
  slides: z.array(z.string().min(1).max(64)).max(200),
});
export type SongSection = z.infer<typeof SongSection>;

/** A song's sections: each kind once, in the order its first slide appears, with all its slides. */
export function songSections(song: unknown): SongSection[] {
  const data = song && typeof song === 'object' ? (song as { data?: unknown }).data : undefined;
  const slides = data && typeof data === 'object' ? (data as { slides?: unknown }).slides : undefined;
  const found = new Map<SectionKind, string[]>();
  for (const slide of Array.isArray(slides) ? slides : []) {
    const s = slide && typeof slide === 'object' ? (slide as Record<string, unknown>) : {};
    if (typeof s.slide_id !== 'string' || typeof s.slide_title !== 'string' || s.slide_id === '') continue;
    const kind = sectionKindOf(s.slide_title);
    if (!kind) continue;
    const list = found.get(kind) ?? [];
    list.push(s.slide_id);
    found.set(kind, list);
  }
  return [...found].map(([kind, ids]) => ({ kind, slides: ids }));
}
