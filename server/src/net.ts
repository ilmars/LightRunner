// The API only answers devices on the local network.

import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  let a = address;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1') return true;
  if (isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return (
      x === 127 ||
      x === 10 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 169 && y === 254) ||
      (x === 100 && y >= 64 && y <= 127) // carrier-grade NAT, used by some venue routers
    );
  }
  const lower = a.toLowerCase();
  return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

/**
 * Is this connection from this computer: its loopback, or one of its own network addresses (a browser on the server
 * computer opened on the address the iPads use)?
 */
export function isThisComputer(address: string | undefined, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): boolean {
  if (!address) return false;
  let a = address.toLowerCase().replace(/%.*$/, '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a.startsWith('127.')) return true;
  return Object.values(interfaces).some((list) => (list ?? []).some((i) => i.address.toLowerCase().replace(/%.*$/, '') === a));
}
