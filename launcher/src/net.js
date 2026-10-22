// The addresses the iPads can use to reach this computer, best first, and which one to show.

import { networkInterfaces } from 'node:os';

/** @typedef {{ name: string, address: string }} LanAddress */

// Ethernet and Wi-Fi by the names Mac (en0), Windows (Ethernet, Wi-Fi, WLAN) and Linux (eth0, wlan0, enp3s0, wlp2s0, end0) give them.
const REAL = /^(en\d|eth|wlan|wl|enp|ens|eno|end\d|ethernet|wi-?fi|wlan|wireless)/i;
// VPNs, virtual machines, containers and the Mac's own sharing: an iPad is rarely on these.
const VIRTUAL = /(vethernet|virtual|vmware|vbox|hyper-v|docker|^br-|^bridge|^veth|utun|^tun|^tap|tap-|^ppp|^wg|wireguard|tailscale|zerotier|vpn|hamachi|^awdl|^llw|^anpi|loopback|npcap)/i;

/** @param {string} name */
function rank(name) {
  if (VIRTUAL.test(name)) return 2;
  if (REAL.test(name)) return 0;
  return 1;
}

/**
 * This computer's IPv4 addresses on a network (not the computer's own 127.x, not a self-assigned 169.254.x),
 * Ethernet and Wi-Fi first, then other networks, then VPNs and virtual ones; otherwise in the system's order.
 * @param {ReturnType<typeof networkInterfaces>} [interfaces]
 * @returns {LanAddress[]}
 */
export function lanAddresses(interfaces = networkInterfaces()) {
  /** @type {(LanAddress & { rank: number })[]} */
  const found = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list ?? []) {
      // Node 18.0 gave the family as a number.
      const ipv4 = a.family === 'IPv4' || /** @type {unknown} */ (a.family) === 4;
      if (!ipv4 || a.internal || a.address.startsWith('169.254.') || a.address.startsWith('127.')) continue;
      found.push({ name, address: a.address, rank: rank(name) });
    }
  }
  // Array sort is stable, so the system's order is kept within a rank.
  return found.sort((x, y) => x.rank - y.rank).map(({ name, address }) => ({ name, address }));
}

/**
 * The address to show: the one chosen before while this computer still has it, otherwise the first.
 * @param {LanAddress[]} list
 * @param {string | null | undefined} saved
 * @returns {LanAddress | null}
 */
export function pickAddress(list, saved) {
  return list.find((a) => a.address === saved) ?? list[0] ?? null;
}
