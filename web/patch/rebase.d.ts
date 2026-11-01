// Types for rebase.js, so the tests can check it.

import type { Show } from '../../packages/shared/src/index.ts';

export function rebasePatch(base: Show, mine: Show, fresh: Show): Show;
