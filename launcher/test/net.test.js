import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, pickAddress } from '../src/net.js';

// Shaped like os.networkInterfaces().
const v4 = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`, ...extra });
const v6 = (address) => ({ address, family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', cidr: `${address}/64`, scopeid: 0 });

test('only IPv4 addresses an iPad can reach are listed', () => {
  const list = lanAddresses({
    lo0: [v4('127.0.0.1', { internal: true }), v6('::1')],
    en0: [v6('fe80::1'), v4('192.168.0.195')],
    en5: [v4('169.254.12.7')],
    en7: [{ ...v4('192.168.5.2'), family: 4 }],
  });
  assert.deepEqual(list, [{ name: 'en0', address: '192.168.0.195' }, { name: 'en7', address: '192.168.5.2' }]);
});

test('a Windows computer with Wi-Fi, Ethernet, a VPN and WSL lists Ethernet and Wi-Fi first', () => {
  const list = lanAddresses({
    'vEthernet (WSL)': [v4('172.27.112.1')],
    'Tailscale': [v4('100.101.102.103')],
    'OpenVPN TAP-Windows6': [v4('10.8.0.6')],
    'Wi-Fi': [v4('192.168.1.23')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', { internal: true })],
    'Ethernet': [v4('192.168.0.40')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1')],
  });
  assert.deepEqual(list.map((a) => a.name), [
    'Wi-Fi', 'Ethernet', 'vEthernet (WSL)', 'Tailscale', 'OpenVPN TAP-Windows6', 'VirtualBox Host-Only Network',
  ]);
});

test('a Mac with a VPN, and a Raspberry Pi, list the real networks first', () => {
  assert.deepEqual(lanAddresses({
    utun3: [v4('10.20.0.5')],
    bridge100: [v4('192.168.64.1')],
    en1: [v4('192.168.1.10')],
    en0: [v4('192.168.0.195')],
  }).map((a) => a.name), ['en1', 'en0', 'utun3', 'bridge100']);
  assert.deepEqual(lanAddresses({
    docker0: [v4('172.17.0.1')],
    wlan0: [v4('192.168.0.77')],
    eth0: [v4('192.168.0.76')],
  }).map((a) => a.name), ['wlan0', 'eth0', 'docker0']);
});

test('a network with an unknown name comes after Ethernet and Wi-Fi but before a VPN', () => {
  assert.deepEqual(lanAddresses({
    'WireGuard Tunnel': [v4('10.66.0.2')],
    'Bezvadu tīkls': [v4('192.168.8.5')],
    'Ethernet 2': [v4('192.168.0.41')],
  }).map((a) => a.name), ['Ethernet 2', 'Bezvadu tīkls', 'WireGuard Tunnel']);
});

test('an interface with two addresses lists both', () => {
  assert.deepEqual(lanAddresses({ Ethernet: [v4('192.168.0.40'), v4('10.0.0.40')] }), [
    { name: 'Ethernet', address: '192.168.0.40' },
    { name: 'Ethernet', address: '10.0.0.40' },
  ]);
});

test('no network gives an empty list', () => {
  assert.deepEqual(lanAddresses({ lo: [v4('127.0.0.1', { internal: true })], none: undefined }), []);
  assert.deepEqual(lanAddresses({}), []);
});

test('with no argument it reads this computer’s networks', () => {
  const list = lanAddresses();
  assert.ok(Array.isArray(list));
  for (const a of list) assert.match(a.address, /^\d+\.\d+\.\d+\.\d+$/);
});

test('the saved address is used while it is still there, otherwise the first one', () => {
  const list = [{ name: 'Ethernet', address: '192.168.0.40' }, { name: 'Wi-Fi', address: '192.168.1.23' }, { name: 'Tailscale', address: '100.101.102.103' }];
  assert.deepEqual(pickAddress(list, '192.168.1.23'), { name: 'Wi-Fi', address: '192.168.1.23' });
  assert.deepEqual(pickAddress(list, '100.101.102.103'), { name: 'Tailscale', address: '100.101.102.103' });
  assert.deepEqual(pickAddress(list, '192.168.9.9'), { name: 'Ethernet', address: '192.168.0.40' });
  assert.deepEqual(pickAddress(list, null), { name: 'Ethernet', address: '192.168.0.40' });
  assert.equal(pickAddress([], '192.168.1.23'), null);
  assert.equal(pickAddress([], null), null);
});
