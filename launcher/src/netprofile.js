// Windows only: is the network the iPads use set to Public? Windows' firewall then blocks them from Light Runner
// (it asks to allow an app on private networks only). Read-only: this never changes a network or firewall setting.

import { execFile } from 'node:child_process';

/** @typedef {'public' | 'private' | 'domain'} Category */
/** @typedef {{ name: string, category: Category }} Profile */

/** Get-NetConnectionProfile's NetworkCategory, as a word (PowerShell's enum name) or its number. */
const CATEGORIES = /** @type {Record<string, Category>} */ ({
  public: 'public', 0: 'public',
  private: 'private', 1: 'private',
  domainauthenticated: 'domain', 2: 'domain',
});

/**
 * The profiles in Get-NetConnectionProfile's JSON (one object, or a list): each network adapter's name
 * (InterfaceAlias, the name Node gives the interface too) and its category. Anything else is left out.
 * @param {string} text
 * @returns {Profile[]}
 */
export function parseProfiles(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  /** @type {Profile[]} */
  const profiles = [];
  for (const p of list) {
    if (!p || typeof p !== 'object' || typeof p.InterfaceAlias !== 'string' || !p.InterfaceAlias) continue;
    const category = CATEGORIES[String(p.NetworkCategory).toLowerCase()];
    if (category) profiles.push({ name: p.InterfaceAlias, category });
  }
  return profiles;
}

/**
 * The category of the network on this interface, or null when Windows gives none for it.
 * @param {Profile[]} profiles
 * @param {string | null | undefined} interfaceName
 * @returns {Category | null}
 */
export function categoryOf(profiles, interfaceName) {
  if (!interfaceName) return null;
  const name = interfaceName.toLowerCase();
  return profiles.find((p) => p.name.toLowerCase() === name)?.category ?? null;
}

/**
 * Ask Windows for its network profiles (PowerShell's Get-NetConnectionProfile). An empty list when it can't say
 * (not Windows, PowerShell missing or slow).
 * @returns {Promise<Profile[]>}
 */
export function readProfiles() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const command = 'Get-NetConnectionProfile | Select-Object InterfaceAlias, @{n=\'NetworkCategory\';e={[string]$_.NetworkCategory}} | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? [] : parseProfiles(stdout));
    });
  });
}
