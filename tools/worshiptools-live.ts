// Follow what WorshipTools Presenter is showing: the live item (song), its slide and what is next.
//
//   node tools/worshiptools-live.ts [ACCOUNT_ID or a planning URL] [--once] [--json]
//
// --once prints the live item and stops; --json prints every message from Presenter as it comes.
// Without an account it follows every account you belong to. Log in first (see tools/worshiptools.ts).
//
// This listens the way stage.worshiptools.com (Presenter's stage display) does. Presenter
// joins a Pusher channel "presence-{account}" as a member with client "weDesktop"; its id
// is "{account}.{machine}". On "private-{id}" we send client-command {action: "activate"} and
// Presenter answers with client-event (current_cue, next_cue, current_slide, cuelist),
// client-slides (the live item's slides) and client-cuelist, each split into chunks
// {id, i, total, chunk} that join into JSON.

import { parseArgs } from 'node:util';
import { apiClient, machineId } from './worshiptools.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    once: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const api = apiClient();
const me = machineId();
const EVENTS = 'cuelist,event,slides,error,media-progress,countdown,stage-display';

try {
  const wanted = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(positionals[0] ?? '')?.[1];
  const accounts: { id: string; name: string }[] = wanted ? [{ id: wanted, name: '' }] : await api('/account');
  if (!accounts.length) throw new Error('This login has no WorshipTools accounts.');
  for (const account of accounts) follow(account);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

type Presenter = { id: string; name: string; cue?: string; slide?: string; slides: any[] };

/** One Pusher connection per account; it reconnects when it drops. */
function follow(account: { id: string; name: string }, retry = 0): void {
  let ws: WebSocket;
  let ping: ReturnType<typeof setInterval> | undefined;
  const presenters = new Map<string, Presenter>();
  const chunks = new Map<string, string[]>();
  const label = account.name || account.id;

  const send = (event: string, data: unknown, channel?: string) =>
    ws.send(JSON.stringify(channel ? { event, channel, data } : { event, data }));

  async function subscribe(channel: string, socketId: string): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries({
      socket_id: socketId,
      channel_name: channel,
      machineId: me,
      machineOS: 'Web',
      machineArch: process.arch,
      machineName: 'Light Runner',
      client: 'light-runner',
      events: EVENTS,
    })) form.append(k, v);
    const auth = await api(`/account/${account.id}/pusher`, { method: 'POST', body: form });
    send('pusher:subscribe', { channel, ...(typeof auth === 'string' ? JSON.parse(auth) : auth) });
  }

  function presenterJoined(id: string, info: any, socketId: string): void {
    if (info?.client !== 'weDesktop' || presenters.has(id)) return;
    const p: Presenter = { id, name: info.machineName || info.name || id.split('.')[1] || id, slides: [] };
    presenters.set(id, p);
    status(`Presenter open on ${p.name} (${label})`);
    subscribe(`presence-${id}`, socketId).catch(fail);
    subscribe(`private-${id}`, socketId).catch(fail);
  }

  function presenterMessage(p: Presenter, event: string, data: any): void {
    if (values.json) console.log(JSON.stringify({ presenter: p.name, event, data }));
    if (event === 'client-slides') p.slides = data?.slides ?? [];
    if (event === 'client-error') status(`Presenter: ${data?.msg ?? JSON.stringify(data)}`);
    if (event !== 'client-event') return;
    const cue = data?.current_cue?.name ?? '';
    const slide = data?.current_slide?.id ?? '';
    if (cue === p.cue && slide === p.slide) return;
    p.cue = cue;
    p.slide = slide;
    if (!values.json) {
      const at = p.slides.findIndex((s) => s.id === slide);
      const where = at >= 0 ? `  [slide ${at + 1}/${p.slides.length}]` : '';
      const next = data?.next_cue?.name ? `  next: ${data.next_cue.name}` : '';
      const who = presenters.size > 1 ? `${p.name}: ` : '';
      console.log(`${time()}  ${who}${cue || '(nothing live)'}${where}${next}`);
    }
    if (values.once) process.exit(0);
  }

  function fail(err: unknown): void {
    status(`${label}: ${(err as Error).message ?? err}`);
    ws?.close();
  }

  (async () => {
    const { APP_KEY, CLUSTER } = await api(`/account/${account.id}/pusher`);
    ws = new WebSocket(`wss://ws-${CLUSTER}.pusher.com/app/${APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`);
    let socketId = '';

    ws.onmessage = (msg) => {
      const m = JSON.parse(String(msg.data));
      let data = m.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {}
      }
      switch (m.event) {
        case 'pusher:connection_established':
          retry = 0;
          socketId = data.socket_id;
          ping = setInterval(() => send('pusher:ping', {}), (data.activity_timeout ?? 120) * 1000);
          subscribe(`presence-${account.id}`, socketId).catch(fail);
          return;
        case 'pusher:ping':
          return send('pusher:pong', {});
        case 'pusher:error':
          return status(`${label}: Pusher error ${data?.code ?? ''} ${data?.message ?? ''}`);
        case 'pusher_internal:subscription_succeeded':
          if (m.channel === `presence-${account.id}`) {
            const hash = data?.presence?.hash ?? {};
            for (const [id, info] of Object.entries(hash)) presenterJoined(id, info, socketId);
            if (!presenters.size) status(`Waiting for Presenter to open (${label})…`);
          } else if (m.channel.startsWith('private-')) {
            send('client-command', { action: 'activate', machineId: me }, m.channel);
          }
          return;
        case 'pusher_internal:member_added':
          if (m.channel === `presence-${account.id}`) presenterJoined(data.user_id, data.user_info, socketId);
          return;
        case 'pusher_internal:member_removed': {
          const p = m.channel === `presence-${account.id}` && presenters.get(data.user_id);
          if (!p) return;
          presenters.delete(p.id);
          send('pusher:unsubscribe', { channel: `presence-${p.id}` });
          send('pusher:unsubscribe', { channel: `private-${p.id}` });
          return status(`Presenter closed on ${p.name} (${label})`);
        }
      }
      const p = m.channel && presenters.get(m.channel.replace(/^(private|presence)-/, ''));
      if (!p || !m.event.startsWith('client-')) return;
      if (data && typeof data === 'object' && 'chunk' in data && 'total' in data) {
        const key = `${m.event} ${data.id}`;
        const parts = chunks.get(key) ?? [];
        parts[data.i] = data.chunk;
        chunks.set(key, parts);
        if (parts.filter((x) => x !== undefined).length < data.total) return;
        chunks.delete(key);
        data = JSON.parse(parts.join(''));
      }
      presenterMessage(p, m.event, data);
    };

    ws.onclose = () => {
      clearInterval(ping);
      presenters.clear();
      chunks.clear();
      const wait = Math.min(60, 2 ** retry) * 1000;
      status(`${label}: connection closed, trying again in ${wait / 1000} s`);
      setTimeout(() => follow(account, retry + 1), wait);
    };
  })().catch((err) => {
    status(`${label}: ${err.message}`);
    setTimeout(() => follow(account, retry + 1), Math.min(60, 2 ** retry) * 1000);
  });
}

function status(text: string): void {
  console.error(`${time()}  ${text}`);
}

function time(): string {
  return new Date().toLocaleTimeString('en-GB');
}
