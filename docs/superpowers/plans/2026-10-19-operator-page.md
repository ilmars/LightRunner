# Operator Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the operator page with the agreed layout: running order, quick looks, group details with a colour picker, Save and Back, Flash and a new top bar, with Basic lights taking over from Safe.

**Architecture:** The show gains a running order, a quick-look list, per-group levels in looks and "Any colour" presets. The engine (pure, in the worker) learns quick looks, live colours, look levels, "changed" tracking and Flash. The server's `App.command()` handles commands that edit the show (save, add, rename, delete, move, save as quick look) on the main thread through pure functions in `packages/shared`, and keeps one Undo list covering stage and show edits. The page is rewritten in plain HTML/JS, matching the sketch.

**Tech Stack:** Node.js 24 (TypeScript by type stripping, no build), zod, ws, `node:test`; plain HTML/CSS/JS pages.

**Spec:** [docs/superpowers/specs/2026-10-19-operator-layout-design.md](../specs/2026-10-19-operator-layout-design.md). Sketches: [operator-ui-sketch.html](../specs/2026-10-19-operator-ui-sketch.html), [operator-top-bar-sketch.html](../specs/2026-10-19-operator-top-bar-sketch.html). The sketch's code is for look and behaviour only; don't copy it.

## Global Constraints

- Node.js 24+, TypeScript with erasable syntax only (no enums, namespaces, parameter properties), `.ts` import extensions, `import type` for types.
- The engine stays pure: no timers, sockets or files in `packages/engine`.
- Every input becomes a `Command` (`packages/shared/src/protocol.ts`) and goes through `App.command()`. The server is the single source of truth; the page only displays state and sends commands.
- `npm test`, `npm run typecheck` and `npm run jump-check -- --hours 0.2` pass before every commit. Anything touching fades must keep the jump check under 5% per frame.
- Pages: dark only, nothing bright enough to light the operator's face, thumb-sized targets (at least 44 px) on the iPad at 1080 × 810 landscape, quiet controls. Reuse the colour tokens in `web/operator/style.css` (`--bg`, `--panel`, `--raised`, `--line`, `--text`, `--dim`, `--accent`, `--warn`, `--danger`).
- UI text: plain English, sentence case, no jargon. Preset names stay as they are (Latvian).
- Commit after each task on branch `operator-ui-design` with a short descriptive message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A tablet loses its connection while Flash is held:** the flash must end, not stay on. Test in Task 5.
2. **One tablet deletes the item another has on stage:** nothing on stage changes, nothing crashes, no item is highlighted, and Next starts the first song. Test in Task 5.
3. **Save during a fade:** Save stores where the fade is going (preset and level targets), not the in-between values. Test in Task 1 (pure function given targets) and Task 5 (through the app).
4. **Restart with an "Any colour" pick on stage:** the colour comes back after the restart. Test in Task 3.
5. **Empty or very long names** when renaming a song or naming a quick look: empty is refused with a plain message, and names are trimmed and cut to 40 characters. Test in Task 1.

---

## File map

| File | Change |
| --- | --- |
| `packages/shared/src/schema.ts` | `LookEntry.level`, `Preset.custom`, `OperatorLayout.runningOrder` and `quickLooks`, reference checks |
| `packages/shared/src/protocol.ts` | New commands, `livePresetId` / `parseLivePreset`, `LiveState.lookChanged` and `flashing` |
| `packages/shared/src/runningorder.ts` (new) | Pure show edits: migration, save, add, rename, delete, move, save as quick look |
| `packages/shared/src/merge.ts` | Removing a look also drops it from `runningOrder` and `quickLooks` |
| `packages/shared/src/index.ts` | Export `runningorder.ts` |
| `packages/engine/src/engine.ts` | Look levels, quick looks, live colours, `lookChanged`, Flash, `recorded`, levels in Undo |
| `server/src/messages.ts`, `server/src/worker.ts` | `snapshot` request, `recorded` in results |
| `server/src/app.ts` | Show-edit commands, unified Undo, Flash released on disconnect, migration at start |
| `server/src/layout.ts` | Running order, quick looks, Basic lights id, white-only groups, custom presets hidden |
| `tools/jump-check.ts` | Random quick looks, live colours, looks with levels |
| `web/operator/index.html`, `style.css`, `app.js` | Rewritten page |
| `docs/STATUS.md`, `docs/DECISIONS.md` | Updated at the end |

---

### Task 1: Show format and pure running-order edits

**Files:**
- Modify: `packages/shared/src/schema.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/merge.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/src/runningorder.ts`
- Test: `packages/shared/test/runningorder.test.ts`

**Interfaces:**
- Produces (schema):
  - `LookEntry.level?: number` (0..1). Missing means 1.
  - `Preset.custom?: boolean`: made by Save from an "Any colour" pick; never shown as a swatch.
  - `OperatorLayout.runningOrder: string[]` (look ids, default `[]`). The first entry is always `operator.safeLook` ("Basic lights").
  - `OperatorLayout.quickLooks: { look: string; tab: QuickTab }[]` (default `[]`).
  - `export type QuickTab = 'plain' | 'colours' | 'effects'` (zod enum `QuickTab`).
  - `checkReferences` reports unknown look ids in `runningOrder` and `quickLooks`.
- Produces (protocol):
  - `livePresetId(group: string, colour: string): string` returns `` `live:${group}:${colour.toLowerCase()}` ``.
  - `parseLivePreset(id: string): { group: string; colour: string } | null`.
- Produces (`runningorder.ts`). All functions return a new `Show` and never mutate their input. They throw `Error` with a plain message for bad input.
  - `interface Stage { groups: Record<string, string | null>; levels: Record<string, number> }`. These are preset ids (possibly live ids) and level targets, the same shape as `RuntimeState`'s fields.
  - `ensureRunningOrder(show: Show): Show`
  - `saveItem(show: Show, lookId: string, stage: Stage): Show`
  - `addSong(show: Show, afterId: string, stage: Stage): { show: Show; id: string }`
  - `renameItem(show: Show, id: string, name: string): Show`
  - `deleteItem(show: Show, id: string): Show`
  - `moveItem(show: Show, id: string, to: number): Show`
  - `saveQuickLook(show: Show, input: { name: string; tab: QuickTab; groups: string[] }, stage: Stage): { show: Show; id: string }`
  - `cleanName(name: string): string`: trims, cuts to 40 characters, and throws `'a name is needed'` when empty.

Rules the tests pin:
- **Stage → entries:** one entry per group in `stage.groups` with a non-null preset. A live preset id becomes a new preset `{ id: <unique>, name: 'Custom', group, custom: true, layers: [{ kind: 'static', colour: <hex>, intensity: 1 }], fade: 3, swatch: <hex> }`. An existing preset id is referenced, never copied or changed. `level` = `stage.levels[group] ?? 1`.
- **`ensureRunningOrder`:** does nothing if `runningOrder` is non-empty. Otherwise:
  - Basic lights is the existing `safeLook`, renamed "Basic lights". If there is none, it's a new look "Basic lights" with no entries (the engine then uses its built-in safe light), and it becomes `safeLook`.
  - Then come new looks "Song 1" to "Song 5", copying the look named "Worship" (else Basic lights); "Sermon" copying the look named "Sermon" (else Basic lights); and "Midweek calm" copying "Prayer" (else Basic lights). These are new looks with new ids; the originals stay.
  - Every look that existed before (except the safe look) becomes a quick look on tab `colours`, except one named "All white", which goes on `plain`.
- **`addSong`:** the new look is named "Song N", where N = 1 + the number of running-order names matching `/^Song \d+$/`. It holds the stage and is inserted right after `afterId` (or at the end if `afterId` isn't in the list).
- **`deleteItem`:** refuses `safeLook` (`'Basic lights can't be deleted'`). It removes the look from `runningOrder` and from `show.looks` unless a quick look uses it.
- **`moveItem`:** `to` is clamped to `1..runningOrder.length-1`. It refuses `safeLook` (`'Basic lights stays first'`).
- **`saveItem`:** replaces the look's `groups` with the stage entries and keeps its id, name and place.
- **`saveQuickLook`:** only the listed groups get entries. `groups` must not be empty (`'pick at least one group'`). The quick look is appended to `quickLooks` with the tab.
- Generated ids are slugs of the name, made unique with `-2`, `-3`, … (reuse the slug style of `slugKey` in `server/src/app.ts`; write a local helper).

- [ ] **Step 1: Write the failing tests** in `packages/shared/test/runningorder.test.ts`, using `shows/stage-l1.json` (via `parseShow`) and `server/seed/demo-show.json`:

```ts
test('the stage L1 show gets a running order with Basic lights first', () => {
  const s = ensureRunningOrder(rig());
  const names = s.operator.runningOrder.map((id) => s.looks.find((l) => l.id === id)!.name);
  assert.deepEqual(names, ['Basic lights', 'Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5', 'Sermon', 'Midweek calm']);
  assert.equal(s.operator.runningOrder[0], s.operator.safeLook);
  assert.ok(s.operator.quickLooks.some((q) => q.tab === 'plain' && s.looks.find((l) => l.id === q.look)!.name === 'All white'));
  assert.deepEqual(ensureRunningOrder(s), s); // second run changes nothing
});
test('a show without a Safe look gets an empty Basic lights look', ...);       // demo show: safeLook set, groups []
test('Save keeps existing presets and turns an Any colour pick into a custom preset', ...);
  // stage { groups: { 'key-lights': livePresetId('key-lights', '#3A6FC8'), 'front-lights': <existing id> }, levels: { 'key-lights': 0.4 } }
  // → key entry preset is new, custom === true, swatch '#3a6fc8', level 0.4; front entry references the existing id, level 1; preset count +1
test('Save stores the targets it is given, so saving mid-fade saves where the fade is going', ...);
test('Add song puts "Song 6" after the given item, holding the stage', ...);
test('Basic lights cannot be deleted or moved', ...);   // assert.throws with the exact messages above
test('Move clamps below Basic lights; delete keeps a look a quick look still uses', ...);
test('names are trimmed, cut to 40 characters, and empty names are refused', ...);  // cleanName('  x  ') === 'x'; 50 chars → 40; '   ' throws 'a name is needed'
test('Save as quick look sets only the chosen groups and needs at least one', ...);
test('parseShow refuses a running order naming an unknown look', ...);
test('removing a look in merge drops it from the running order and quick looks', ...);
```

- [ ] **Step 2: Run the tests and see them fail.** Run: `node --test packages/shared/test/runningorder.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement the schema, protocol helpers, `runningorder.ts` and the `merge.ts` removal**, then export from `index.ts`.
- [ ] **Step 4: Run them again.** Run: `npm test` and `npm run typecheck`. Expected: all pass, including the existing merge and OFL tests.
- [ ] **Step 5: Commit** with the message "Show format: running order, quick looks, look levels and custom colours".

### Task 2: Engine: look levels, quick looks, "changed" and levels in Undo

**Files:**
- Modify: `packages/engine/src/engine.ts`, `packages/shared/src/protocol.ts`
- Test: `packages/engine/test/engine.test.ts`, `packages/engine/test/helpers.ts` (fixtures for looks with levels)

**Interfaces:**
- Consumes: `LookEntry.level` (Task 1).
- Produces:
  - Command `{ type: 'quickLook', id: string, fade?: number }`.
  - `LiveState.lookChanged: boolean`.
  - `Engine.recorded: boolean`: true when the last `apply()` added an Undo step.

Rules:
- When a look, quick look or Back to look sets a group, it also sets that group's level to `entry.level ?? 1` over the same fade time as the preset (`fade ?? this.fadeTime ?? entry.fade ?? preset.fade`). Factor this into one private `applyEntries(entries, fade, now): number` (returns the longest fade) used by `goLook`, `quickLook` and `backToLook`.
- `quickLook` sets only its listed groups and does **not** change `look` or `lastLook`. It is recorded for Undo like `look`.
- `lookChanged` is true when any group listed in the current look runs a different preset, or has a level target different from `entry.level ?? 1`. For `look === 'safe'`, compare against the safe look's entries. It's false for `blackout`, `null` or an unknown look.
- Safe (Basic lights) sets each group's level to the safe look's `entry.level ?? 1` over `SAFE_RESET`, instead of always 1, so a Basic lights saved with dimmed key lights isn't "changed" right after starting it. Master and speed still reset to 1.
- The Undo snapshot includes each group's level target, and Undo fades levels back over `UNDO_FADE`.
- `groupLevel` still doesn't create Undo steps (dimmer drags aren't undone; Back covers them).

- [ ] **Step 1: Write the failing tests** in `engine.test.ts`:

```ts
test('a look sets each group's saved level with the look's fade', ...);    // level 0.4 entry → group level target 0.4; maxStep(e, 0, 4) < 0.05
test('a 1 s look that lights a dark group and raises its level from 0 stays under 5% per frame', ...);
test('a quick look changes only its groups and keeps the current look', ...);   // state.look stays 'song-3'; lookChanged true
test('changing a level or preset marks the look changed; Back to look clears it', ...);
test('Undo after a look brings the levels back too', ...);
test('Safe uses the safe look's saved levels and is not changed right after', ...);
test('recorded is true for a look and false for a dimmer change', ...);
```

- [ ] **Step 2: Run the tests and see them fail.** Run: `node --test packages/engine/test/engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it in `engine.ts`** and add `quickLook` to `Command` and the recorded-command list in `apply()`. If the 1 s test exceeds 0.05, fade levels over `1.5 ×` the preset fade (minimum 0 when the fade is 0), and record that in Task 10's DECISIONS entry.
- [ ] **Step 4: Run the checks.** Run: `npm test`, `npm run typecheck`, `npm run jump-check -- --hours 0.2`. Expected: pass, worst step < 0.05.
- [ ] **Step 5: Commit** with the message "Engine: looks set group levels, quick looks, changed state".

### Task 3: Engine: Any colour and Flash

**Files:**
- Modify: `packages/engine/src/engine.ts`, `packages/shared/src/protocol.ts`, `tools/jump-check.ts`
- Test: `packages/engine/test/engine.test.ts`

**Interfaces:**
- Consumes: `livePresetId`, `parseLivePreset` (Task 1).
- Produces:
  - Command `{ type: 'groupColour', group: string, colour: string /* #rrggbb */, fade?: number }`. It runs preset `livePresetId(group, colour)`, compiled on the fly as one static layer at intensity 1, and is recorded for Undo like `groupPreset`.
  - Command `{ type: 'flash', groups: string[], on: boolean }`. It is not recorded and not saved in the runtime state.
  - `LiveState.flashing: string[]`: the group ids being flashed.

Rules:
- `presetFor()` resolves live ids, so `restore()` and Undo bring an Any colour pick back.
- While a group is flashed, every fixture in it outputs full white (`fromHex('#ffffff')`, intensity 1). This ignores presets, manual control, the group level and Master, but not Blackout: while `look === 'blackout'` Flash has no effect. Flash snaps on and off.
- `flash` with an unknown group returns `unknown group "<id>"`. `on: false` for a group that isn't flashing does nothing.

- [ ] **Step 1: Write the failing tests:**

```ts
test('Any colour runs a live colour on the group and Undo brings back the preset before it', ...);
test('a live colour survives a restart through runtime() and restore()', ...);
test('Flash puts the group at full white whatever the master and level, and drops back on release', ...);
  // master 0.2, group level 0.3, group running blue → while flashing, every member light has i === 1 and r = g = b (white)
test('Flash does nothing during Blackout', ...);
test('Flash is not an Undo step and is not saved in runtime()', ...);
```

- [ ] **Step 2: Run the tests and see them fail.** Run: `node --test packages/engine/test/engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Precompute a `Set` of flashed fixture indexes when `flash` changes, and check it in `frame()` before the manual, Master and gamma steps for each fixture. In `tools/jump-check.ts`, add random `quickLook` (5%) and `groupColour` (5%) commands. Leave Flash out: it snaps by design, like fades under 1 s.
- [ ] **Step 4: Run the checks.** Run: `npm test`, `npm run typecheck`, `npm run jump-check -- --hours 0.2`. Expected: pass.
- [ ] **Step 5: Commit** with the message "Engine: Any colour picks and Flash".

### Task 4: Worker snapshot and operator layout

**Files:**
- Modify: `server/src/messages.ts`, `server/src/worker.ts`, `server/src/layout.ts`
- Test: `server/test/server.test.ts`

**Interfaces:**
- Consumes: `Engine.recorded`, `Engine.runtime()`, schema fields from Task 1.
- Produces:
  - `ToWorker` adds `{ type: 'snapshot'; id: number }`. `FromWorker` adds `{ type: 'snapshot'; id: number; runtime: RuntimeState }`. The `result` message gains `recorded: boolean`.
  - `OperatorLayout` (layout.ts) gains:
    - `runningOrder: OperatorLook[]`
    - `quickLooks: (OperatorLook & { tab: QuickTab })[]`
    - `basicLights: string | null` (the safe look id)
  - `OperatorLook` gains `levels: (number | null)[]` (same order as `groups`).
  - `OperatorGroup` gains `whiteOnly: boolean`: true when no fixture in the group has a `red`, `green` or `blue` channel. Its `presets` leave out presets with `custom: true`.
  - The existing `looks` field stays for the HTTP API.

- [ ] **Step 1: Write the failing test** in `server.test.ts`:

```ts
test('the layout lists the running order, quick looks and white-only groups', ...);
  // demo show after start: layout.runningOrder[0].id === layout.basicLights; quickLooks non-empty; no custom presets listed
```

- [ ] **Step 2: Run it and see it fail.** Run: `node --test server/test/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the snapshot request and the layout fields.** Also make `App.start()` run `ensureRunningOrder` on the loaded show, saving it if it changed, so the running order exists from the first start.
- [ ] **Step 4: Run the checks.** Run: `npm test`, `npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** with the message "Server: stage snapshot and running order in the operator layout".

### Task 5: App: show-edit commands, one Undo list, Flash safety

**Files:**
- Modify: `packages/shared/src/protocol.ts`, `server/src/app.ts`
- Test: `server/test/server.test.ts`

**Interfaces:**
- Consumes: all of `runningorder.ts` (Task 1), the `snapshot` request and `recorded` (Task 4).
- Produces these commands. They are open to operators (no PIN), handled on the main thread, never sent to the worker:
  - `{ type: 'saveItem', id }`
  - `{ type: 'addSong', after }`
  - `{ type: 'renameItem', id, name }`
  - `{ type: 'deleteItem', id }`
  - `{ type: 'moveItem', id, to: number }`
  - `{ type: 'saveQuickLook', name, tab, groups: string[] }`

Rules:
- Show edits take the stage from a fresh `snapshot` request, apply the pure function, then call `setShow()`. A thrown `Error` becomes the command's error string.
- **One Undo list in `App`:** `undoLog: (Show | 'stage')[]`, at most 20 entries.
  - A stage command whose result has `recorded: true` pushes `'stage'`.
  - A show edit pushes the show as it was before.
  - `undo` pops one entry: a `Show` is restored with `setShow()`, while `'stage'` (or an empty list) is forwarded to the engine.
  - `LiveState.canUndo` as published = the engine's `canUndo` OR the list holds a `Show`.
- **Flash safety:** the App remembers which groups each WebSocket has flashing. When that socket closes, it sends `{ type: 'flash', groups, on: false }`.

- [ ] **Step 1: Write the failing tests** in `server.test.ts`, over WebSocket like the existing tests:

```ts
test('Save to an item stores the stage, then the item is no longer changed', ...);
test('Save during a fade stores where the fade is going', ...);
test('Add, rename, move and delete edit the running order, and Undo takes each back', ...);
test('Undo goes back through stage changes and show edits in the order they happened', ...);
test('deleting the item on stage leaves the stage alone and nothing breaks', ...);   // state.look unchanged; layout lacks it; a 'look' command to the first song still works
test('Flash stops when the tablet that held it disconnects', ...);                   // ws flash on → ws.close() → within 200 ms state.flashing is []
test('show edits are open to operators without the PIN', ...);
```

- [ ] **Step 2: Run them and see them fail.** Run: `node --test server/test/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it in `app.ts`.** Keep each command branch short by putting the show-edit dispatch in one private `editShow(cmd)` method.
- [ ] **Step 4: Run the checks.** Run: `npm test`, `npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** with the message "Server: save, add, rename, delete, move and quick looks, with one Undo".

### Task 6: New operator page: frame, top bar, running order, bottom bar

**Files:**
- Rewrite: `web/operator/index.html`, `web/operator/style.css`, `web/operator/app.js`

**Interfaces:**
- Consumes: `layout.runningOrder`, `layout.basicLights`, `state.look`, `lookChanged`, `lookProgress`, `lookFadeLeft`, `lastLook`, `canUndo`, `output`, `outputProblem`, `fadeTime`, `master`, and binary visualiser frames.
- Keeps from today's `app.js`: the socket connection and reconnect banner, `send()`, the Fade menu, the stage canvas drawing (`drawStage`), Blackout hold, the Wake Lock and the toast.
- Removes: look tiles, the group strip, the group preset panel, the dimmer panel and the Safe button.

Layout (spec "Layout"; sizes from the sketch):
- Grid: left column 280 px, right column the rest; rows: 44 px top bar, the rest, then a 72 px bottom bar; 8 px gaps.
- **Left column:** stage preview, 150 px tall; under it the running order. Rows are at least 44 px, with a thin colour strip built from `colours` and a separator after Basic lights.
- **Starting items:** tapping **Basic lights** sends `{ type: 'safe' }`; any other item sends `{ type: 'look', id }`. The item on stage is `state.look`, or Basic lights when `look === 'safe'`. It gets the `--raised` background, plus an amber "changed" when `lookChanged`.
- **Next ▸ \<name\>** starts the item after the one on stage. With no item on stage, it starts the first song.
- **Top bar states,** exactly as in the top-bar sketch:
  - the name, plus "changed"
  - fading: "A → B", a thin bar and the seconds left
  - "Flash: \<groups\>" while `flashing` isn't empty
  - an amber `outputProblem` message that replaces the quiet items when `output === 'lost'`
  - "Not sending to the lights (Lightkey has them)" when `output === 'off'`, with **no button**
  - ⚙ links to `/settings/`
- **Bottom bar:** horizontal Master fader (220 px), Undo (disabled unless `canUndo`), Next, Blackout (hold 1 s).

- [ ] **Step 1: Write the page.**
- [ ] **Step 2: Check it in the browser.** Run: `LIGHT_RUNNER_OUTPUT=none npm start`, open `http://localhost:<port>/operator/` at 1080 × 810, and check that:
  - tapping items changes the stage preview
  - Basic lights resets Master
  - Next follows the order
  - turning Send DMX off in Settings shows the off message with no button
  - stopping the server shows the red banner
  - the browser console shows no errors
- [ ] **Step 3: Run the tests.** Run: `npm test`. Expected: pass (no server test depends on the old page's markup).
- [ ] **Step 4: Commit** with the message "Operator page: running order, top bar and bottom bar".

### Task 7: Details rows, calm dimmers, colour picker, Save and Back

**Files:**
- Modify: `web/operator/index.html`, `style.css`, `app.js`

**Interfaces:**
- Consumes: `layout.groups` (presets, `whiteOnly`), `state.groups[g].preset` and `.level`, `lookChanged`.
- Sends:
  - `groupPreset` for a swatch
  - `groupColour` for the Any colour strip
  - `groupLevel` while dragging a dimmer
  - `backToLook`
  - `saveItem` with the item on stage (Basic lights saves into the safe look)

Behaviour (spec "Detailed UI"):
- **One row per group:** name (150 px), colour chip (190 px: square plus the preset name; "Custom" for a live colour; "Off" when no preset), dimmer bar (rest, 40 px tall), percentage (56 px).
- **Dimmer bar:** track `#111317` with a `#23262c` border, fill `#262a31`, a tint layer in the group's colour at opacity 0.14, and a 4 px handle in `#8e959f`.
- **Picker:** covers the details panel; title is the group name, then the current colour and level, then **Done**.
  - Tabs: Colours | Effects. Effects shows "Effects come later." in `--dim`.
  - Swatches in 6 columns, at least 76 px tall, at opacity 0.8.
  - An **Any colour** hue strip, 44 px, at opacity 0.55. For `whiteOnly` groups it's a warm-to-cool strip from `#ffb46b` to `#f4f8ff` instead, labelled "Any white, warm to cool".
  - Picking a swatch or dragging the strip sends right away.
- **Header:**
  - "\<item\>" title.
  - "Back to \<item\>": only visible when `lookChanged`.
  - "Save to \<item\>" with a small "hold" label. It fills over 1 s while held, sends `saveItem` when full, and cancels if released early.

- [ ] **Step 1: Write it.**
- [ ] **Step 2: Check it in the browser,** with the server as in Task 6. Check that:
  - dragging a dimmer marks "changed"
  - Back clears it
  - holding Save for 1 s clears it and survives a page reload
  - releasing Save early does nothing
  - an Any colour pick shows "Custom" and is saved
  - Front lights shows the whites
  - the browser console shows no errors
- [ ] **Step 3: Run the tests.** Run: `npm test`. Expected: pass.
- [ ] **Step 4: Commit** with the message "Operator page: group details, colour picker, Save and Back".

### Task 8: Quick looks and Save stage as quick look

**Files:**
- Modify: `web/operator/index.html`, `style.css`, `app.js`

**Interfaces:**
- Consumes: `layout.quickLooks` (with `tab`, `colours`).
- Sends: `quickLook`, `saveQuickLook`.

Behaviour:
- **Panel:** 180 px tall, with tabs Plain | Colours | Effects.
- **Grid:** 6 columns by 2 rows of buttons, each with a 4 px colour strip from `colours`. The grid scrolls vertically when a tab holds more. An empty tab shows "None yet."
- **New quick look tile:** the last tile, dashed, spanning 2 columns: "＋ Save stage as quick look". It opens a sheet over the details with:
  - **Name** (placeholder "e.g. Blue and warm")
  - **Tab** (starts on the tab being viewed)
  - **Groups it sets:** one tile per group with its colour and level, all on. Tapping toggles "left out".
  - **Cancel** and **Save** (a plain tap, not a hold).
- After Save, the tab switches to where the new quick look went. A server error, such as an empty name, shows in the toast.

- [ ] **Step 1: Write it.**
- [ ] **Step 2: Check it in the browser.** Check that:
  - a quick look changes only its groups and marks "changed"
  - saving a "Key low" quick look with only Key lights lands on the chosen tab
  - an empty name shows "a name is needed"
  - the browser console shows no errors
- [ ] **Step 3: Run the tests.** Run: `npm test`. Expected: pass.
- [ ] **Step 4: Commit** with the message "Operator page: quick looks and Save stage as quick look".

### Task 9: Running order editing and Add song

**Files:**
- Modify: `web/operator/index.html`, `style.css`, `app.js`

**Interfaces:**
- Sends: `addSong` (after the item on stage), `renameItem` (on blur or Enter), `deleteItem`, `moveItem`.

Behaviour (spec "Running order editing"):
- **Edit / Done** button in the list header.
- **While editing,** each item except Basic lights is a 48 px row: ⊖ (tap turns it into a red "Delete"; a second tap sends), the name as a text field, and a ≡ handle you drag to reorder (sends `moveItem` on release). Basic lights shows as a dashed row with "always first".
- **Tapping a row never starts it while editing.**
- **＋ Add song** at the bottom of the list, in and out of edit mode.
- The list scrolls when it doesn't fit.

- [ ] **Step 1: Write it.**
- [ ] **Step 2: Check it in the browser.** Check that:
  - in edit mode nothing reaches the stage
  - renaming to blank keeps the old name and shows the error toast
  - delete needs two taps
  - drag reorders and survives a reload
  - Undo takes back an add or delete
  - with two browser windows open, one deleting the item the other has on stage leaves the other working
- [ ] **Step 3: Run the tests.** Run: `npm test`. Expected: pass.
- [ ] **Step 4: Commit** with the message "Operator page: edit the running order".

### Task 10: Flash buttons, docs and final checks

**Files:**
- Modify: `web/operator/index.html`, `style.css`, `app.js`, `docs/STATUS.md`, `docs/DECISIONS.md`, `CLAUDE.md` (the operator page line, if it changes)

**Interfaces:**
- Sends: `{ type: 'flash', groups, on: true }` on pointerdown and `on: false` on pointerup, pointercancel and pointerleave.

Behaviour:
- In the bottom bar, after Master: "Flash", then **All**, then one button per operator group with a short label. A button is 58 px wide.
- **Labels:** the group name's first word, unless two groups would share it, in which case use the full name cut to 6 characters. For stage L1 that gives Front, Key, Back, Drum, B8.
- While held, a button turns `#3a4352` with a `#8e959f` border and white text.
- Use pointer capture so dragging off a button doesn't leave a flash on.

Docs:
- **STATUS:** move "Record look / edit colours" to Built (as the new operator page), and update the Operator page row and the test count. Remove the open question on dimmer levels, which is now answered.
- **DECISIONS (2026-10-19):**
  - Basic lights replaces Safe.
  - Looks remember group levels.
  - Save is a hold, with no PIN.
  - Unsaved changes are dropped when another item is started.
  - Quick looks set only their groups.
  - Flash is white and ignores Master but not Blackout.
  - Take over stays in Settings.
  - The level-fade length, if Task 2 changed it.

- [ ] **Step 1: Write the Flash buttons.**
- [ ] **Step 2: Check them in the browser.** Check that:
  - holding Key flashes only the key lights white in the stage preview, and the top bar says "Flash: Key"
  - releasing drops back
  - closing the tab mid-hold ends the flash (Review Focus 1)
  - the browser console shows no errors
- [ ] **Step 3: Update the docs.**
- [ ] **Step 4: Run every check.** Run: `npm test`, `npm run typecheck`, `npm run jump-check -- --hours 0.5`. Expected: all pass, worst step < 0.05.
- [ ] **Step 5: Commit** with the message "Operator page: Flash buttons; docs for the new page".
