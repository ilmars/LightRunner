// Which output each universe goes to. The show's `settings.output` is the
// default for every universe; `settings.routes` gives single universes their
// own output (universe 2 to a second Art-Net node, or to a USB interface).
//
// Universe numbers are the same everywhere: the number a fixture has in Patch
// is the Art-Net port-address sent in ArtDmx (net, sub-net and universe in one
// 15-bit number, as "Find nodes" lists it) and the sACN universe number
// (sACN has no universe 0, so 0 goes out as 1). A route never renumbers.

import type { OutputRoute, OutputSettings } from './schema.ts';

/** One box (or socket) DMX is sent to, with the universes it gets. */
export interface Destination {
  /** Same key = same output: universes routed to the same box share one socket or USB port. */
  key: string;
  output: OutputSettings;
  universes: number[];
}

export interface RoutePlan {
  destinations: Destination[];
  /** Universes in the patch that no output sends, with the reason (USB interfaces send one universe). */
  unsent: { universe: number; reason: string }[];
}

/** What identifies an output; null for "none" (send nothing). */
export function destinationKey(o: OutputSettings): string | null {
  switch (o.kind) {
    case 'artnet': return `artnet ${o.host.trim()}`;
    case 'sacn': return `sacn ${o.host.trim() || 'multicast'} ${o.priority}`;
    case 'enttec': return `enttec ${o.port}`;
    case 'none': return null;
  }
}

const tidy = (o: OutputSettings): OutputSettings =>
  o.kind === 'artnet' || o.kind === 'sacn' ? { ...o, host: o.host.trim() } : o;

/**
 * Turn the output settings and the universes the patch uses into the outputs
 * to open. Routes for universes nothing is patched on open nothing. With no
 * universes at all the default output still opens, as it always did.
 */
export function planRoutes(
  settings: { output: OutputSettings; routes?: OutputRoute[]; outputEnabled?: boolean },
  universesInUse: Iterable<number>,
): RoutePlan {
  const plan: RoutePlan = { destinations: [], unsent: [] };
  if (settings.outputEnabled === false) return plan;
  const universes = [...new Set(universesInUse)].sort((a, b) => a - b);
  const routes = new Map((settings.routes ?? []).map((r) => [r.universe, r.output]));
  const byKey = new Map<string, Destination>();
  const add = (output: OutputSettings, universe: number | null) => {
    const key = destinationKey(output);
    if (key === null) return;
    let d = byKey.get(key);
    if (!d) byKey.set(key, (d = { key, output: tidy(output), universes: [] }));
    if (universe !== null) d.universes.push(universe);
  };
  for (const u of universes) add(routes.get(u) ?? settings.output, u);
  if (!universes.length) add(settings.output, null);

  for (const d of byKey.values()) {
    // A DMX USB Pro has one output: it sends the lowest universe it is given.
    if (d.output.kind === 'enttec' && d.universes.length > 1) {
      const [first, ...rest] = d.universes;
      for (const universe of rest) plan.unsent.push({ universe, reason: `the USB interface on ${d.output.port} sends one universe (${first})` });
      d.universes = [first];
    }
    plan.destinations.push(d);
  }
  plan.destinations.sort((a, b) => (a.universes[0] ?? -1) - (b.universes[0] ?? -1));
  return plan;
}

/** A dotted IPv4 address such as 192.168.0.114 (spaces around it are ignored). */
export function isIPv4(text: string): boolean {
  const parts = text.trim().split('.');
  return parts.length === 4 && parts.every((p) => /^[0-9]{1,3}$/.test(p) && Number(p) <= 255);
}

/** Plain-language problem with the default output's address, or null. Older shows may still hold a name; only new edits are checked. */
export function outputAddressProblem(o: OutputSettings): string | null {
  if (o.kind === 'artnet' && !isIPv4(o.host)) return "Type the node's IP address, like 192.168.0.114.";
  if (o.kind === 'sacn' && o.host.trim() && !isIPv4(o.host)) return "Type the receiver's IP address, like 192.168.0.114.";
  return null;
}

/** Plain-language problems with a set of routes; empty when they are fine. */
export function routeProblems(output: OutputSettings, routes: OutputRoute[] | undefined): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  const usbPorts = new Map<string, number>();
  for (const r of routes ?? []) {
    if (seen.has(r.universe)) problems.push(`Universe ${r.universe} has its own output twice. Keep one.`);
    seen.add(r.universe);
    // Addresses must be IP addresses: the node watch recognises replies by address,
    // and a name would be looked up on every packet.
    if (r.output.kind === 'artnet' && !isIPv4(r.output.host)) problems.push(`Type the node's IP address, like 192.168.0.120, for universe ${r.universe}.`);
    if (r.output.kind === 'sacn' && r.output.host.trim() && !isIPv4(r.output.host)) problems.push(`Type the receiver's IP address, like 192.168.0.120, for universe ${r.universe}.`);
    if (r.output.kind !== 'enttec') continue;
    const port = r.output.port.trim();
    if (!port) {
      problems.push(`Choose the USB port for universe ${r.universe}.`);
      continue;
    }
    const other = usbPorts.get(port);
    if (other !== undefined && other !== r.universe) {
      problems.push(`Universes ${other} and ${r.universe} both go to the USB interface on ${port}, but a USB interface sends one universe. Choose another port for universe ${r.universe}.`);
    } else if (output.kind === 'enttec' && output.port.trim() === port) {
      problems.push(`Universe ${r.universe} goes to the USB interface on ${port}, which is already the default output, and a USB interface sends one universe. Choose another port, or use the default.`);
    }
    usbPorts.set(port, r.universe);
  }
  return problems;
}
