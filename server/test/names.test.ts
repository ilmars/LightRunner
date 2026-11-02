// Suggested names for new effects and quick looks (web/shared/names.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourWord, effectSuggestion, listNames, lookSuggestion, uniqueName } from '../../web/shared/names.js';

test('a freely picked colour gets a plain word', () => {
  assert.equal(colourWord('#ffee22'), 'yellow');
  assert.equal(colourWord('#7a2cff'), 'purple');
  assert.equal(colourWord('#1060ff'), 'blue');
  assert.equal(colourWord('#ff1010'), 'red');
  assert.equal(colourWord('#20e040'), 'green');
  assert.equal(colourWord('#ff8a1a'), 'orange');
  assert.equal(colourWord('#ff2ab0'), 'pink');
  assert.equal(colourWord('#20e0e0'), 'cyan');
  assert.equal(colourWord('#ffffff'), 'white');
  assert.equal(colourWord('#ffe0b0'), 'warm white');
  assert.equal(colourWord('#d8e4ff'), 'cool white');
  assert.equal(colourWord('#050505'), 'dim');
  assert.equal(colourWord('nonsense'), 'white');
});

test('names are listed in plain words, later ones starting small unless written as a code', () => {
  assert.equal(listNames(['Warm']), 'Warm');
  assert.equal(listNames(['Warm', 'Purple']), 'Warm and purple');
  assert.equal(listNames(['Warm', 'Purple', 'yellow']), 'Warm, purple and yellow');
  assert.equal(listNames(['Violets', 'UV', 'Silti 3200K']), 'Violets, UV and silti 3200K');
});

test("an effect is named from its colours and what it does", () => {
  assert.equal(effectSuggestion(['Purple'], 'Chase'), 'Purple chase');
  assert.equal(effectSuggestion(['Blue', 'white'], 'Wave'), 'Blue and white wave');
  assert.equal(effectSuggestion(['Blue', 'Blue', 'Red'], 'Colour fade'), 'Blue and red colour fade', 'each colour once');
  assert.equal(effectSuggestion(['Red', 'Green', 'Blue', 'White'], 'Sparkle'), 'Red, green and blue sparkle', 'up to three');
  assert.equal(effectSuggestion([], 'Breathe'), 'Breathe');
});

test('a quick look is named from its groups, the owner\'s example among them', () => {
  // Front wash Warm, Back wall Purple, Audience a free yellow, Pulpit just On (no colour word).
  assert.equal(lookSuggestion(['Warm', 'Purple', 'yellow', null]), 'Warm, purple and yellow');
  assert.equal(lookSuggestion(['Violets', 'Violets', 'Violets']), 'All violets');
  assert.equal(lookSuggestion(['Silti 3200K', 'Silti balts', 'Violets', 'Violets', 'Violets']), 'Violets, silti 3200K and silti balts', 'most used first');
  assert.equal(lookSuggestion(['Purple chase', 'Warm']), 'Purple chase and warm');
  assert.equal(lookSuggestion(['Purple']), 'Purple', 'one group: no "All"');
  assert.equal(lookSuggestion([null, null]), '');
});

test('a taken name gets the next number', () => {
  assert.equal(uniqueName('Purple chase', ['Wave']), 'Purple chase');
  assert.equal(uniqueName('Purple chase', ['purple chase', 'Purple chase 2']), 'Purple chase 3');
  assert.equal(uniqueName('', ['x']), '');
});
