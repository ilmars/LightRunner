// A stand-in for the planning service, for tests and for checking the pages (LIGHT_RUNNER_FAKE_PLANNING=<file>).
// It never touches the network and keeps no cookie anywhere but in memory.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PlannedService } from '../../../packages/shared/src/index.ts';
import { PlanningError, type ServiceSummary } from './client.ts';
import type { Planning } from './index.ts';

const MAX_SERVICES = 8;

/** A planned service of one service type. */
export type FakeService = PlannedService & { type: string };

const FakeFile = z.object({
  accounts: z.array(z.object({ id: z.string(), name: z.string() })),
  types: z.array(z.object({ id: z.string(), name: z.string() })),
  services: z.array(PlannedService.extend({ type: z.string() })),
});

export class FakePlanning implements Planning {
  /** Set by tests (the methods `accounts` and `services` take those names). */
  accountList: { id: string; name: string }[] = [];
  types: { id: string; name: string }[] = [];
  plannedServices: FakeService[] = [];
  /** The pasted login, or null while none has been. */
  login: string | null = null;
  /** When set, every call throws a PlanningError with this message. */
  failWith?: string;
  /** Each call made, in order, with its account and type or service (never the cookie), so a test can tell what was asked. */
  readonly calls: string[] = [];

  /** Accounts, types and services from a JSON file: `{ accounts, types, services }`. */
  static fromFile(path: string): FakePlanning {
    const file = FakeFile.parse(JSON.parse(readFileSync(path, 'utf8')));
    const fake = new FakePlanning();
    fake.accountList = file.accounts;
    fake.types = file.types;
    fake.plannedServices = file.services;
    return fake;
  }

  loggedIn(): boolean {
    return this.login !== null;
  }

  async setLogin(cookie: string): Promise<void> {
    this.called('setLogin');
    if (!cookie.trim()) throw new PlanningError('Nothing was pasted.');
    this.login = cookie.trim();
  }

  async accounts(): Promise<{ id: string; name: string }[]> {
    this.called('accounts');
    return structuredClone(this.accountList);
  }

  async serviceTypes(account: string): Promise<{ id: string; name: string }[]> {
    this.called('serviceTypes', account);
    return structuredClone(this.types);
  }

  /** The coming services of the type, nearest first, then the most recent past one; at most 8 (as the real one). */
  async services(account: string, type: string, now: Date): Promise<ServiceSummary[]> {
    this.called('services', account, type);
    const all = this.plannedServices
      .filter((s) => s.type === type)
      .map((s) => ({ at: Date.parse(s.start), summary: summaryOf(s) }))
      .filter((s) => !Number.isNaN(s.at));
    const coming = all.filter((s) => s.at >= now.getTime()).sort((a, b) => a.at - b.at);
    const past = all.filter((s) => s.at < now.getTime()).sort((a, b) => b.at - a.at)[0];
    return (past ? [...coming.slice(0, MAX_SERVICES - 1), past] : coming.slice(0, MAX_SERVICES)).map((s) => s.summary);
  }

  async service(account: string, id: string): Promise<PlannedService> {
    this.called('service', account, id);
    const found = this.plannedServices.find((s) => s.id === id);
    if (!found) throw new PlanningError('That service was not found in the planning service.', 404);
    const { type: _type, ...planned } = structuredClone(found);
    return planned;
  }

  private called(name: string, ...args: string[]): void {
    this.calls.push([name, ...args].join(' '));
    if (this.failWith !== undefined) throw new PlanningError(this.failWith);
  }
}

function summaryOf(s: PlannedService): ServiceSummary {
  const songIds = [...new Set(s.items.flatMap((i) => (i.songId ? [i.songId] : [])))];
  return { id: s.id, start: s.start, items: s.items.length, songs: s.items.filter((i) => i.kind === 'song').length, songIds };
}
