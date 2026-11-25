// Grow: a mix of fill and fade. A soft front moves along the line and each segment fades up as it passes, so the lit
// part grows steadily; the next colour grows over the last one, and one colour grows out and fades back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EffectLayer } from '../../shared/src/index.ts';
import { compileEffect, renderEffect } from '../src/effects.ts';
import { dark } from '../src/light.ts';

const RED = { hex: '#ff0000' }, BLUE = { hex: '#0000ff' }, WHITE = { hex: '#ffffff' };
const grow = (over: Partial<EffectLayer> = {}) => compileEffect({
  kind: 'effect', effect: 'grow', colours: [RED, BLUE], speed: { beats: 16 },
  direction: 'centreOut', waves: 1, size: 0.5, edge: 'soft', intensity: 1, ...over,
}, new Map());

const COUNT = 16;
/** What segment `index` of 16 shows at `phase` (cycles): red, green and blue times intensity, 0 to 1. */
function at(fx: ReturnType<typeof grow>, index: number, phase: number): number[] {
  const l = renderEffect(dark(), fx, { index, count: COUNT }, phase);
  return [l.r * l.i, l.g * l.i, l.b * l.i];
}

test('grow from the middle: the middle takes the next colour before the ends', () => {
  const fx = grow();
  // Round 1 (blue growing over red), a third of the way in.
  const mid = at(fx, 7, 1.3), end = at(fx, 0, 1.3);
  assert.ok(mid[2]! > 0.9 && mid[0]! < 0.1, `the middle is blue: ${mid}`);
  assert.ok(end[0]! > 0.9 && end[2]! < 0.1, `the end is still red: ${end}`);
  // From the left instead: the left end goes first.
  const ltr = grow({ direction: 'ltr' });
  assert.ok(at(ltr, 0, 1.3)[2]! > at(ltr, 15, 1.3)[2]!);
  // By the end of the round every segment is blue.
  for (let i = 0; i < COUNT; i++) assert.ok(at(fx, i, 1.999)[2]! > 0.99, `segment ${i}`);
});

test('grow never jumps: small steps everywhere, through the end of each round', () => {
  for (const fx of [grow(), grow({ colours: [WHITE] }), grow({ direction: 'ltr', size: 0.1 }), grow({ edge: 'hard' }), grow({ size: 1 })]) {
    let worst = 0;
    const steps = 400;
    for (let k = 0; k < 3 * steps; k++) {
      for (let i = 0; i < COUNT; i++) {
        const a = at(fx, i, k / steps), b = at(fx, i, (k + 1) / steps);
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[c]! - b[c]!));
      }
    }
    // A segment's fade takes at least a tenth of a round. Mixed as light (as colour fade mixes), one colour channel climbs
    // fastest halfway between two colours: about 0.16 a step at 400 steps a round with the shortest fade. A jump would be
    // near 1.
    assert.ok(worst < 0.2, `${fx.direction} ${fx.colours.length} colours, ${fx.edge}, size ${fx.size}: largest step ${worst.toFixed(3)}`);
  }
});

test('grow in one colour grows out and fades back: dark at the start of a round, all lit halfway', () => {
  const fx = grow({ colours: [WHITE] });
  for (let i = 0; i < COUNT; i++) {
    assert.ok(at(fx, i, 2)[0]! < 0.01, `start, segment ${i}`);
    assert.ok(at(fx, i, 2.5)[0]! > 0.99, `halfway, segment ${i}`);
  }
  // On the way out the middle is lit before the ends, and on the way back it is the last to go.
  assert.ok(at(fx, 7, 2.15)[0]! > at(fx, 0, 2.15)[0]!);
  assert.ok(at(fx, 7, 2.85)[0]! > at(fx, 0, 2.85)[0]!);
});
