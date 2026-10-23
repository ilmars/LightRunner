// Windows only: is the network the iPads use set to Public? Windows' firewall then blocks them from Light Runner
// (it asks to allow an app on private networks only). Read-only: this never changes a network or firewall setting.

import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

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
 * What PowerShell is asked: the profiles as JSON, in UTF-8 (its own default is the system's code page, which would
 * spoil an adapter name such as "Bezvadu tīkls").
 */
export const PROFILE_COMMAND = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetConnectionProfile | Select-Object InterfaceAlias, @{n='NetworkCategory';e={[string]$_.NetworkCategory}} | ConvertTo-Json -Compress";

/**
 * Windows PowerShell by its full path in the Windows folder, never whatever "powershell.exe" the PATH finds first.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function powershellPath(env = process.env) {
  return win32.join(env.SystemRoot || env.windir || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Ask Windows for its network profiles (PowerShell's Get-NetConnectionProfile). An empty list when it can't say
 * (not Windows, PowerShell missing or slow).
 * @returns {Promise<Profile[]>}
 */
export function readProfiles() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', PROFILE_COMMAND], { timeout: 10_000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? [] : parseProfiles(stdout));
    });
  });
}
