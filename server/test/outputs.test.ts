import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { planRoutes, type OutputSettings, type OutputStatus } from '../../packages/shared/src/index.ts';
import { OutputSet, type DmxOutput } from '../src/output/index.ts';
import { ArtNetOutput } from '../src/output/artnet.ts';
import { EnttecOutput } from '../src/output/enttec.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const artnet = (host: string): OutputSettings => ({ kind: 'artnet', host });

class FakeOutput implements DmxOutput {
  status: OutputStatus = 'ok';
  closed = false;
  sent: number[][] = [];
  readonly settings: OutputSettings;
  constructor(settings: OutputSettings) {
    this.settings = settings;
  }
  send(universes: Map<number, Uint8Array>): void {
    this.sent.push([...universes.keys()]);
  }
  close(): void {
    this.closed = true;
  }
}

function fakeSet() {
  const made: FakeOutput[] = [];
  const set = new OutputSet((o) => {
    const f = new FakeOutput(o);
    made.push(f);
    return f;
  });
  return { set, made };
}

const frame = (...universes: number[]) => new Map(universes.map((u) => [u, new Uint8Array(512)]));

test('one output per box, each sent only its own universes', () => {
  const { set, made } = fakeSet();
  set.update(planRoutes({ output: artnet('10.0.0.1'), routes: [{ universe: 2, output: artnet('10.0.0.2') }] }, [1, 2, 3]).destinations);
  assert.equal(made.length, 2);
  set.send(frame(1, 2, 3));
  assert.deepEqual(made.map((m) => [m.settings, m.sent]), [
    [artnet('10.0.0.1'), [[1, 3]]],
    [artnet('10.0.0.2'), [[2]]],
  ]);
});

test('changing the routes opens and closes only the outputs that changed', () => {
  const { set, made } = fakeSet();
  const plan = (routes: { universe: number; output: OutputSettings }[]) =>
    planRoutes({ output: artnet('10.0.0.1'), routes }, [1, 2, 3]).destinations;
  set.update(plan([{ universe: 2, output: artnet('10.0.0.2') }]));
  const [main, second] = made;
  // Universe 3 moves to the second node: nothing reopens.
  set.update(plan([{ universe: 2, output: artnet('10.0.0.2') }, { universe: 3, output: artnet('10.0.0.2') }]));
  assert.equal(made.length, 2);
  set.send(frame(1, 2, 3));
  assert.deepEqual(main.sent.at(-1), [1]);
  assert.deepEqual(second.sent.at(-1), [2, 3]);
  // Universe 2 goes to a third node instead: the second closes, the main one keeps running.
  set.update(plan([{ universe: 2, output: artnet('10.0.0.3') }]));
  assert.equal(second.closed, true);
  assert.equal(main.closed, false);
  assert.equal(made.length, 3);
  set.close();
  assert.ok(made.every((m) => m.closed));
});

test('status: off with nothing to send, lost when any output is lost, and a lost box is named when there are several', () => {
  const { set, made } = fakeSet();
  assert.equal(set.status, 'off');
  set.update(planRoutes({ output: artnet('10.0.0.1') }, [1]).destinations);
  made[0].status = 'lost';
  assert.equal(set.status, 'lost');
  // One output: the operator page keeps its usual text.
  assert.equal(set.problem, null);

  set.update(planRoutes({ output: artnet('10.0.0.1'), routes: [{ universe: 2, output: { kind: 'enttec', port: 'COM3' } }] }, [1, 2]).destinations);
  assert.equal(set.status, 'lost');
  assert.equal(set.problem, "Can't send to Art-Net node 10.0.0.1");
  made[1].status = 'lost';
  assert.equal(set.problem, "Can't send to Art-Net node 10.0.0.1. The USB interface on COM3 is not connected");
  made[0].status = 'ok';
  made[1].status = 'ok';
  assert.equal(set.status, 'ok');
  assert.equal(set.problem, null);
});

test('a USB port that finishes opening after its output closed is closed again', async () => {
  let finish!: () => void;
  const port = { isOpen: true, closed: false, write: () => true, on: () => {}, close() { this.closed = true; this.isOpen = false; } };
  const out = new EnttecOutput('COM3', () => new Promise((resolve) => (finish = () => resolve(port))));
  out.close(); // routes changed while the port was still opening
  finish();
  await sleep(10);
  assert.equal(port.closed, true);
  assert.equal(out.status, 'lost');
});

async function receiver(): Promise<{ socket: Socket; port: number; packets: Buffer[] }> {
  const socket = createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  const packets: Buffer[] = [];
  socket.on('message', (m) => packets.push(m));
  return { socket, port: socket.address().port, packets };
}

test('two universes go to two Art-Net nodes', async () => {
  const a = await receiver();
  const b = await receiver();
  // Two "nodes" on this machine: the same address, told apart by port.
  const ports: Record<string, number> = { 'node-a': a.port, 'node-b': b.port };
  const set = new OutputSet((o) => new ArtNetOutput('127.0.0.1', o.kind === 'artnet' ? ports[o.host] : 0));
  try {
    set.update(planRoutes({ output: artnet('node-a'), routes: [{ universe: 2, output: artnet('node-b') }] }, [1, 2]).destinations);
    await sleep(50);
    set.send(new Map([[1, new Uint8Array(512).fill(11)], [2, new Uint8Array(512).fill(22)]]));
    await sleep(100);
    const universes = (p: Buffer[]) => p.map((m) => m[14] | (m[15] << 8));
    assert.deepEqual(universes(a.packets), [1]);
    assert.deepEqual(universes(b.packets), [2]);
    assert.equal(a.packets[0][18], 11);
    assert.equal(b.packets[0][18], 22);
  } finally {
    set.close();
    a.socket.close();
    b.socket.close();
  }
});
