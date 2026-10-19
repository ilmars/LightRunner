# Preview mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-tablet Preview mode on the operator page: tapping a running-order item selects it instead of starting it, the details panel edits that item's saved colours and levels (saved straight in, nothing sent to the lights), and the stage picture shows the item as it will look.

**Architecture:**
- Two new show-edit commands, `itemGroup` and `itemQuickLook`, are pure functions in `runningorder.ts`. They go through the existing `editShow` in `server/src/app.ts`, so Undo, saving and backups work as for Save.
- The layout gives each look its entries (preset, name, swatch, light per group), so the page can draw an item without the stage.
- The preview picture comes from a fresh pure `Engine` on the server, served at `GET /api/looks/:id/visual`.
- Preview state (on/off and the selected item) lives only in the page.

**Tech Stack:** Node 24 (type stripping), TypeScript (erasable syntax only), zod, node:test, plain HTML/JS/CSS (no build).

**Spec:** [docs/superpowers/specs/2026-10-19-preview-mode-design.md](../specs/2026-10-19-preview-mode-design.md). Read it, including "Settled after the builder check".

## Global Constraints

- Branch `preview-mode` from `main`; work in the main checkout (no worktree).
- Preview never sends anything to the lights; Master, Flash, Blackout, Undo and Next keep acting on the live stage.
- Every edit is a `Command` through `App.command()`; the server is the single source of truth (CLAUDE.md).
- The engine stays pure; the preview picture uses the engine, not new colour maths on the page.
- TypeScript: erasable syntax only, `.ts` import extensions, `import type` for types.
- Web: design system tokens (`web/shared/theme.css`, docs/design-system.md), quiet controls, 44 px targets, nothing bright.
- Writing: plain words, sentence case. UI text in English.
- `npm test`, `npm run typecheck` and `npm run jump-check` pass before every commit.
- The phone has no Preview.

## Review Focus

1. A Preview edit of the item that is on stage: the stage must not change at all (no fade, no restart), and the item shows "changed". Pinned by a server test in Task 2.
2. A drag on the colour strip, a dimmer, or a White/Amber/UV slider in Preview: one command and one Undo step, sent when the finger lifts, never one per move. Checked in Task 4's browser step.
3. A level for a group the item doesn't set: refused with a plain message, and the page disables that row's dimmer. Pinned in Task 1 and checked in Task 4.
4. Preview left on while another tablet edits or deletes the selected item: the page follows the new layout, and drops the selection back to the item on stage when the item is gone. Checked in Task 3.
5. Basic lights in Preview: colours can change, levels stay at full. Pinned in Task 1.

---

### Task 1: Item edits as pure functions and commands

**Files:**
- Modify: `packages/shared/src/runningorder.ts` (new exports next to `saveItem`)
- Modify: `packages/shared/src/protocol.ts` (two commands in `Command`, both added to `SHOW_EDITS`)
- Test: `packages/shared/test/runningorder.test.ts`

**Interfaces:**
- Produces, in `runningorder.ts`:
  - `export interface ItemGroupEdit { group: string; preset?: string; colour?: string; white?: number; amber?: number; uv?: number; level?: number }`
  - `export function setItemGroup(show: Show, itemId: string, edit: ItemGroupEdit): Show`
  - `export function applyQuickLookToItem(show: Show, itemId: string, quickLookId: string): Show`
- Produces, in `protocol.ts`, `Command` members:
  - `{ type: 'itemGroup', item: id, group: id, preset: id.optional(), colour: hex.optional(), white/amber/uv: unit.optional(), level: unit.optional() }`
  - `{ type: 'itemQuickLook', item: id, look: id }`

Rules for `setItemGroup`. Each refusal throws an `Error` with exactly this message:
- `itemId` not in `show.operator.runningOrder` → `only running-order items can be changed here`.
- Unknown group → `the show has no group "<id>"`. Smoke group → `smoke machines aren't part of a song`.
- Both `preset` and `colour` given → `pick a colour or a preset, not both`. Neither given, and no `level` → `nothing to change`.
- `preset`: must be a preset of that group, otherwise `unknown preset "<id>" for group "<group>"`. The entry references it.
- `colour` (with optional extras): stored through the existing `entriesFor` path, as `livePresetId(group, colour, extras)`. It becomes a new hidden "Custom" preset, exactly as Save makes one.
- `level` only, on a group the item doesn't set → `Give the group a colour first.`
- The entry is replaced in place, or appended when the group had none. The other entries and the item's name stay.
- For `show.operator.safeLook` (Basic lights), every entry's level stays 1, whatever `level` says.

Rules for `applyQuickLookToItem`:
- Same item check as above.
- `quickLookId` must be in `show.operator.quickLooks` → otherwise `that is not a quick look`.
- For each entry of the quick look, the item gets `{ group, preset, level }` (preset referenced, not copied), replacing that group's entry.
- Groups the quick look doesn't list keep their entries. Levels are forced to 1 for Basic lights.

- [ ] **Step 1: Write the failing tests** in `runningorder.test.ts`, using the file's existing demo-show helpers:

```ts
test('setItemGroup sets a preset and a level in a song, leaving the rest', () => { /* song-1, audience → aud-blue at 0.4: entry equals { group: 'audience', preset: 'aud-blue', level: 0.4 }; every other entry deepEqual before; input show unchanged */ });
test('setItemGroup keeps an Any colour as a new hidden Custom preset, with its amber', () => { /* colour '#ff0000', amber 0.5 → one new preset, custom: true, layers[0].colour deepEqual { hex: '#ff0000', amber: 0.5 }, entry.preset is its id */ });
test('setItemGroup refuses a level for a group the song does not set, smoke, quick looks and both preset and colour', () => { /* assert.throws with each exact message above */ });
test('Basic lights keeps its levels at full in setItemGroup and applyQuickLookToItem', () => { /* level 0.3 on safeLook → entry.level === 1 */ });
test('applyQuickLookToItem copies only the groups the quick look lists', () => { /* listed groups take the quick look's preset and level; unlisted groups deepEqual before */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test packages/shared/test/runningorder.test.ts`
Expected: FAIL, "setItemGroup is not a function" (import error).

- [ ] **Step 3: Implement** `setItemGroup` and `applyQuickLookToItem` in `runningorder.ts`. Reuse `entriesFor(out, { groups: { [group]: presetOrLive }, levels: { [group]: level } }, [group])` for the one entry. `livePresetId` comes from `./protocol.ts`. Then add both commands to `Command` and `SHOW_EDITS` in `protocol.ts`, with a one-line doc comment each, like their neighbours.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test packages/shared/test/runningorder.test.ts && npm run typecheck`
Expected: PASS. Typecheck fails in `server/src/app.ts` until Task 2 handles the new `ShowEdit` cases. If so, add the two `case`s there now as `throw new Error('not yet')`, and Task 2 replaces them.

- [ ] **Step 5: Commit** — `git commit -m "Preview edits: change a song's group colour, level or quick look without the stage"`.

### Task 2: Server — edits, layout entries, preview picture

**Files:**
- Modify: `server/src/app.ts` (`editShow` cases, `isParam`, route `GET /looks/:/visual`)
- Modify: `server/src/layout.ts` (`OperatorLook.entries`)
- Create: `packages/engine/src/preview.ts`; export it from `packages/engine/src/index.ts`
- Test: `packages/engine/test/preview.test.ts`, `server/test/server.test.ts`

**Interfaces:**
- Consumes: Task 1's `setItemGroup`, `applyQuickLookToItem` and commands.
- Produces:
  - `export function settledVisual(show: Show, lookId: string): Uint8Array` in `packages/engine/src/preview.ts`. It returns 3 bytes per fixture, in the same order as `layout.fixtures`.
    - A fresh `Engine(show, 0)` runs `{ type: 'look', id, fade: 0 }`, or `{ type: 'safe' }` when `lookId === show.operator.safeLook`. It is framed at 0 and at 60 so every fade and ramp has settled, and returns a copy of the visual.
    - Master is 1, so the picture is never dimmed. A group the look doesn't set stays dark.
  - `OperatorLook.entries: (OperatorEntry | null)[]`, in the same order as `groups`; null = not set, always null for smoke.
    - `export interface OperatorEntry { preset: string; name: string; swatch: string; light: LiveLight | null }`.
    - `name` is the preset's name ("Custom" for an Any colour pick). `swatch` is the same value as `colours[i]`. `light` is `presetLight(preset)`, as for the group presets.
  - `GET /api/looks/:id/visual` → `200 { visual: number[] }`, or `404` for an unknown look. It is open to operators, like `GET /api/layout`.
  - `editShow` handles:
    - `itemGroup` → `setItemGroup(before, cmd.item, cmd)`
    - `itemQuickLook` → `applyQuickLookToItem(before, cmd.item, cmd.look)`
    - Neither uses the stage, and both work during Blackout.

- [ ] **Step 1: Write the failing tests**
  - `preview.test.ts`:
    - `'settledVisual shows a look settled, without touching any stage'`: demo show; a look that sets audience to a blue preset. The audience fixtures' bytes are blue (b > r and b > g); another look's visual differs; the result's length is `fixtures.length * 3`.
    - `'settledVisual of Basic lights is the safe light'`: every fixture lit, r ≥ b.
  - `server.test.ts` (use `withApp`, `tablet`, `savedLook`):
    - `'Preview edits change a song and never the stage, even the song on stage'`. Start song 1 with fade 0 and wait for the state. Send `itemGroup` to song 1 with audience → `aud-blue` at level 0.4, and expect a `null` reply. Then:
      - the saved look has `{ group: 'audience', preset: 'aud-blue', level: 0.4 }`
      - `state().groups.audience.preset` is still what it was before
      - `state().lookChanged === true`
      - `state().canUndo === true`
      - `undo` brings the saved entry back
    - `'the layout gives each item its entries, and the preview picture is served'`. `layout().runningOrder[1].entries` has the same length as `layout().groups`. `GET /api/looks/<song>/visual` → 200, with `visual.length === layout().fixtures.length * 3`. An unknown id → 404.

- [ ] **Step 2: Run them and see them fail** — `node --test packages/engine/test/preview.test.ts server/test/server.test.ts`. Expected: FAIL (missing module or route).

- [ ] **Step 3: Implement** in this order: `settledVisual`, `entries` in `operatorLayout` (in `describe`), the `editShow` cases, then `isParam` (`head === 'looks'` → `i === 1`) and the route. The route uses `this.show`, so it always reflects the latest edit.

- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run jump-check`. Expected: all pass (the known flaky backup test may need a re-run).

- [ ] **Step 5: Commit** — `git commit -m "Preview: server edits, item entries in the layout, preview picture"`.

### Task 3: Page — the Preview switch and selecting items

**Files:**
- Modify: `web/operator/index.html` (a `#previewBtn` button in the top bar, just before the settings gear)
- Modify: `web/operator/app.js`, `web/operator/style.css`

**Interfaces:**
- Produces, in `app.js`:
  - `const preview = { on: false, item: null }`
  - `function setPreview(on)`
  - `function selectItem(id)`
  - `function previewItem()`: returns the `layout.runningOrder` item or null.
  - `let previewVisual = null` (a `Uint8Array` or null)
  - `function loadPreviewVisual()`
  - Task 4 uses all of these.

Behaviour:
- `#previewBtn` is a quiet top-bar button with `aria-pressed`, text "Preview", 44 px tall.
- `setPreview(true)`:
  - turns running-order Edit off
  - selects the item on stage, or else the item Next would start
  - adds `body.preview` and `topBar.preview`
  - calls `loadPreviewVisual()`
- `setPreview(false)`: clears the selection and `previewVisual`, removes the classes, and re-renders the details from the live state.
- `setEditing(true)` calls `setPreview(false)` first.
- In Preview, a tap on a running-order item calls `selectItem(item.id)`, not `start(item)`.
- The selected item gets `.item.selected`: a quiet outline (`box-shadow: inset 0 0 0 1px var(--ds-edge-on)`, no fill). The on-stage item keeps its blue look, and `next` keeps working.
- `.topbar.preview` is a quiet neutral strip: not Flash blue, not amber. The problem, off and blackout styles win over it.
- `loadPreviewVisual()` fetches `/api/looks/<id>/visual`. A sequence number drops stale answers, and the result is stored in `previewVisual` before calling `drawStage()`. It is called on select, on `setPreview(true)`, and whenever a `layout` message arrives while Preview is on.
- When a new layout no longer has the selected item, select the item on stage (or the first item).
- `drawStage()` draws `previewVisual` instead of `visual` while Preview is on and it is loaded. It also draws a small, quiet "Preview" label in the canvas's top-left corner (muted text colour, 11 px).
- Phone:
  - `applyPhone()` calls `setPreview(false)` when the phone layout starts.
  - The phone CSS block hides `#previewBtn` (add it to the existing `display: none !important` list).
- Preview is off after a reload (the default state).

- [ ] **Step 1: Implement** the above.
- [ ] **Step 2: Browser check** on the 8092 test server (`LIGHT_RUNNER_OUTPUT=none`) at 1080×810:
  - Preview on: the strip shows, and the stage picture shows the selected item with the label.
  - Tapping Song 3 selects it (outline), and the live state's `look` doesn't change.
  - Next still starts the next item. Edit turns Preview off.
  - At 390×844 there's no Preview button, and turning the phone layout on clears Preview.
  - No console errors.
- [ ] **Step 3: Run** `npm test && npm run typecheck`.
- [ ] **Step 4: Commit** — `git commit -m "Operator page: Preview switch and selecting items without starting them"`.

### Task 4: Page — editing the selected item

**Files:**
- Modify: `web/operator/app.js`, `web/operator/style.css`
- Modify: `docs/STATUS.md` (a Preview line in the Operator page row; take Blind mode out of "Not built yet"), `docs/DECISIONS.md` (an entry for 19 Oct: Preview edits save straight into the item, unlike live edits)

**Interfaces:**
- Consumes:
  - Task 3: `preview`, `previewItem()`, `loadPreviewVisual()`.
  - Task 2: `layout.runningOrder[].entries`.
  - Task 1: the `itemGroup` and `itemQuickLook` commands.
- Produces:
  - `function groupStatus(group)`: in Preview, `{ preset, level, live: null, entry }` from the selected item's `entries[i]` and `levels[i] ?? 1`; otherwise `state.groups[group.id]`.
  - `presetInfo`, `runningLight`, `renderDetails`, `renderPicker` and `renderSheet` take their status from `groupStatus`.
  - `presetInfo` returns `{ name: s.entry.name, colour: s.entry.swatch }` when `s.entry` is present.
  - `runningLight` uses `s.entry.light`.
  - An item that doesn't set a group gives `{ preset: null, level: 0, live: null, entry: null }`. Its row shows "not set" and its dimmer is disabled (class `ds-disabled`, no pointer handling).

Behaviour in Preview. All sends go to the selected item; nothing is sent to the stage.
- The details title is the selected item's name. `#saveBtn` and `#backBtn` are hidden.
- Swatch tap → `{ type: 'itemGroup', item, group, preset: p.id }`.
- Any colour strip: nothing while dragging. On release, send one `itemGroup` with `colour` and, when the picker's extras are the user's (as now), `white/amber/uv`.
- White/Amber/UV slider release → one `itemGroup` with the running colour and `extraLevels()`.
- Group dimmer release → one `itemGroup` with `level`. For Basic lights the dimmers are disabled.
- Quick look tap → `{ type: 'itemQuickLook', item, look: q.id }`.
- Hidden in Preview: `.ql.newq` (Save stage as quick look), `#pEditBtn`, `#pAddOpen`, `#pAdd`. Use `body.preview` selectors in style.css.
- Smoke rows are hidden in Preview (`body.preview .row.smoke { display: none }`).
- Each successful edit brings a new layout, which re-renders the rows and reloads the picture (Task 3).

- [ ] **Step 1: Implement** the above.
- [ ] **Step 2: Browser check** at 1080×810 on the 8092 test server, with the WebSocket messages watched in the page:
  - With Song 2 on stage, select Song 4 and change Background to another colour. The stage picture shows it, `state.look` and `state.groups.background.preset` don't change, and Song 4's dots in the running order update.
  - A drag on a dimmer sends exactly one `itemGroup` on release.
  - Undo takes the edit back.
  - A "not set" row's dimmer doesn't move.
  - Editing Song 2 itself (on stage) leaves the stage and shows "changed".
  - Basic lights' dimmers are disabled.
  - A quick look tap in Preview changes only the listed groups of the item.
  - No console errors.
- [ ] **Step 3: Run** `npm test && npm run typecheck && npm run jump-check`.
- [ ] **Step 4: Update** STATUS.md and DECISIONS.md as listed.
- [ ] **Step 5: Commit** — `git commit -m "Operator page: Preview edits the selected item's colours and levels"`.
