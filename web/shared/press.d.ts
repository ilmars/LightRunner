// Types for press.js, so the tests can check it.

export const SWIPE_WAIT: number;
export const SWIPE_SLOP: number;
export const MIN_HOLD: number;
export const SIDEWAYS_SLOP: number;
export function isSideways(dx: number, dy: number): boolean;

export interface FlashPressesOptions<K> {
  send(cmd: { type: 'flash'; groups: string[]; on: boolean }): unknown;
  setDown(key: K, down: boolean): void;
  canFlash?(key: K): boolean;
  now?(): number;
  setTimer?(fn: () => void, ms: number): any;
  clearTimer?(timer: any): void;
}

export class FlashPresses<K = unknown> {
  constructor(options: FlashPressesOptions<K>);
  press(id: number, key: K, groups: string[], options?: { wait?: boolean; x?: number; y?: number }): void;
  move(id: number, x: number, y: number): void;
  release(id: number): void;
  cancel(id: number): void;
  allOff(): void;
  reset(): void;
}
