import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIPv4, planRoutes, routeProblems, Settings, Show, parseShow, type OutputSettings } from '../src/index.ts';

const artnet = (host: string): OutputSettings => ({ kind: 'artnet', host });
const enttec = (port: string): OutputSettings => ({ kind: 'enttec', port });

test('old settings without routes still parse and keep their single output', () => {
  const s = Settings.parse({ output: { kind: 'artnet', host: '192.168.0.114' }, outputEnabled: true, frameRate: 40, gamma: 2.2 });
  assert.equal(s.routes, undefined);
  assert.deepEqual(s.output, artnet('192.168.0.114'));
  const rig = parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));
  assert.equal(rig.settings.routes, undefined);
});

test('routes parse, and bad ones are refused with a plain message', () => {
  const ok = Settings.parse({ output: artnet('192.168.0.114'), routes: [{ universe: 2, output: artnet('192.168.0.120') }] });
  assert.deepEqual(ok.routes, [{ universe: 2, output: artnet('192.168.0.120') }]);

  const twice = Settings.safeParse({ routes: [{ universe: 2, output: artnet('10.0.0.1') }, { universe: 2, output: artnet('10.0.0.2') }] });
  assert.equal(twice.success, false);
  assert.match(twice.error!.issues[0].message, /Universe 2 has its own output twice/);

  assert.equal(Settings.safeParse({ routes: [{ universe: -1, output: artnet('a') }] }).success, false);
});

test('route addresses must be IP addresses, so the node watch can recognise the node', () => {
  const ip = "Type the node's IP address, like 192.168.0.120, for universe 2.";
  assert.deepEqual(routeProblems(artnet('x'), [{ universe: 2, output: artnet(' ') }]), [ip]);
  assert.deepEqual(routeProblems(artnet('x'), [{ universe: 2, output: artnet('node-b.local') }]), [ip]);
  assert.deepEqual(routeProblems(artnet('x'), [{ universe: 2, output: artnet('192.168.0.300') }]), [ip]);
  assert.deepEqual(routeProblems(artnet('x'), [{ universe: 2, output: artnet(' 192.168.0.120 ') }]), []);
  const sacn = (host: string): OutputSettings => ({ kind: 'sacn', host, priority: 100 });
  assert.deepEqual(routeProblems(artnet('x'), [{ universe: 3, output: sacn('receiver') }]), ["Type the receiver's IP address, like 192.168.0.120, for universe 3."]);
  assert.deepEqual(routeProblems(artnet('x'), [{ universe: 3, output: sacn('') }]), []); // multicast
  assert.ok(isIPv4('2.255.255.255'));
  assert.ok(!isIPv4('localhost'));
  assert.ok(!isIPv4('1.2.3'));
});

test('two universes on the same ENTTEC port are refused', () => {
  const r = Settings.safeParse({ routes: [{ universe: 1, output: enttec('COM3') }, { universe: 2, output: enttec('COM3') }] });
  assert.equal(r.success, false);
  assert.match(r.error!.issues[0].message, /Universes 1 and 2 both go to the USB interface on COM3/);
  // Also when the default output is that interface.
  const p = routeProblems(enttec('/dev/tty.usbserial'), [{ universe: 2, output: enttec('/dev/tty.usbserial') }]);
  assert.match(p[0], /Universe 2 goes to the USB interface on \/dev\/tty.usbserial, which is already the default output/);
  // A route needs a port.
  assert.match(routeProblems(artnet('x'), [{ universe: 3, output: enttec('') }])[0], /Choose the USB port for universe 3/);
  // Different ports are fine.
  assert.deepEqual(routeProblems(enttec('COM3'), [{ universe: 2, output: enttec('COM4') }]), []);
});

test('a show whose settings break the route rules does not load', () => {
  const show = JSON.parse(readFileSync(new URL('../../../server/seed/demo-show.json', import.meta.url), 'utf8'));
  show.settings.routes = [{ universe: 1, output: enttec('COM3') }, { universe: 2, output: enttec('COM3') }];
  assert.equal(Show.safeParse(show).success, false);
});

test('without routes every universe goes to the default output', () => {
  const plan = planRoutes({ output: artnet('192.168.0.114') }, [1, 0]);
  assert.deepEqual(plan.destinations, [{ key: 'artnet 192.168.0.114', output: artnet('192.168.0.114'), universes: [0, 1] }]);
  assert.deepEqual(plan.unsent, []);
});

test('a route overrides the default for its universe only', () => {
  const plan = planRoutes(
    { output: artnet('192.168.0.114'), routes: [{ universe: 2, output: artnet('192.168.0.120') }] },
    [1, 2, 3],
  );
  assert.deepEqual(plan.destinations.map((d) => [d.key, d.universes]), [
    ['artnet 192.168.0.114', [1, 3]],
    ['artnet 192.168.0.120', [2]],
  ]);
});

test('universes routed to the same box share one output', () => {
  const plan = planRoutes(
    { output: { kind: 'none' }, routes: [{ universe: 4, output: artnet(' 10.0.0.9 ') }, { universe: 3, output: artnet('10.0.0.9') }] },
    [3, 4],
  );
  assert.deepEqual(plan.destinations.map((d) => [d.key, d.universes]), [['artnet 10.0.0.9', [3, 4]]]);
});

test('routes for universes the patch does not use open nothing', () => {
  const plan = planRoutes({ output: artnet('192.168.0.114'), routes: [{ universe: 9, output: artnet('192.168.0.120') }] }, [1]);
  assert.deepEqual(plan.destinations.map((d) => d.key), ['artnet 192.168.0.114']);
});

test('an empty patch still opens the default output, as before', () => {
  assert.deepEqual(planRoutes({ output: artnet('2.255.255.255') }, []).destinations.map((d) => [d.key, d.universes]), [['artnet 2.255.255.255', []]]);
});

test('"none" sends nothing for its universes, and output off sends nothing at all', () => {
  const plan = planRoutes({ output: artnet('192.168.0.114'), routes: [{ universe: 2, output: { kind: 'none' } }] }, [1, 2]);
  assert.deepEqual(plan.destinations.map((d) => [d.key, d.universes]), [['artnet 192.168.0.114', [1]]]);
  assert.deepEqual(planRoutes({ output: artnet('192.168.0.114'), outputEnabled: false }, [1]).destinations, []);
});

test('sACN outputs differ by receiver and priority', () => {
  const plan = planRoutes(
    { output: { kind: 'sacn', host: '', priority: 100 }, routes: [{ universe: 2, output: { kind: 'sacn', host: '', priority: 150 } }] },
    [1, 2],
  );
  assert.deepEqual(plan.destinations.map((d) => [d.key, d.universes]), [['sacn multicast 100', [1]], ['sacn multicast 150', [2]]]);
});

test('a USB interface gets exactly one universe; the default one takes the lowest, as before', () => {
  const plan = planRoutes({ output: enttec('COM3'), routes: [{ universe: 5, output: enttec('COM4') }] }, [2, 1, 5]);
  assert.deepEqual(plan.destinations.map((d) => [d.key, d.universes]), [['enttec COM3', [1]], ['enttec COM4', [5]]]);
  assert.deepEqual(plan.unsent, [{ universe: 2, reason: 'the USB interface on COM3 sends one universe (1)' }]);
});
