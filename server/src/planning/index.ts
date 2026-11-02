// What the App needs from the online planning service. The real one is the PlanningClient; tests (and
// LIGHT_RUNNER_FAKE_PLANNING, for checking the pages) use FakePlanning. Nothing here reaches the network until
// a method is called, so with Planning off the server makes no connection.

import { join } from 'node:path';
import type { PlannedService } from '../../../packages/shared/src/index.ts';
import { PlanningClient, type ServiceSummary } from './client.ts';

export { PlanningError, type ServiceSummary } from './client.ts';

export interface Planning {
  /** Whether a login is kept (it may still have run out: the next call says so). */
  loggedIn(): boolean;
  /** Keeps a pasted login cookie once the planning service has accepted it. Never logs or returns the cookie. */
  setLogin(cookie: string): Promise<void>;
  accounts(): Promise<{ id: string; name: string }[]>;
  serviceTypes(account: string): Promise<{ id: string; name: string }[]>;
  services(account: string, type: string, now: Date): Promise<ServiceSummary[]>;
  service(account: string, id: string): Promise<PlannedService>;
}

/** The real thing: the login is kept in `<dataDir>/planning-login.json`, owner-only. */
export function createPlanning(dataDir: string, log: (line: string) => void): Planning {
  return new PlanningClient({ loginFile: join(dataDir, 'planning-login.json'), log });
}
