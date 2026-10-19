// The picture of a look as it looks once settled, for the Preview page. It
// runs a throwaway engine, so it never touches the stage.

import type { Show } from '../../shared/src/index.ts';
import { Engine } from './engine.ts';

/** Frames after the look starts: far past any fade or ramp, so everything has settled. */
const SETTLED = 60;

/**
 * The look at rest, as the visualiser draws it: 3 bytes (RGB) per fixture in show order,
 * the same order as the engine's fixtures. Master is 1, so nothing is dimmed, and a
 * group the look doesn't set stays dark. The safe look runs as Basic lights does.
 */
export function settledVisual(show: Show, lookId: string): Uint8Array {
  const engine = new Engine(show, 0);
  if (lookId === show.operator.safeLook) engine.apply({ type: 'safe' }, 0);
  else engine.apply({ type: 'look', id: lookId, fade: 0 }, 0);
  engine.frame(0);
  // The visual buffer belongs to the engine, so keep a copy.
  return Uint8Array.from(engine.frame(SETTLED).visual);
}
