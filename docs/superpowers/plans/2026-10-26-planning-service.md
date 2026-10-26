# Planning service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load a service from the church's planning service into the running order, each song keeping its look.

> **Scope change, 26 Oct (the owner):** following the presentation app is for later ("Presenter we will deal later"). This build covers the spec's goals 1, 2 and 4 (Load service, remembered looks, optional) and the rows, saving and "another look" parts of the running order. **Tasks 1, 5, 7 and 12 are deferred** and not dispatched; Tasks 8, 9, 13 and 14 below are already cut down to match. The spec's "Following the presentation app" section stays as the design for that later work.

**Architecture:** Pure rules (item kinds, loading, the rows the page shows) live in `packages/shared/src/planning.ts` with unit tests. The I/O (planning-service HTTP with the pasted login) lives in `server/src/planning/`, behind one `Planning` interface that the App gets through `AppOptions` and that tests replace with `FakePlanning`. Every action is a `Command` through `App.command()`; the engine is untouched.

**Tech Stack:** Node 24 (type stripping, global `fetch` and `WebSocket`), zod, node:test, plain HTML/JS pages with `web/shared/theme.css`.

**Spec:** [docs/superpowers/specs/2026-10-25-planning-service-design.md](../specs/2026-10-25-planning-service-design.md). Read it first; this plan argues from it.

## Global Constraints

- Work in the worktree `.claude/worktrees/planning-service` on branch `planning-service`; run `npm install` there once before Task 2.
- `npm test`, `npm run typecheck` and `npm run jump-check` pass before every commit (CLAUDE.md).
- TypeScript with erasable syntax only, `.ts` import extensions, `import type` for types. The engine (`packages/engine`) is not touched.
- Every input is a `Command` through `App.command()`; the server is the single source of truth.
- **Docs, specs, STATUS, DECISIONS, commit messages never name the platform** ("the planning service", "the presentation app"). Code, code comments, the Settings page and the operator page may (the page says "Presenter").
- **Basic lights is protected:** a load never replaces, renames, moves or removes it; it stays first.
- **The login is never in the show** (export strips nothing for it because it isn't there): it lives in `<dataDir>/planning-login.json`, written with `writeAtomic(…, { mode: 0o600 })`, never sent to a page, never logged, never printed.
- No new dependencies.
- UI: plain words, sentence case, design-system tokens and `ds-` classes, quiet controls, 44 px targets, iPad 1080 × 810; nothing new on the phone (Load service is hidden there).
- Commits: small, descriptive, in the repo's style ("Planning: …"), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The login runs out on a Sunday morning** → the lights and the running order are untouched, Load service says "The planning login has run out. Paste a new one in Settings." (Task 8 test `a login that runs out never touches the lights or the running order`).
2. **Load is tapped while a song is on stage or during Blackout** → the stage keeps what it shows (a load changes the running order, never the lights); the song on stage, if it is in the service, keeps its look (Task 8 test `loading never changes the lights`).
3. **The plan changes after a load and is loaded again** (a song removed, two swapped) → remembered looks come back, Basic lights first, one Undo returns the previous order (Task 3 test `loading again keeps remembered looks and Undo-able order`, Task 8 test `load is one Undo step`).
4. **A service with nothing planned yet, or with only verses and headers** → refused or loaded without breaking the running order: an empty service is refused ("Nothing is planned in this service yet."); a service with no songs leaves Basic lights alone in the order with its muted rows (Task 3 test `a service with no songs leaves Basic lights alone in the order`).
5. **A show exported or imported** carries the loaded service and the remembered looks but never the login (Task 8 test `the login never reaches the show or an export`).

---

### Task 1: Capture what the presentation app sends (owner, with the app open) — DEFERRED (scope change)

Not code; no agent can do this. The owner opens Presenter on a test service on any computer, then in the main checkout (which has the saved login):

- [ ] **Step 1:** the 21 Oct live-following script in `tools/` with `--json`, its output saved to `live-sample.jsonl`, then in Presenter click: a header's first blank, a song, two slides of it, a Bible verse, a picture, Clear; stop with Ctrl+C.
- [ ] **Step 2:** Remove anything secret (there shouldn't be any: messages carry names and slide text) and save it as `server/test/fixtures/planning-live.jsonl` in the worktree. Note in the commit which field identifies the live item (`current_cue.cue_id`, `.id`, a song id, or only `.name`).
- [ ] **Step 3:** Commit: `git add server/test/fixtures/planning-live.jsonl && git commit -m "Planning: a sample of the presentation app's live messages"`

Tasks 2–13 don't wait for this; Task 5's matcher is written to take whichever field exists, and Task 14 adds a test on this fixture.

---

### Task 2: Item kinds and the planned service

**Files:**
- Create: `packages/shared/src/planning.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `packages/shared/test/planning.test.ts`

**Interfaces:**
- Produces:
  - `ItemKind = 'song' | 'header' | 'verse' | 'slides' | 'media' | 'blank' | 'other'` (zod `ItemKind`)
  - `ServiceItem` (zod): `{ key: string(1..64), kind: ItemKind, name: string(0..200), songId?: string(1..64), tempo?: number(40..240), look?: id }`
  - `PlannedService` (zod): `{ id: string(1..64), title: string(0..200), start: string(0..32), items: ServiceItem[] (max 500) }` (`title` is the service type's name, `start` the first start time as the planning service writes it, e.g. `2026-10-25T08:00:00`)
  - `itemKind(cue: unknown): ItemKind`
  - `toPlannedService(id: string, doc: unknown, songs: Map<string, unknown>, typeName: string): PlannedService` — `doc` is the service document already turned into plain JSON (the `fromFirestore` result), `songs` the song documents by id.
  - `rememberKey(item: ServiceItem): string | null` — `song:<songId>`, `header:<name>`, `item:<name>` for slides, media and other; `null` for verse and blank.

- [ ] **Step 1: Write the failing tests** (cue objects in the planning service's shape, as found on 21 Oct):

```ts
test('item kinds are told apart as the planning service stores them', () => {
  assert.equal(itemKind({ cue_type: 'g', cue_name: 'Vārds' }), 'header');
  assert.equal(itemKind({ cue_type: null, cue_foreground: { type: 'text', text: '76660120-d242-4862-b351-11728b463fd3' } }), 'song');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'bible', data: {} }, cue_background: { type: 'media' } }), 'verse');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'slides', presentation: {} } }), 'slides');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: '' }, cue_background: { type: 'media' } }), 'media');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: '' }, cue_background: { type: '' }, displayName: '[blank]' }), 'blank');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'text', text: '' }, displayName: '[blank]' }), 'blank');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'countdown' } }), 'other');
});
test('a planned service keeps the order, names, song ids, the service key and the song tempo', () => { /* doc with data.cues [header Ievads, song with songMeta key, verse]; songs map gives data.tempo 141 */
  // assert items[1] deepEqual { key: '<cue_id>', kind: 'song', name: 'Klints uz mūžiem (Nav tādas klints)', songId: '4eb2…', tempo: 141 }
  // assert title 'Rīga - Svētdienas Dievkalpojums', start '2026-10-25T08:00:00'
});
test('a song tempo outside 40-240 is left out', () => { /* tempo 300 -> no tempo */ });
test('remember keys: songs by id, headers and slides by name, verses and blanks never', () => {
  assert.equal(rememberKey({ key: 'a', kind: 'song', name: 'X', songId: 's1' }), 'song:s1');
  assert.equal(rememberKey({ key: 'b', kind: 'header', name: 'Vārds' }), 'header:Vārds');
  assert.equal(rememberKey({ key: 'c', kind: 'slides', name: 'Draudzes Nedēļas Aktivitātes' }), 'item:Draudzes Nedēļas Aktivitātes');
  assert.equal(rememberKey({ key: 'd', kind: 'verse', name: 'Psalmi 23:3 L1' }), null);
  assert.equal(rememberKey({ key: 'e', kind: 'blank', name: '[blank]' }), null);
});
```

- [ ] **Step 2:** `node --test packages/shared/test/planning.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement in `planning.ts`. Rules for `itemKind`, in order: `cue_type === 'g'` → header; foreground `bible` → verse; foreground `slides` → slides; foreground `text` with a UUID text → song; foreground `text` with empty text, or no foreground type and no background type → blank; no foreground type with background `media` → media; else other. A song's name is `displayName || cue_name || song.name`; a header's `cue_name || displayName`. Names are trimmed and cut to 200.
- [ ] **Step 4:** Run the test → PASS; `npm run typecheck` → clean.
- [ ] **Step 5:** Commit `git commit -m "Planning: item kinds and the planned service"`.

---

### Task 3: Load a service into the show

**Files:**
- Modify: `packages/shared/src/schema.ts` (`OperatorLayout`, `Settings`), `packages/shared/src/planning.ts`, `packages/shared/src/runningorder.ts` (`deleteItem` forgets), `server/src/app.ts` (`ensureShow` chain gets `ensurePlanning`)
- Test: `packages/shared/test/planning.test.ts`

**Interfaces:**
- Consumes: Task 2 types.
- Produces:
  - `OperatorLayout.service: PlannedService.optional()` and `OperatorLayout.remembered: z.record(z.string().max(300), id).optional()` (key from `rememberKey` → look id). Both absent in older shows.
  - `PlanningSettings` (zod) on `Settings.planning` (optional): `{ enabled: boolean default false, account?: string(1..64), serviceType?: string(1..64), newSongLook?: id }`.
  - `loadService(show: Show, service: PlannedService): Show`
  - `ensurePlanning(show: Show): Show` — drops `remembered` entries and `service` item `look`s whose look no longer exists, and `newSongLook` if it is gone.
  - `newSongLookOf(show: Show): string | undefined` — `settings.planning.newSongLook` if it exists, else the first quick look on the first tab that has one (tab order `plain`, `colours`, `effects`), else undefined.

`loadService` rules (from the spec):
1. Basic lights (`operator.safeLook`) stays first and untouched.
2. Every other running-order look that isn't remembered, a quick look or Basic lights is removed from `show.looks` (as `deleteItem` would); remembered and quick looks stay (hidden when not in the order).
3. For each item in order: remembered look (by `rememberKey`) → reuse it, set its name to the item's name; a song with none → a **copy** of `newSongLookOf(show)` (new id via `uniqueId`, the item's name, the item's tempo if any) remembered at once (an empty look with no groups if there is no quick look); header, slides, media, other with none → no look; verse, blank → no look.
4. `runningOrder` = Basic lights, then each item's look in service order, **each look once**: a song planned twice gets its look once in the order (the second item still has `look` set; the page shows it as a repeat, Task 4).
5. `operator.service` = the service with each item's `look` filled in.

- [ ] **Step 1: Write the failing tests:**
  - `loading puts Basic lights first, then the service's looks in order` — on `shows/stage-l1.json`, a service [header Ievads, song A, verse, header Vārds, blank, song B]; assert `runningOrder` is `[safe, lookA, lookB]`, `service.items[0].look` undefined, `remembered['song:A']` is lookA.
  - `a new song gets a copy of the first quick look, named and with the song's tempo` — look's `groups` deepEqual the quick look's, different id, `name` the song's, `tempo` 141.
  - `a remembered song gets its own look back, renamed to the planned name`.
  - `Basic lights is never touched by a load` — its look object deepEqual before/after; it is `runningOrder[0]`; a service that contains an item named "Basic lights" still gets its own look.
  - `old songs that nothing remembers are removed; quick looks and remembered looks stay`.
  - `a song planned twice has its look once in the running order`.
  - `loading again keeps remembered looks and Undo-able order` — load S1 then S2 (S1 with one song removed and two swapped); the kept songs keep their look ids.
  - `deleting a song's look forgets it` — `deleteItem` then `parseShow(ensurePlanning(show))` has no `remembered` entry and no item `look` pointing at it.
  - `the chosen look for new songs is used when it exists, the first quick look otherwise`.
  - `a service with no songs leaves Basic lights alone in the order` (headers, verses and blanks only: `runningOrder` is `[safe]`, `service` set).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the schema fields, `loadService`, `newSongLookOf`, `ensurePlanning`; add `ensurePlanning` to `ensureShow` in `server/src/app.ts` (after `ensureBasicLights`); make `deleteItem` call the same forgetting.
- [ ] **Step 4:** `npm test` → PASS (all, the existing running-order tests included); typecheck clean.
- [ ] **Step 5:** Commit `"Planning: load a service into the running order, songs keep their looks"`.

---

### Task 4: The rows the running order shows

**Files:**
- Modify: `packages/shared/src/planning.ts`, `server/src/layout.ts` (the `OperatorLayout` view the page gets)
- Test: `packages/shared/test/planning.test.ts`, `server/test/server.test.ts` (layout carries rows)

**Interfaces:**
- Produces:
  - `ServiceRow =`
    `| { kind: 'look'; look: string; header: boolean }` (a running-order look; `header` when its service item is a header)
    `| { kind: 'header'; key: string; name: string }` (a header without a look)
    `| { kind: 'item'; key: string; name: string; itemKind: ItemKind; look?: string }` (no look of its own, or a repeated song: `look` set)
    `| { kind: 'verses'; keys: string[]; names: string[] }` (a run of 1+ consecutive verses)
  - `serviceRows(show: Show): ServiceRow[]` — without a service: one `look` row per running-order look. With one: every running-order look appears exactly once as a `look` row, in running-order order; each service item without a look in the order is placed right after the `look` row of the nearest service item above it whose look is in the order (Basic lights when none); looks added by hand (not in the service) appear where the running order has them.
  - The layout view gains `rows: ServiceRow[]` and `service?: { title: string; start: string }`.

- [ ] **Step 1: Failing tests:**
  - `without a service the rows are the running order` (one look row per id, same order).
  - `the 18 Oct service gives labels, songs, muted items and one folded verse row` — Ievads (no look) and Slavēšana (look) give `header` and `look{header:true}`; 18 verses give one `verses` row with 18 keys.
  - `rows keep every look once and in running-order order after Edit list moves` — after `moveItem`, look rows follow `runningOrder`; muted items stay after their anchor.
  - `a deleted anchor moves its muted items up to the next look above`.
  - `a repeated song is an item row with its look`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; build `rows` and `service` in `layout.ts`. **Step 4:** `npm test` → PASS. **Step 5:** Commit `"Planning: running-order rows for headers, items without a look and verses"`.

---

### Task 5: What to start for a live item — DEFERRED (scope change)

**Files:**
- Modify: `packages/shared/src/planning.ts`
- Test: `packages/shared/test/planning.test.ts`

**Interfaces:**
- Produces:
  - `LiveItem = { key?: string; songId?: string; name: string }`
  - `liveItemOf(cue: unknown): LiveItem | null` — from the live message's `current_cue`: `key` from `cue_id` or `id` (a string), `songId` from a UUID in `cue_foreground.text` / `foreground.text`, `name` from `name` / `displayName` / `cue_name`; null when there is no name and no key.
  - `matchLive(service: PlannedService, live: LiveItem, near: number | null): number` — index or -1. By `key` first; else by `songId`, else by exact name; when several match, the one at or after `near` (the last matched index), else the first.
  - `partOf(service: PlannedService, index: number): number` — index of the header above, or -1.
  - `followStep(service: PlannedService, last: number | null, index: number): string | null` — the look id to start:
    1. `index === last` → null.
    2. the item has `look` (and isn't a verse) → that look.
    3. `partOf(index) !== (last === null ? undefined : partOf(last))` and that header has a look → the header's look.
    4. else null.
  - `liveLook(service: PlannedService, index: number): string | null` — the same rules as if nothing had been live (`followStep(service, null, index)`); used by Start and by switching following on.

- [ ] **Step 1: Failing tests** (on the 18 Oct service with looks on Slavēšana, Vārds and the songs):
  - `a song with a look starts its look`.
  - `the blank that opens Vārds starts the sermon look`.
  - `a verse inside Vārds changes nothing, and so do 18 of them`.
  - `a part that opens on a verse starts the part's look`.
  - `a song inside Slavēšana uses its own look, not the part's`.
  - `slides without a look inside a part change nothing`.
  - `the same item again changes nothing`.
  - `catching up: an item judged against an older last item still gets its look` (`followStep(s, 3, 9)`).
  - `matching: by key, then song id, then name; a song planned twice matches the one after the last`.
  - `an item that isn't in the service matches -1`.
  - `liveItemOf takes cue_id, id, a song id and the name, and refuses an empty cue`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `"Planning: which look a live item starts"`.

---

### Task 6: The planning-service client

**Files:**
- Create: `server/src/planning/client.ts`, `server/src/planning/firestore.ts` (the `fromFirestore` decoder, moved from the tool)
- Test: `server/test/planning-client.test.ts`

**Interfaces:**
- Consumes: `writeAtomic` (`server/src/store.ts`), `toPlannedService`, `PlannedService`.
- Produces:
  - `ServiceSummary = { id: string; start: string; items: number; songs: number; songIds: string[] }`
  - `class PlanningClient` constructed with `{ loginFile: string; fetch?: typeof fetch; log?: (line: string) => void }`:
    - `setLogin(cookie: string): Promise<void>` — accepts the bare value or `weAuthRefresh=…`; writes `{ refresh, machineId }` with `writeAtomic(loginFile, …, { mode: 0o600 })`; then proves it with a token; throws `PlanningError` with a plain message on failure.
    - `loggedIn(): boolean` (file has a refresh value)
    - `api(path: string, init?: RequestInit): Promise<any>` (token cached 50 min, renewed on 401 once; a refused refresh throws `PlanningError('The planning login has run out. Paste a new one in Settings.')`)
    - `accounts(): Promise<{ id: string; name: string }[]>`
    - `serviceTypes(account: string): Promise<{ id: string; name: string }[]>` (archived ones left out)
    - `services(account: string, type: string, now: Date): Promise<ServiceSummary[]>` — coming services of that type, nearest first, then the most recent past one; at most 8.
    - `service(account: string, id: string): Promise<PlannedService>`
    - `machineId(): string`
  - `class PlanningError extends Error` (its message is shown to people as is).

The calls are the ones in the 21 Oct scripts in `tools/` (the three untracked files Task 13 replaces) (refresh, `/config/firebase`, `/firebase/token`, custom-token sign-in, Firestore document and `batchGet`). For `services`: a Firestore `runQuery` on `accounts/{account}/cuelists` with an equality filter on `service.type`; if that is refused (a missing index), the newest 100 by `mod` filtered here. A service's start is `service.times[0].time`.

- [ ] **Step 1: Failing tests** with a fake `fetch` that answers by URL (pattern of `ofl.test.ts`'s `fakeOfl`):
  - `setLogin keeps the cookie owner-only and never in the show` (file mode 0o600 skipped on win32; content has `refresh`; `GET /api/show` is Task 8's).
  - `a rotated cookie from the refresh is kept`.
  - `a refused refresh says the login has run out`.
  - `service() turns the document and its songs into a planned service` (doc fixture written from the 25 Oct service's shape).
  - `services() lists coming ones nearest first, then the last past one, at most 8`.
  - `services() falls back when the filtered query is refused`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `"Planning: the planning-service client"`.

---

### Task 7: The live link to the presentation app — DEFERRED (scope change)

**Files:**
- Create: `server/src/planning/link.ts`
- Test: `server/test/planning-link.test.ts`

**Interfaces:**
- Consumes: `PlanningClient.api`, `machineId()`.
- Produces:
  - `LinkStatus = { state: 'connecting' | 'waiting' | 'open' | 'problem'; presenter?: string; problem?: string }` (`waiting`: connected, no presentation computer open)
  - `LiveEvent = { presenter: string; cue: unknown; next?: string; raw: unknown }` (`cue` is `current_cue`)
  - `type SocketLike = { send(text: string): void; close(): void; onmessage: ((e: { data: unknown }) => void) | null; onclose: (() => void) | null; onopen: (() => void) | null }`
  - `class PresenterLink` constructed with `(account: string, deps: { api: PlanningClient['api']; machineId: string; socket?: (url: string) => SocketLike; retryMs?: (attempt: number) => number }, on: { live(e: LiveEvent): void; status(s: LinkStatus): void })`, with `start(): void` and `stop(): void`.

Protocol (as the 21 Oct live-following script in `tools/`): `GET /account/{a}/pusher` → `APP_KEY`, `CLUSTER`; connect `wss://ws-{CLUSTER}.pusher.com/app/{APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`; on `pusher:connection_established` subscribe `presence-{a}` (auth by `POST /account/{a}/pusher` with the form fields the tool sends); presence members with `client === 'weDesktop'` are presentation computers; **follow only the first** (`presence-{id}`, `private-{id}`, then `client-command {action:'activate', machineId}`); join chunked `client-*` messages; answer `pusher:ping`; ping every `activity_timeout`; on member removed, move to the next open computer; on close, retry after `retryMs(attempt)` (default `min(60, 2 ** attempt)` s) and never throw.

- [ ] **Step 1: Failing tests** with a fake socket and fake `api`:
  - `subscribes to the account, then to the first presenter, and asks it for its state` (sent frames in order; the activate command carries the machine id).
  - `joins chunked events and reports the live cue`.
  - `follows the first presenter and moves to the next when it closes`.
  - `answers pings and reconnects after a drop`.
  - `stop closes the socket and stops retrying`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `"Planning: the live link to the presentation app"`.

---

### Task 8: The App: settings, login, listing and loading

**Files:**
- Create: `server/src/planning/index.ts` (`interface Planning`, `createPlanning`), `server/src/planning/fake.ts` (`FakePlanning`)
- Modify: `server/src/app.ts`, `server/src/main.ts`, `server/src/layout.ts`, `packages/shared/src/protocol.ts`
- Test: `server/test/planning.test.ts`

**Interfaces:**
- Produces:
  - `interface Planning { loggedIn(): boolean; setLogin(cookie: string): Promise<void>; accounts(): Promise<{id,name}[]>; serviceTypes(account): Promise<{id,name}[]>; services(account, type, now: Date): Promise<ServiceSummary[]>; service(account, id): Promise<PlannedService> }`
  - `createPlanning(dataDir: string, log): Planning` (real: `PlanningClient`)
  - `class FakePlanning implements Planning` with `services`/`types`/`accounts` fields set by tests, `failWith?: string` to make every call throw `PlanningError`. `FakePlanning.fromFile(path: string)` reads accounts, types and services from a JSON file (for browser checks only); its `setLogin` accepts any non-empty cookie.
  - `AppOptions.planning?: Planning` (default `createPlanning(dataDir, log)`); `main.ts`: `LIGHT_RUNNER_FAKE_PLANNING=<json file>` builds a `FakePlanning` from a file (for browser checks).
  - Command `loadService { id: string(1..64) }` (operator; show edit, one Undo step; the App fetches the service, then `loadService`, then `operatorSave`). Refused when Planning is off ("Planning is off."), for a service with no items ("Nothing is planned in this service yet."), and with the planning error's message when the fetch fails (the show untouched). A load never sends anything to the lights: the stage keeps what it shows.
  - Routes, programmer (add to the `programmerApi` whitelist): `GET /api/planning` → `{ loggedIn, problem: string|null, accounts, serviceTypes }`; `PUT /api/planning/login {cookie}` → same view or 400 with the message. `PUT /api/settings` accepts `planning` (parsed with `PlanningSettings`); `settingsView()` includes it.
  - Route, operator (in `api()`, no PIN): `GET /api/planning/services` → `{ type: string, services: (ServiceSummary & { withLook: number; newSongs: number })[] }` or `{ error }` with 503.
  - The layout view (`server/src/layout.ts`) gains `planning?: { enabled: boolean }`, so the page knows whether to offer Load service; it is refreshed (`refreshLayout()`) when the setting changes.
  - The account used is `settings.planning.account`, else the first of `accounts()`.

- [ ] **Step 1: Failing tests** (`withApp` as in `osc.test.ts`, `planning: fake`; tablets over WebSocket as in `keys.test.ts`):
  - `Planning is off by default and the layout says so`.
  - `the login never reaches the show or an export` (after `PUT /api/planning/login`: `GET /api/show` and `show.json` contain no `refresh`/cookie value; `GET /api/planning` doesn't either).
  - `the services list counts songs that have a look and new ones`.
  - `loadService fills the running order and is one Undo step` (`undo` brings the previous `runningOrder` back).
  - `loadService is refused while Planning is off, and a failed fetch leaves the show as it was`.
  - `a login that runs out never touches the lights or the running order` (fake `failWith`; `GET /api/planning` gives the message as `problem`; `GET /api/planning/services` 503 with it; `loadService` refused with it; `app.state.look` and `runningOrder` unchanged).
  - `loading never changes the lights` (a song on stage, then a load: `app.state.look` and the groups unchanged; same during Blackout).
  - `an empty service is refused`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` PASS, typecheck clean. **Step 5:** Commit `"Planning: settings, login, the services list and Load service on the server"`.

---

### Task 9: Saving to service items, and another look for a song

**Files:**
- Modify: `server/src/app.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/planning.ts`, `packages/shared/src/runningorder.ts`
- Test: `packages/shared/test/planning.test.ts`, `server/test/planning.test.ts`

**Interfaces:**
- Consumes: Task 4's anchor rule (`serviceRows`), `saveItem`'s `Stage` (`runningorder.ts`).
- Produces:
  - `saveServiceItem(show: Show, key: string, stage: Stage): Show` (shared, pure, in `planning.ts`): header, slides, media and other items only; refused for a verse ("Verses don't change the lights."), a blank ("Blanks use their part's look."), an item that already has a look ("<name> already has a look: use Save to <name>.") and an unknown key; creates the look from the stage as `saveItem` would, puts it in the running order right after its anchor (Task 4's rule), sets the item's `look` and `remembered[rememberKey(item)]`.
  - Command `saveServiceItem { key: string(1..64) }` (show edit, one Undo step; from the stage, or the tablet's draft as `saveItem` does; refused during Blackout with `saveItem`'s message).
  - `copyLookToItem(show: Show, item: string, from: string): Show` (shared, pure, in `runningorder.ts`): the item's look takes a copy of `from`'s groups (and its tempo when it has one); its name, id and remembered key stay. Refused for Basic lights ("Basic lights is set by Save.") and for an unknown look.
  - Command `itemCopyLook { item: id, from: id }` (show edit, one Undo step). This is the spec's "pick another look from a menu".

- [ ] **Step 1: Failing tests:**
  - `saveServiceItem gives slides a look after their anchor, remembered for the next load` (pure; then `loadService` of the same service gives the slides that look).
  - `saveServiceItem refuses verses, blanks and items that have a look`.
  - `saveServiceItem from a tablet in Prepare saves the draft, not the stage` (server; pattern of `blind.test.ts`'s saveItem test).
  - `itemCopyLook gives a song another look's groups, keeps its name and is one Undo step; Basic lights refuses it` (server).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test`, typecheck, `npm run jump-check` PASS. **Step 5:** Commit `"Planning: save a look to headers and slides, and give a song another look"`.

---

### Task 10: Settings page: the Planning card

**Files:**
- Modify: `web/settings/index.html`, `web/settings/settings.js`
- Test: `server/test/planning.test.ts` (routes, done in Task 8); browser check below

Card `#planningCard` modelled on `#oscCard` (`index.html:185-204`), named after the service on the page:
- switch "Use <service name> for the running order" (`draft.planning.enabled`, through `edit()`), hint "Off: Light Runner works as before.";
- **Login**: a password field "Login cookie" with the copy-steps hint (the planning site's address and the cookie's name, as in the 21 Oct scripts' header comment: sign in there, then copy that cookie from the browser's developer tools), a **Save login** button that `PUT /api/planning/login` at once (not the save bar), and a status line from `GET /api/planning` ("Logged in · works" or the problem); the field is cleared after a save and never filled from the server;
- **Services** menu (`select.ds-field`) of service types → `draft.planning.serviceType`;
- **Look for new songs** menu of quick looks → `draft.planning.newSongLook` (first option "First quick look");
- add `'planning'` to `changedFields()`'s key list; `load()` also calls a `loadPlanning()`.

- [ ] **Step 1:** Implement. **Step 2:** Browser check: `LIGHT_RUNNER_FAKE_PLANNING=server/test/fixtures/planning-fake.json PORT=8099 LIGHT_RUNNER_OUTPUT=none LIGHT_RUNNER_DATA=<temp> npm start`, open `/settings/`: switch on, save a login, pick a type and a look, Save; reload shows the same; the cookie field is empty. **Step 3:** `npm test` PASS. **Step 4:** Commit `"Planning: the Settings card"`.

(`server/test/fixtures/planning-fake.json` — accounts, two types, the 18 Oct, 25 Oct and 8 Nov services as `PlannedService`s — is written in this task and reused by Task 11.)

---

### Task 11: Operator page: Load service and the new rows

**Files:**
- Modify: `web/operator/index.html`, `web/operator/app.js`, `web/operator/style.css`

What to build (mockups 1 and 2 in `.superpowers/brainstorm/…/service-follow.html`):
- `#orderHead`: wrap the buttons so **Load service** (`button#loadBtn.ebtn`, only when Planning is on) sits left of Edit list; hidden on phone (add to `style.css:1012`'s list). Under the title, when `layout.service`: a muted line "Sun 18 Oct · 08:00 · Rīga" (date from `start`, place = the type name up to " - ").
- Planning on or off comes from `layout.planning?.enabled`.
- **Load panel** `section#loadSvc.block.cedit` in `main.right`, copying `#manual`'s head (‹ Running order, "Load service", the type's name); add it to `markEditorOpen()`, to `applyPhone()`'s closes and the phone hide list; opening it closes the colour editor, effect editor and Individual lights. It `fetch`es `/api/planning/services`; rows as mockup 2 (date, time, "11 items · 7 songs", "5 songs have a look · 2 new get "<look>"", "not planned yet" disabled, "this Sunday"/"last week" notes); Cancel and **Load** (`ds-btn--primary`) send `loadService`; the note "Replaces the songs after Basic lights with this service's items. Basic lights stays first. Undo takes it back."; a fetch error shows its message in the panel. Not offered in Prepare or Edit list (opening turns Prepare off like `setEditing`).
- **Rows**: `buildPlainRows` walks `layout.rows`; `look` rows are today's `button.item` and the only entries in `orderRows` (so `render()`'s index match stays 1:1 with `runningOrder`); `look{header:true}` rows get class `item--part` (spaced capitals, as mockup 1); `header`, `item`, `verses` rows are `div.item.item--muted` (hollow dots, the kind as tag: "video", "slides", "picture", "blank"; the verses row "N Bible verses" with tag "lights stay"). A repeated song (`item` with `look`) is a `button.item` that starts its look but isn't in `orderRows`.
- **Taps on muted rows:** Live → quiet toast "No look yet. Use Prepare to give it one." (verses: "Verses don't change the lights."; blanks: "Blanks use their part's look."). Prepare → the row becomes the prepared target (`prep.target = key`, violet "preparing"), and the Save button reads "Save to <name>" and sends `saveServiceItem {key}`; any running-order tap clears `prep.target`.
- `scrollCue` counts `.item` rows: muted rows count.
- **Another look for a song:** in Edit list, each look row except Basic lights gets a quiet `button.ebtn` "Look ▾" that opens a `fade-menu`-style list: the quick looks, then the other running-order looks and remembered looks by name ("Dievam viss gods · 18 Oct" is not needed: the name is enough); a pick sends `itemCopyLook {item, from}`. No PIN.

- [ ] **Step 1:** Implement. **Step 2:** Browser check at 1080 × 810 with the fake planning: load 18 Oct; rows match mockup 1; tap a song (look starts), a verse row (toast), Next skips muted rows; Prepare → tap the slides → Save to it (hold) → reload → its row is a look row; Undo of the load restores the old songs; 390 × 844 phone shows the rows without Load service. **Step 3:** `npm test` PASS. **Step 4:** Commit `"Planning: Load service and the service's rows on the iPad"`.

---

### Task 12: Operator page: the follow pill — DEFERRED (scope change)

**Files:**
- Modify: `web/operator/index.html`, `web/operator/app.js`, `web/operator/style.css`

- `div.followpick` after `#notes` in `.now` (mockup 3): `button#followPill.ds-pill` with a dot and the text, and `div#followMenu.fade-menu[role=menu]` with one `menuitemcheckbox` "Follow Presenter" sending `follow {on}`; open/close like `showFadeMenu` (`app.js:829-843`) with outside tap and Escape.
- Texts from `PlanningStatus` (the spec's table): "● Following Presenter · **<name>**", "● Following Presenter · **<part>** · verse", "○ Presenter is on **<name>**" + `button.follow-start` "Start" (sends `followStart`; only when not following and `live.look`), "○ Presenter is on **<name>** · not in the running order", "○ Presenter not open", or the problem's text. Hidden when `!planning.enabled`.
- Quiet: `ds-pill` muted edge and text, no amber; Start is the small blue-tint pill of mockup 3. Hidden on mid-size screens below the top bar's room (as `#fading`), and on the phone.

- [ ] **Step 1:** Implement (`connect()` handles `{type:'planning'}` → `planning` global → `renderFollow()`). **Step 2:** Browser check with `LIGHT_RUNNER_FAKE_PLANNING` and a fixture whose `script` steps through the 18 Oct service (Ievads blank, a song, Vārds blank, two verses, an item not in the service): each of the four states looks as mockup 3, and the lights follow; the menu toggles following on two tablets at once. **Step 3:** `npm test` PASS. **Step 4:** Commit `"Planning: the follow pill in the top bar"`.

---

### Task 13: The service tool on the server code

**Files:**
- Create: `tools/planning-service.ts`
- Leave alone: the three untracked 21 Oct scripts in `tools/` (the live one is kept for the later Presenter work; never commit them)

A thin CLI over `PlanningClient` with the login at `${LIGHT_RUNNER_DATA ?? <repo>/data}/planning-login.json`: `planning-service.ts --login | --list | SERVICE_URL [--json]` (`--login` reads the cookie from the keyboard, never the command line; `--list` prints the coming services of the first type; a URL prints the service's items as today's script does). The old scripts' login file in `data/` has the same shape: say in the header comment that it can be copied to `planning-login.json`.

- [ ] **Step 1:** Implement. **Step 2:** `npm run typecheck`; `node tools/planning-service.ts` prints usage; `--list` with an empty `LIGHT_RUNNER_DATA` prints "Not logged in…". **Step 3:** Commit `"Planning: a command-line tool for the planning service"`.

---

### Task 14: Docs and the last checks

**Files:**
- Modify: `docs/STATUS.md`, `docs/DECISIONS.md`, `docs/design-system.md`, `.claude/skills/light-runner-service/SKILL.md`, `CLAUDE.md` (Layout table: `server/src/planning/`, `tools/planning-service.ts`)

- [ ] **Step 1:** STATUS: a "Planning" row in Built (what works, in the spec's words, no platform name); in Not built yet, "Following the presentation app" (designed in the spec, deferred by the owner on 26 Oct); Known issues (login lifetime unknown; not tried at the church). DECISIONS: one dated row each for: Basic lights protected from loads, a load never changes the lights, verses and blanks never get a look of their own, the default look is a copy remembered at load, controllers count only looks, the login outside the show, following deferred. design-system.md: the part row, muted rows and the folded verses row. The skill: one line on Load service before a service.
- [ ] **Step 2:** `npm test`, `npm run typecheck`, `npm run jump-check` all pass; output pasted in the final report.
- [ ] **Step 3:** Commit `"Planning: docs"`.
