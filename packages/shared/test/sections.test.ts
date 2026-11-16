import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionKindOf, songSections } from '../src/index.ts';

test('section kinds from slide titles', () => {
  const cases: [string, string | null][] = [
    ['Verse 1a', 'verse'], ['Verse 2 b', 'verse'], ['Verse', 'verse'], ['PreChorus', 'pre-chorus'], ['Pre-Chorus 1', 'pre-chorus'],
    ['Chorus a', 'chorus'], ['Chorusb', 'chorus'], ['Chorus 2 a', 'chorus'], ['Chorus a EN', 'chorus'], ['chorus eng', 'chorus'],
    ['Bridge 1 a', 'bridge'], ['Tag', 'tag'], ['Intro', 'intro'], ['Ending', 'outro'], ['Outro', 'outro'],
    ['Instrumental', 'interlude'], ['Slide 11 a', null], ['', null], ['Choruses of angels', null],
  ];
  for (const [title, kind] of cases) assert.equal(sectionKindOf(title), kind, title);
});

test('a song lists each kind once, in order of first slide, with all its slides', () => {
  const song = { data: { slides: [
    { slide_id: 'v1', slide_title: 'Verse 1a' }, { slide_id: 'c1', slide_title: 'Chorusa' }, { slide_id: 'c2', slide_title: 'Chorus b' },
    { slide_id: 'v2', slide_title: 'Verse 2' }, { slide_id: 's', slide_title: 'Slide 9' }, { slide_id: 'b', slide_title: 'Bridge' },
  ] } };
  assert.deepEqual(songSections(song), [
    { kind: 'verse', slides: ['v1', 'v2'] }, { kind: 'chorus', slides: ['c1', 'c2'] }, { kind: 'bridge', slides: ['b'] },
  ]);
});

test('a song with no named sections, or no slides, has none', () => {
  assert.deepEqual(songSections({ data: { slides: [{ slide_id: 'a', slide_title: 'Slide 1' }, { slide_id: 'b' }] } }), []);
  assert.deepEqual(songSections({}), []);
});
