// Read-only check of a running Light Runner: is it answering, is it sending to the lights, what is on stage,
// is a controller there. It never changes anything (only GETs). Run with Node 24:
//   node .claude/skills/light-runner-service/scripts/check.ts [http://host:port]
// Default address: http://localhost:8080

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');

async function get(path: string): Promise<unknown> {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

type State = {
  look: string | null;
  lookChanged?: boolean;
  master?: number;
  output: 'ok' | 'lost' | 'off';
  outputProblem: string | null;
  outputProblemKind: 'other-desk' | 'not-answering' | null;
  held?: unknown[];
};
type Layout = {
  runningOrder?: { id: string; name: string }[];
  basicLights?: string | null;
  groups?: { id: string; name: string; kind?: string }[];
  contact?: { name?: string; phone?: string } | null;
  manualForOperators?: boolean;
  keys?: { midi?: boolean; connected?: number };
};
type Apc = { midi: boolean; connected: boolean; model: string | null };

const lines: string[] = [];
const say = (ok: boolean | null, text: string) => lines.push(`${ok === null ? '·' : ok ? '✓' : '✗'} ${text}`);

try {
  const [state, layout] = (await Promise.all([get('/api/state'), get('/api/layout')])) as [State, Layout];
  say(true, `Light Runner answers at ${base}`);

  if (state.output === 'ok') say(true, 'Sending to the lights, and the lights answer');
  else if (state.output === 'off') say(false, 'Not sending to the lights: Send DMX is off (Settings), or it was started with LIGHT_RUNNER_OUTPUT=none');
  else say(false, `Problem with the lights${state.outputProblemKind === 'other-desk' ? ' (another desk is sending)' : ''}: ${state.outputProblem ?? 'no details'}`);

  const items = layout.runningOrder ?? [];
  const onStage = state.look === null ? 'nothing yet'
    : state.look === 'blackout' ? 'Blackout'
    : state.look === 'safe' ? 'Basic lights'
    : items.find((i) => i.id === state.look)?.name ?? state.look;
  say(null, `On stage: ${onStage}${state.lookChanged ? ' (changed since it was saved)' : ''}`);
  if (typeof state.master === 'number' && state.master < 1) say(false, `Master is at ${Math.round(state.master * 100)} %`);
  if (state.held?.length) say(null, `${state.held.length} individual light(s) are held (Release all on the operator page)`);
  say(null, `Running order: ${items.length} item(s); light groups: ${(layout.groups ?? []).filter((g) => g.kind !== 'smoke').map((g) => g.name).join(', ') || 'none'}`);
  say(Boolean(layout.contact), layout.contact ? 'Who to call is set' : 'Who to call is not set (Settings)');

  try {
    const apc = (await get('/api/apc')) as Apc;
    if (!apc.midi) say(false, 'MIDI support is not installed (run npm install with Node 24 on this computer)');
    else if (apc.connected) say(true, `APC mini connected${apc.model ? ` (${apc.model})` : ''}`);
    else say(null, `No APC mini connected${layout.keys?.connected ? `; ${layout.keys.connected} other controller(s) listened to` : ''}`);
  } catch {
    say(null, 'Controller status not available (needs the programmer PIN on this server)');
  }
} catch (e) {
  say(false, `Light Runner does not answer at ${base} (${e instanceof Error ? e.message : String(e)}). Is it started, and is this the right address?`);
}

console.log(lines.join('\n'));
