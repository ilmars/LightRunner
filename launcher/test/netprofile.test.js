import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { categoryOf, parseProfiles, powershellPath, PROFILE_COMMAND } from '../src/netprofile.js';

// Windows' network profiles (Get-NetConnectionProfile): is the iPads' network set to Public?

test('one profile or several, with the category as a word or a number', () => {
  assert.deepEqual(parseProfiles('{"InterfaceAlias":"Wi-Fi","InterfaceIndex":15,"NetworkCategory":"Public"}'), [{ name: 'Wi-Fi', category: 'public' }]);
  assert.deepEqual(parseProfiles('[{"InterfaceAlias":"Wi-Fi","NetworkCategory":0},{"InterfaceAlias":"Ethernet","NetworkCategory":1},{"InterfaceAlias":"Ethernet 2","NetworkCategory":2}]'), [
    { name: 'Wi-Fi', category: 'public' },
    { name: 'Ethernet', category: 'private' },
    { name: 'Ethernet 2', category: 'domain' },
  ]);
  assert.deepEqual(parseProfiles('[{"InterfaceAlias":"Wi-Fi","NetworkCategory":"DomainAuthenticated"},{"InterfaceAlias":"LAN","NetworkCategory":"Private"}]'), [
    { name: 'Wi-Fi', category: 'domain' },
    { name: 'LAN', category: 'private' },
  ]);
});

test('nothing usable gives no profiles', () => {
  for (const text of ['', '   ', 'not json', 'null', '42', '{"NetworkCategory":"Public"}', '[{"InterfaceAlias":"Wi-Fi","NetworkCategory":"Unknown"}]', '\uFEFF']) {
    assert.deepEqual(parseProfiles(text), [], JSON.stringify(text));
  }
  // A byte order mark in front is read past.
  assert.deepEqual(parseProfiles('\uFEFF{"InterfaceAlias":"Wi-Fi","NetworkCategory":"Private"}'), [{ name: 'Wi-Fi', category: 'private' }]);
});

test('the category of the network an address is on, by its interface name', () => {
  const profiles = [{ name: 'Wi-Fi', category: 'public' }, { name: 'Ethernet', category: 'private' }];
  assert.equal(categoryOf(profiles, 'Wi-Fi'), 'public');
  assert.equal(categoryOf(profiles, 'wi-fi'), 'public', 'Windows names ignore case');
  assert.equal(categoryOf(profiles, 'Ethernet'), 'private');
  assert.equal(categoryOf(profiles, 'vEthernet (WSL)'), null);
  assert.equal(categoryOf(profiles, null), null);
  assert.equal(categoryOf([], 'Wi-Fi'), null);
});

test('an adapter name that is not plain ASCII (Latvian Windows) is read and matched', () => {
  const profiles = parseProfiles('[{"InterfaceAlias":"Bezvadu tīkls","NetworkCategory":"Public"},{"InterfaceAlias":"Ethernet 2","NetworkCategory":"Private"}]');
  assert.deepEqual(profiles, [{ name: 'Bezvadu tīkls', category: 'public' }, { name: 'Ethernet 2', category: 'private' }]);
  assert.equal(categoryOf(profiles, 'Bezvadu tīkls'), 'public');
  assert.equal(categoryOf(profiles, 'BEZVADU TĪKLS'), 'public');
  // PowerShell is asked to answer in UTF-8, so such a name arrives whole.
  assert.match(PROFILE_COMMAND, /^\[Console\]::OutputEncoding\s*=\s*\[Text\.Encoding\]::UTF8;/);
});

test('PowerShell is run by its full path in the Windows folder', () => {
  const ps = (/** @type {string} */ root) => win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  assert.equal(powershellPath({ SystemRoot: win32.join('D:/', 'WINDOWS') }), ps(win32.join('D:/', 'WINDOWS')));
  assert.equal(powershellPath({ windir: win32.join('C:/', 'Windows') }), ps(win32.join('C:/', 'Windows')));
  assert.equal(powershellPath({}), ps(win32.join('C:/', 'Windows')));
});
