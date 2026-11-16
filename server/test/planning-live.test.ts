import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PresenterLive, type LiveStatus, type WebSocketLike } from '../src/planning/live.ts';
import { FakePlanning } from '../src/planning/fake.ts';
import type { LiveSlide } from '../../packages/shared/src/index.ts';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CUELIST = '22222222-2222-4222-8222-222222222222';
const CUE = '33333333-3333-4333-8333-333333333333';
const SLIDE = '44444444-4444-4444-8444-444444444444';
const SLIDE_2 = '55555555-5555-4555-8555-555555555555';
const PRESENTER = 'ABC123';
const CHANNEL = `${ACCOUNT}.${PRESENTER}`;

class FakeSocket implements WebSocketLike {
  sent: any[] = [];
  closed = false;
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close(): void {
    this.closed = true;
  }
  /** What Pusher sends: the data is a JSON string. */
  receive(event: string, data: unknown, channel?: string): void {
    this.onmessage!({ data: JSON.stringify({ event, ...(channel ? { channel } : {}), data: JSON.stringify(data) }) });
  }
  sentEvents(): string[] {
    return this.sent.map((m) => m.event);
  }
}

/** Let pending promises settle (timers are mocked; setImmediate is not). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function setup() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const planning = new FakePlanning();
  const sockets: FakeSocket[] = [];
  const slides: LiveSlide[] = [];
  const statuses: LiveStatus[] = [];
  const logs: string[] = [];
  const live = new PresenterLive({
    planning,
    account: ACCOUNT,
    open: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onSlide: (s) => slides.push(s),
    onStatus: (s) => statuses.push(s),
    log: (l) => logs.push(l),
  });
  return { planning, sockets, slides, statuses, logs, live };
}

/** Connect, then a Presenter joins and its private channel is subscribed. */
async function openedPresenter(t: ReturnType<typeof setup>): Promise<FakeSocket> {
  t.live.start();
  await settle();
  const ws = t.sockets[0]!;
  ws.receive('pusher:connection_established', { socket_id: '1.2', activity_timeout: 120 });
  await settle();
  ws.receive('pusher_internal:subscription_succeeded', { presence: { hash: { [PRESENTER]: { client: 'weDesktop', machineName: 'Stage Mac' } } } }, `presence-${ACCOUNT}`);
  await settle();
  ws.receive('pusher_internal:subscription_succeeded', {}, `private-${CHANNEL}`);
  return ws;
}

const eventData = (slideId: string, cueName = 'Song one') => ({
  current_cue: { name: cueName },
  current_slide: { id: slideId },
  cuelist: { id: CUELIST },
});
const song = (slide = SLIDE) => `${CUE}-${slide}-slide-1`;

afterEach(() => mock.timers.reset());

test('connects to Pusher and subscribes to the account channel with the auth answer', async () => {
  const t = setup();
  t.live.start();
  await settle();
  assert.equal(t.sockets.length, 1);
  assert.equal(t.sockets[0]!.url, 'wss://ws-test.pusher.com/app/test-key?protocol=7&client=js&version=8.4.0&flash=false');
  assert.deepEqual(t.statuses.at(-1), { state: 'connecting', problem: null, presenter: null });
  t.sockets[0]!.receive('pusher:connection_established', { socket_id: '1.2', activity_timeout: 120 });
  await settle();
  assert.deepEqual(t.sockets[0]!.sent, [{ event: 'pusher:subscribe', data: { channel: `presence-${ACCOUNT}`, auth: 'test' } }]);
  assert.ok(t.planning.calls.includes(`liveKeys ${ACCOUNT}`));
  assert.ok(t.planning.calls.includes(`liveAuth ${ACCOUNT} 1.2 presence-${ACCOUNT}`));
  t.live.stop();
});

test('waits when no presentation computer is there', async () => {
  const t = setup();
  t.live.start();
  await settle();
  const ws = t.sockets[0]!;
  ws.receive('pusher:connection_established', { socket_id: '1.2' });
  await settle();
  ws.receive('pusher_internal:subscription_succeeded', { presence: { hash: {} } }, `presence-${ACCOUNT}`);
  assert.deepEqual(t.statuses.at(-1), { state: 'waiting', problem: null, presenter: null });
  t.live.stop();
});

test('a presentation computer: its channels are subscribed and it is told to activate', async () => {
  const t = setup();
  const ws = await openedPresenter(t);
  await settle();
  const subscribed = ws.sent.filter((m) => m.event === 'pusher:subscribe').map((m) => m.data.channel);
  for (const c of [`presence-${CHANNEL}`, `private-${CHANNEL}`]) assert.ok(subscribed.includes(c), c);
  assert.deepEqual(ws.sent.at(-1), { event: 'client-command', channel: `private-${CHANNEL}`, data: { action: 'activate', machineId: 'test-machine' } });
  assert.deepEqual(t.statuses.at(-1), { state: 'open', problem: null, presenter: 'Stage Mac' });
  t.live.stop();
});

test('an older member id that carries the account keeps its own channel name', async () => {
  const t = setup();
  t.live.start();
  await settle();
  const ws = t.sockets[0]!;
  ws.receive('pusher:connection_established', { socket_id: '1.2' });
  await settle();
  ws.receive('pusher_internal:subscription_succeeded', { presence: { hash: { [CHANNEL]: { client: 'weDesktop', machineName: 'Old' } } } }, `presence-${ACCOUNT}`);
  await settle();
  const subscribed = ws.sent.filter((m) => m.event === 'pusher:subscribe').map((m) => m.data.channel);
  assert.ok(subscribed.includes(`private-${CHANNEL}`));
  assert.ok(!subscribed.some((c: string) => c.includes(`${ACCOUNT}.${ACCOUNT}`)));
  t.live.stop();
});

test('other members are ignored; a second presentation computer is logged, not followed', async () => {
  const t = setup();
  const ws = await openedPresenter(t);
  await settle();
  const before = ws.sent.length;
  ws.receive('pusher_internal:member_added', { user_id: 'web1', user_info: { client: 'web' } }, `presence-${ACCOUNT}`);
  ws.receive('pusher_internal:member_added', { user_id: 'SECOND', user_info: { client: 'weDesktop', machineName: 'Other' } }, `presence-${ACCOUNT}`);
  await settle();
  assert.equal(ws.sent.length, before);
  assert.ok(t.logs.some((l) => l.includes('Other')));
  assert.equal(t.statuses.at(-1)!.presenter, 'Stage Mac');
  t.live.stop();
});

test('a slide event in three chunks gives one slide; the same slide again gives none', async () => {
  const t = setup();
  const ws = await openedPresenter(t);
  const json = JSON.stringify(eventData(song()));
  const a = json.slice(0, 20);
  const b = json.slice(20, 50);
  const c = json.slice(50);
  const chunk = (i: number, text: string) => ({ id: 'x1', i, total: 3, chunk: text });
  ws.receive('client-event', chunk(0, a), `private-${CHANNEL}`);
  ws.receive('client-event', chunk(2, c), `private-${CHANNEL}`);
  assert.equal(t.slides.length, 0);
  ws.receive('client-event', chunk(1, b), `private-${CHANNEL}`);
  assert.deepEqual(t.slides, [{ service: CUELIST, cue: CUE, slide: SLIDE, name: 'Song one' }]);
  ws.receive('client-event', eventData(song()), `private-${CHANNEL}`);
  assert.equal(t.slides.length, 1);
  ws.receive('client-event', eventData(song(SLIDE_2)), `private-${CHANNEL}`);
  assert.equal(t.slides.length, 2);
  assert.equal(t.slides[1]!.slide, SLIDE_2);
  t.live.stop();
});

test('a blank slide gives slide null; an id nobody understands gives nothing', async () => {
  const t = setup();
  const ws = await openedPresenter(t);
  ws.receive('client-event', eventData(`${CUE}-blank-abc-slide-3`), `private-${CHANNEL}`);
  assert.deepEqual(t.slides, [{ service: CUELIST, cue: CUE, slide: null, name: 'Song one' }]);
  ws.receive('client-event', eventData('something-else'), `private-${CHANNEL}`);
  ws.receive('client-event', { current_cue: { name: 'x' } }, `private-${CHANNEL}`);
  assert.equal(t.slides.length, 1);
  t.live.stop();
});

test('a ping is answered; the Presenter leaving makes it wait again', async () => {
  const t = setup();
  const ws = await openedPresenter(t);
  ws.receive('pusher:ping', {});
  assert.deepEqual(ws.sent.at(-1), { event: 'pusher:pong', data: {} });
  ws.receive('pusher_internal:member_removed', { user_id: PRESENTER }, `presence-${ACCOUNT}`);
  assert.deepEqual(t.statuses.at(-1), { state: 'waiting', problem: null, presenter: null });
  // its slides no longer count
  ws.receive('client-event', eventData(song()), `private-${CHANNEL}`);
  assert.equal(t.slides.length, 0);
  t.live.stop();
});

test('a close says closed and tries again after 1, 2, 4 ... up to 60 seconds', async () => {
  const t = setup();
  t.live.start();
  await settle();
  const waits = [1, 2, 4, 8, 16, 32, 60, 60];
  for (const [n, wait] of waits.entries()) {
    const ws = t.sockets[n]!;
    ws.onclose!();
    assert.equal(t.statuses.at(-1)!.state, 'closed');
    mock.timers.tick(wait * 1000 - 1);
    await settle();
    assert.equal(t.sockets.length, n + 1, `not yet after ${wait} s`);
    mock.timers.tick(1);
    await settle();
    assert.equal(t.sockets.length, n + 2, `tried again after ${wait} s`);
  }
  t.live.stop();
});

test('the wait starts over after a connection has been established', async () => {
  const t = setup();
  t.live.start();
  await settle();
  t.sockets[0]!.onclose!();
  mock.timers.tick(1000);
  await settle();
  t.sockets[1]!.onclose!();
  mock.timers.tick(2000);
  await settle();
  t.sockets[2]!.receive('pusher:connection_established', { socket_id: '1.2' });
  await settle();
  t.sockets[2]!.onclose!();
  mock.timers.tick(1000);
  await settle();
  assert.equal(t.sockets.length, 4);
  t.live.stop();
});

test('stop closes the socket and never tries again, also with a retry pending', async () => {
  const t = setup();
  t.live.start();
  await settle();
  t.live.stop();
  assert.equal(t.sockets[0]!.closed, true);
  t.sockets[0]!.onclose?.();
  mock.timers.tick(120_000);
  await settle();
  assert.equal(t.sockets.length, 1);

  mock.timers.reset();
  const u = setup();
  u.live.start();
  await settle();
  u.sockets[0]!.onclose!();
  u.live.stop();
  mock.timers.tick(120_000);
  await settle();
  assert.equal(u.sockets.length, 1);
});

test('messages that are not JSON, or chunks that never finish, are ignored', async () => {
  const t = setup();
  const ws = await openedPresenter(t);
  ws.onmessage!({ data: 'not json {' });
  ws.onmessage!({ data: 42 });
  ws.onmessage!({ data: JSON.stringify(null) });
  ws.receive('client-event', { id: 'a', i: 0, total: 2, chunk: '{"cur' }, `private-${CHANNEL}`);
  ws.receive('client-event', { id: 'b', i: 0, total: 1, chunk: 'not json' }, `private-${CHANNEL}`);
  assert.equal(t.slides.length, 0);
  ws.receive('client-event', eventData(song()), `private-${CHANNEL}`);
  assert.equal(t.slides.length, 1);
  t.live.stop();
});

test('an onSlide that throws does not break the connection', async () => {
  const t = setup();
  const ws = await openedPresenter(t);
  (t.live as any).opts.onSlide = () => {
    throw new Error('boom');
  };
  ws.receive('client-event', eventData(song()), `private-${CHANNEL}`);
  ws.receive('pusher:ping', {});
  assert.deepEqual(ws.sent.at(-1), { event: 'pusher:pong', data: {} });
  t.live.stop();
});

test('a failing planning call says why in plain words and tries again', async () => {
  const t = setup();
  t.planning.failWith = 'The planning login has run out. Paste a new one in Settings.';
  t.live.start();
  await settle();
  assert.equal(t.sockets.length, 0);
  assert.deepEqual(t.statuses.at(-1), { state: 'closed', problem: 'The planning login has run out. Paste a new one in Settings.', presenter: null });
  t.planning.failWith = undefined;
  mock.timers.tick(1000);
  await settle();
  assert.equal(t.sockets.length, 1);
  t.live.stop();
});

test('a socket error without a close is logged, not thrown', async () => {
  const t = setup();
  t.live.start();
  await settle();
  t.sockets[0]!.onerror!({ message: 'x' });
  t.sockets[0]!.onopen!();
  assert.ok(t.logs.length > 0);
  t.live.stop();
});
