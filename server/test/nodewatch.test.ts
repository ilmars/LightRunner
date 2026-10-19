import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeWatch, type NodeHealth } from '../src/nodewatch.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A watch whose polls are answered by `answers` instead of the network. */
function fakeWatch(answers: Record<string, Partial<NodeHealth>>) {
  const problems: (string | null)[] = [];
  const polled: string[][] = [];
  const watch = new NodeWatch((p) => problems.push(p), 5, async (hosts) => {
    polled.push(hosts);
    return new Map(hosts.map((h) => [h, { seen: false, merging: false, name: null, ...answers[h] }]));
  });
  return { watch, problems, polled };
}

test('one node: not answering after three missed polls, as before', async () => {
  const answers: Record<string, Partial<NodeHealth>> = {};
  const { watch, problems } = fakeWatch(answers);
  watch.watch('192.168.0.114');
  await sleep(60);
  assert.equal(problems.at(-1), 'Art-Net node 192.168.0.114 is not answering');
  answers['192.168.0.114'] = { seen: true, name: 'NetWork Node 2' };
  await sleep(30);
  assert.equal(problems.at(-1), null);
  watch.stop();
});

test('broadcast addresses and other outputs are not watched', async () => {
  const { watch, polled } = fakeWatch({});
  watch.watch(['2.255.255.255', '255.255.255.255', '192.168.0.255']);
  watch.watch(null);
  await sleep(30);
  assert.deepEqual(polled, []);
  watch.stop();
});

test('two nodes are watched together, and a problem names the node', async () => {
  const answers: Record<string, Partial<NodeHealth>> = { '192.168.0.114': { seen: true, name: 'NetWork Node 2' } };
  const { watch, problems, polled } = fakeWatch(answers);
  watch.watch(['192.168.0.114', '192.168.0.120']);
  await sleep(60);
  assert.deepEqual(polled[0], ['192.168.0.114', '192.168.0.120']);
  assert.equal(problems.at(-1), 'Art-Net node 192.168.0.120 is not answering');

  // Both have problems: one message.
  answers['192.168.0.114'] = { seen: true, merging: true, name: 'NetWork Node 2' };
  await sleep(30);
  assert.equal(problems.at(-1), 'Another desk is also sending to NetWork Node 2. Art-Net node 192.168.0.120 is not answering');

  // The silent node is no longer used: its problem goes with it.
  answers['192.168.0.114'] = { seen: true, name: 'NetWork Node 2' };
  watch.watch(['192.168.0.114']);
  await sleep(30);
  assert.equal(problems.at(-1), null);
  watch.stop();
});

test('adding a second node keeps what is known about the first', async () => {
  const answers: Record<string, Partial<NodeHealth>> = {};
  const { watch, problems } = fakeWatch(answers);
  watch.watch(['192.168.0.114']);
  await sleep(60);
  assert.equal(problems.at(-1), 'Art-Net node 192.168.0.114 is not answering');
  const before = problems.length;
  answers['192.168.0.120'] = { seen: true };
  watch.watch(['192.168.0.114', '192.168.0.120']);
  await sleep(30);
  // No flicker back to "fine" when a node is added.
  assert.ok(problems.slice(before).every((p) => p === 'Art-Net node 192.168.0.114 is not answering'));
  watch.stop();
});
