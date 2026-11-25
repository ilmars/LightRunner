// A song's colour square, and the show's for songs without their own (the new operator page's colour panel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Command, parseShow, setColourSquare, type ColourSquare, type Show } from '../src/index.ts';

const demo = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../server/seed/demo-show.json', import.meta.url), 'utf8')));
const square = (names = ['Zils', 'Violets', 'Silti balts', 'Rozā']): ColourSquare =>
  names.map((name, i) => ({ name, colour: { hex: ['#2b4dff', '#8f4dff', '#ffd9a8', '#ff4fa0'][i]! } }));

test('a song gets its own square, the show gets one for the rest, and null takes either away', () => {
  const show = demo();
  const song = show.looks[0]!.id;
  const withSong = setColourSquare(show, song, square());
  assert.deepEqual(withSong.looks[0]!.square, square());
  assert.equal(show.looks[0]!.square, undefined, 'the input is never changed');
  const withShow = setColourSquare(withSong, null, square(['A', 'B', 'C', 'D']));
  assert.equal(withShow.operator.square![0]!.name, 'A');
  // Both survive a save and load.
  const again = parseShow(JSON.parse(JSON.stringify(withShow)));
  assert.deepEqual(again.looks[0]!.square, square());
  assert.equal(again.operator.square!.length, 4);
  assert.equal(setColourSquare(again, song, null).looks[0]!.square, undefined);
  assert.equal(setColourSquare(again, null, null).operator.square, undefined);
});

test('a square has exactly four corners, a known song, and names kept short', () => {
  const show = demo();
  assert.throws(() => setColourSquare(show, 'nope', square()), /There is no song "nope"/);
  assert.throws(() => setColourSquare(show, null, square().slice(0, 3)));
  const long = setColourSquare(show, null, square(['  Very long name '.repeat(5), 'B', 'C', 'D']));
  assert.ok(long.operator.square![0]!.name.length <= 40);
  // The command refuses anything but four corners before it gets that far.
  assert.equal(Command.safeParse({ type: 'colourSquare', item: null, corners: square().slice(0, 2) }).success, false);
  assert.equal(Command.safeParse({ type: 'colourSquare', item: 'song-1', corners: null }).success, true);
});
