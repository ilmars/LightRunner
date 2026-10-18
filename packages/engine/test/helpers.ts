import { readFileSync } from 'node:fs';
import { parseShow, type Show } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';

export const FRAME = 0.025;

export function demoShow(): Show {
  const url = new URL('../../../server/seed/demo-show.json', import.meta.url);
  return parseShow(JSON.parse(readFileSync(url, 'utf8')));
}

/** Run frames from `from` to `to` and return the largest per-frame intensity change of any fixture. */
export function maxStep(engine: Engine, from: number, to: number, onFrame?: (t: number) => void): number {
  let prev = engine.lights().map((l) => l.i);
  let worst = 0;
  for (let t = from; t <= to + 1e-9; t += FRAME) {
    onFrame?.(t);
    engine.frame(t);
    const now = engine.lights().map((l) => l.i);
    for (let k = 0; k < now.length; k++) worst = Math.max(worst, Math.abs(now[k] - prev[k]));
    prev = now;
  }
  return worst;
}

export function lightOf(engine: Engine, fixture: string) {
  const i = engine.fixtureIds().indexOf(fixture);
  if (i < 0) throw new Error(`no fixture ${fixture}`);
  return { ...engine.lights()[i] };
}

export function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}
