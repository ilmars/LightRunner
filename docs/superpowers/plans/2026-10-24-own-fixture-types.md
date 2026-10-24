# Your own fixture types: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Patch, see any fixture type's channels, compare two side by side, and make, copy, edit and delete your own types, then switch fixtures to them.

**Architecture:** All channel-list logic (rows, segments, summary, comparison, validation, edits) is a pure, DOM-free module `web/patch/types.js` (typed by `types.d.ts`, tested from `server/test` like `plan.js`). The server's `GET /api/profiles` also returns each type's channels and whether it is read-only. The page edits its copy of the show (`show.profiles`, `show.fixtures`) and stores it with the existing **Save patch** (`PUT /api/show?source=patch`); no schema change.

**Tech stack:** plain JS ESM page (no framework, no build), Node 24 server in TypeScript, node:test.

**Spec:** [docs/superpowers/specs/2026-10-24-own-fixture-types-design.md](../specs/2026-10-24-own-fixture-types-design.md). Read it, including "Calls made while writing this up".

## Global constraints

- Branch `own-fixture-types` (main checkout, no worktree). New commits only; never push or tag.
- Nothing reaches the show before **Save patch**; **Discard** throws away new and edited types with everything else.
- Read-only types: `source.ofl` set, or a built-in id (`BUILT_IN_PROFILES` in `packages/shared/src/profiles.ts`). Every other type in the show is editable.
- Words on screen: "Fixed value", "16-bit", "Warm end", "Cool end", "Value", "segment"; never "role", "default" or "profile".
- Design system: `web/shared/theme.css` tokens and `ds-` components (`docs/design-system.md`), 44 px targets, quiet controls, dark; works at 1080 × 810 (iPad) and on a laptop.
- `npm test`, `npm run typecheck`, `npm run jump-check` pass before every commit.
- Every process an implementer starts (test servers, browsers) is stopped before it reports; never touch ports 8080/8089 or the owner's installed Light Runner; leave untracked `.claude/launch.json`, `.claude/preview.env`, `tools/worshiptools*.ts` alone.

## Review focus

1. Numbers typed into Warm end / Cool end / Value that are empty, not numbers, decimals or out of range: a plain message, never `NaN` or a broken show saved. (Task 1 test.)
2. Switching 16-bit on or off in the middle of a list: exactly one channel is added or removed right after that channel, later channels keep their jobs and order. (Task 1 test.)
3. Editing a type so it has fewer segments while fixtures of it are in groups with effects, held segments or saved looks: Save patch succeeds and the engine keeps running (no crash, no stuck light). (Task 3 test.)
4. A read-only type can never be changed through the page: its view has no Edit, and Copy and edit makes a new id. (Task 1 + Task 2 tests.)
5. The SonicPulse 39-channel type (dimmer, strobe, 5 fixed values, 8 × RGBW) shows rows, segments and summary correctly, and its copy keeps every channel's name, value and fine byte. (Task 1 test.)

---

### Task 1: Channel-list logic (`web/patch/types.js`)

**Files:** Create `web/patch/types.js`, `web/patch/types.d.ts`; test `server/test/fixture-types.test.ts`.

**Interfaces — Produces** (the channel shape is the schema's `ProfileChannel`: `{ role, fine?, default?, kelvin?: {min,max}, name? }`):

- `JOBS: { job: Job, label: string }[]` in this order: `dimmer` "Dimmer", `red` "Red", `green` "Green", `blue` "Blue", `white` "White", `amber` "Amber", `uv` "UV", `cct` "Colour temperature", `strobe` "Strobe", `other` "Fixed value". (`Job` = the schema's role names.)
- `channelRows(channels): Row[]`: one row per channel, its fine byte folded into it. `Row = { index: number /* position in channels of the coarse byte */, first: number, last: number /* 1-based channel numbers; last = first + 1 when 16-bit */, job, label /* from JOBS */, sixteenBit: boolean, kelvin?: {min,max}, value?: number /* default, for strobe and other */, name?: string, segment: number | null }`.
  - Segment rule (spec call 4): the n-th non-fine colour channel of a colour role (red, green, blue, white, amber, uv) is in segment n; a channel lies in segment s when it is between segment s's first and last colour channel (inclusive). Anything else, and every row of a type with one segment, has `segment: null` ("the whole light").
- `segmentCount(channels): number`: equals `profileSegments` in `packages/shared/src/presets.ts` for every type.
- `channelText(ch): string`, used by the comparison: "Dimmer", "Dimmer, fine", "Colour temperature 3200–5600 K", "Strobe 0", "Fixed value 255", "Red"…; a channel with a `name` adds it after a dash: "Fixed value 0 — RGBW Color Change".
- `summary(channels): string`:
  - `"<N> channels"` ("1 channel"),
  - then for one segment `" · one light · "` + the rows' jobs in order, lower case, joined with ", " and a last " and " (cct as "colour temperature A–B K"; several fixed values counted as "<k> fixed values"),
  - for several segments `" · <S> segments · each <segment 1's colour jobs>"` and, when there are whole-light rows, `" · also <their jobs, as above>"`.
  - Exact: walimex `[dimmer, cct 3200–5600]` → `"2 channels · one light · dimmer and colour temperature 3200–5600 K"`; SixBar 500 → `"18 channels · 3 segments · each red, green, blue, white, amber and UV"`; SonicPulse 39 → `"39 channels · 8 segments · each red, green, blue and white · also dimmer, strobe and 5 fixed values"`.
- `compareRows(a, b): { n: number, left: string | null, right: string | null, same: boolean }[]`: one per channel number 1…max(lengths), texts from `channelText`, `null` past a type's end, `same` when the texts are equal.
- `validateType(name, channels): string | null`, the first problem in plain words, else null:
  - empty name: `"Give the type a name."`; no channels: `"Add at least one channel."`; more than 512: `"A fixture type has at most 512 channels."`;
  - a cct with a missing or non-whole or out-of-range end: `"Channel <first>: colour temperatures are whole numbers from 1000 to 20000 K."`; warm ≥ cool: `"Channel <first>: the warm end must be below the cool end."`;
  - a strobe/other value that is missing, not whole or outside 0–255: `"Channel <first>: a value is a whole number from 0 to 255."`.
- Edits, each returning a **new** array (never mutate): `addChannel(channels, job)` (appends; cct starts at `{min: 2700, max: 6500}`, strobe and other at value 0), `setJob(channels, rowIndex, job)` (keeps `name` and the 16-bit fine byte if the new job takes a level, drops `kelvin`/`default` that no longer apply, adds the new job's starting values), `setSixteenBit(channels, rowIndex, on)` (inserts or removes the one fine channel right after; only for dimmer, the six colours and cct), `setKelvin(channels, rowIndex, {min, max})`, `setValue(channels, rowIndex, value)`, `moveRow(channels, rowIndex, -1 | 1)` (moves the row with its fine byte past the neighbouring row), `removeRow(channels, rowIndex)`, `repeatLastSegment(channels)` (inserts a copy of the last segment's channels, names and values included, right after it and before any trailing whole-light channels; with one segment it copies the colour channels as segment 2).
- `copyOf(profile, takenIds): { id, name: "Copy of <name>", channels }` (deep copy, names/values/fine bytes kept, no `source`), and `newTypeId(name, takenIds): string` (slug of the name — lower case, letters and digits, `-` between — unique by `-2`, `-3`…; `takenIds` = the show's type ids plus the built-in ids).
- `isReadOnly(profile, builtInIds: Set<string>): boolean`.

- [ ] **Tests first** in `server/test/fixture-types.test.ts`, importing `../../web/patch/types.js` and the real types from `shows/stage-l1.json` (AS600B, SixBar 500, SonicPulse 10 39 ch, SonicPulse 05 23 ch, the strip) and `BUILT_IN_PROFILES`:
  - the three exact summaries above; `segmentCount` equals `profileSegments` for every stage-l1 and built-in type;
  - SonicPulse 39 rows: channel 1 Dimmer and 2 Strobe and 3–7 Fixed value have `segment: null`; channels 8–11 segment 1 … 36–39 segment 8;
  - `compareRows(AS600B, walimex)` → `[{n:1, same:true}, {n:2, left:"Colour temperature 2500–10000 K", right:"Colour temperature 3200–5600 K", same:false}]`;
  - `validateType` messages for: `""`, `[]`, cct `{min: NaN}`, `{min: 3200.5}`, `{min: 5600, max: 3200}`, other value `256`, `-1`, `undefined` (Review Focus 1);
  - `setSixteenBit` on row 2 of `[dimmer, red, green, blue]` → `[dimmer, red, red(fine), green, blue]`, and off again restores the input (Review Focus 2); `moveRow` keeps a 16-bit pair together;
  - `repeatLastSegment(SixBar 500)` has 24 channels and 4 segments; on SonicPulse 39 the 5 leading whole-light channels stay first;
  - `copyOf(SonicPulse 39)` keeps every channel's `name`, `default` and `fine`, has no `source`, and its id avoids the taken ids (Review Focus 5); `isReadOnly` is true for a `source.ofl` type and for `generic-rgb`, false for the AS600B (Review Focus 4).
- [ ] Implement; `types.d.ts` beside it types the module for the tests, as `plan.d.ts` does for `plan.js` (the tests are type-checked through it); run the checks; commit "Patch: the logic for fixture types' channels, summaries, comparison and edits".

### Task 2: See a type's channels, and compare two

**Files:** Modify `server/src/app.ts` (`GET /api/profiles`), `web/patch/index.html`, `web/patch/patch.js`, `web/patch/style.css`; test `server/test/` (the file with the existing profiles route tests, or `fixture-types.test.ts`).

**Interfaces — Consumes:** Task 1's `channelRows`, `summary`, `compareRows`, `isReadOnly`. **Produces:** each `GET /api/profiles` item also has `defs: ProfileChannel[]` (the full channels) and `readOnly: boolean`; the page keeps `profiles` summaries updated with both when a type is added (`addProfile`) or edited (Task 3).

- [ ] Server test: `GET /api/profiles` returns `defs` equal to the show's or built-in channels and `readOnly` true for built-ins and a `source.ofl` type, false for a Lightkey-style type (no source). Implement it.
- [ ] Page: the picked type in the Fixture library gets a quiet **Channels ›** button (and the Fixtures table's Type can open the same view, builder's choice of how). It opens a sheet in the page's existing sheet/panel style: the type's name, its `summary`, the rows numbered (`first`, or `first–last` for 16-bit) with job, range or value, and name, grouped under "Segment 1", "Segment 2"… headings when there are several, and "Whole light" for `segment: null` rows. Buttons: **Compare with…** (pick a second type from the list; then the two-column comparison from `compareRows`, differing rows marked with the design system's warn tint, "—" where one type has no channel), **Copy and edit** (Task 3; hidden until Task 3 lands, or opens Task 3's editor once it exists), **Edit** only when not read-only (Task 3), **Close**.
- [ ] Check in a browser on your own test server (`LIGHT_RUNNER_OUTPUT=none LIGHT_RUNNER_DATA=<new scratch folder> PORT=8099 node server/src/main.ts`, after `Open a show file` or Compare-importing `shows/stage-l1.json` so the real types are there): AS600B, SixBar 500 and SonicPulse 39 views; AS600B compared with SixBar. Screenshot to the scratchpad. Stop the server.
- [ ] Checks; commit "Patch: see a fixture type's channels, and compare two side by side".

### Task 3: Make, copy, edit and delete your own types; Use it for

**Files:** Modify `web/patch/index.html`, `web/patch/patch.js`, `web/patch/style.css`; test `server/test/` (Review Focus 3).

**Interfaces — Consumes:** Task 1's edits, `validateType`, `copyOf`, `newTypeId`, `isReadOnly`, `summary`, `channelRows`; Task 2's sheet and `defs`/`readOnly`.

- [ ] Server test (Review Focus 3): load `shows/stage-l1.json`; with the SixBar 500 fixtures in a group that runs an effect and has a held segment, `PUT /api/show?source=patch` the show with the SixBar type cut to 2 segments (12 channels); expect 200, the state still published, and the engine still answering commands (a look and Blackout). Fix whatever breaks (expect nothing).
- [ ] Page: **＋ New fixture type** next to the Fixture library heading opens the editor (empty name, no channels); **Copy and edit** opens it with `copyOf`; **Edit** opens it on an editable type. The editor, per the spec's goal 3 and the mockup: Name; the rows (job picker from `JOBS`, **16-bit** switch where allowed, **Warm end** / **Cool end** in K for colour temperature, **Value** for strobe and fixed value, the channel's own `name` shown read-only when it has one, **↑ ↓ ×**), grouped by segment as in Task 2; **＋ Add channel**; **Repeat the last segment** when there is at least one colour channel; the live `summary`; "Used by N fixtures" when editing; **Use it for**: every fixture in the show with a tick (for Copy and edit, the copied type's fixtures listed first; ticks start empty; editing an existing type lists its fixtures as already using it); the `validateType` message under the buttons, Save type disabled while there is one; **Cancel**, **Save type**; **Delete type** (tap twice) when editing a type no fixture uses.
- [ ] Save type: puts the type in `show.profiles` (new id from `newTypeId`, fixed afterwards; renaming changes only `name`), switches the ticked fixtures' `profile`, refreshes `profiles` (with `defs`, `readOnly: false`, `segments`), the library, the map, the plan and the address check, and marks the patch changed ("Unsaved changes"); nothing else is sent. Delete type removes it from `show.profiles` the same way.
- [ ] Browser check on your own test server (as in Task 2): make the walimex type from **Copy and edit** on the AS600B (name "walimex pro LED Niova 600 Plus Bi Color", cct 3200–5600), tick P1–P4, Save type, Save patch, reload: P1–P4 use it, the view shows 3200–5600 K. Make a 10-segment bar with Repeat the last segment. Try Discard after Save type (the type is gone). Screenshots; stop the server.
- [ ] Checks; commit "Patch: make, copy, edit and delete your own fixture types, and switch fixtures to them".

### Task 4: Docs

**Files:** `docs/setting-up-a-show.md` (step 2's "A fixture that is in neither…" → making your own type, Copy and edit, Compare, with the walimex as the example), `.claude/skills/light-runner-service/SKILL.md` (its line about types), `docs/STATUS.md` (own fixture types and the channel view/compare as built; remove from programmer niceties), `docs/DECISIONS.md` (own types live in the show; library and built-in types are read-only, copy to change; Lightkey types are editable), `README.md` tour (Patch: one line).

- [ ] Write them in the docs' plain style; check every button name against the page; commit "Docs: your own fixture types".
