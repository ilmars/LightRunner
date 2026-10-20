# Finishing colour editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The colour editor can also change a colour's brightness and fade, and change a shared (palette) colour everywhere it is used.

**Architecture:** Extend the pure `editColour` edit (packages/shared/src/presets.ts) and its command with `level`, `fade` and `shared`; the layout tells the page each colour's level, fade and shared-colour reach; the page's existing colour editor gets a Brightness slider, a Fade choice and a shared-colour switch.

**Tech Stack:** Node 24 (type stripping), TypeScript (erasable syntax only), zod, node:test, plain HTML/JS/CSS.

**Spec:** [docs/superpowers/specs/2026-10-20-colour-editing-design.md](../specs/2026-10-20-colour-editing-design.md)

## Global Constraints

- Branch `colour-editing` from `main`; main checkout, no worktree; don't push.
- Every edit is a Command through `App.command()`; the server is the single source of truth.
- A lit colour that changes fades, never jumps; `npm test`, `npm run typecheck`, `npm run jump-check` pass before every commit.
- TypeScript erasable syntax only, `.ts` imports, `import type`.
- Web: design system tokens, quiet controls, 44 px targets, plain words, sentence case.

## Review Focus

1. Shared switch on, with a colour that other groups use in songs on stage: all of them fade to the new colour; none jumps. Pinned in Task 1 (engine sees one show edit) and checked in Task 2's browser step.
2. Brightness on an Off colour, an effect preset, or a multi-layer preset: refused with a plain message. Pinned in Task 1.
3. Shared switch off on a palette colour: the colour stops pointing to the palette and the other groups don't change. Pinned in Task 1.
4. Same-name switch and shared switch both on: no preset is changed twice, and the Undo step is one. Pinned in Task 1.
5. The fade choice shows the colour's real fade, including values not in the list (e.g. 4 s from an import). Checked in Task 2.

---

### Task 1: Edits and layout

**Files:** `packages/shared/src/presets.ts`, `packages/shared/src/protocol.ts`, `server/src/layout.ts`, `server/src/app.ts` (only if the command plumbing needs it). Tests: `packages/shared/test/presets.test.ts`, `server/test/server.test.ts`.

**Interfaces — Produces:**
- `EditColour` gains `level?: number` (0.05–1, the layer's intensity), `fade?: number` (seconds, 0–600, the preset's `fade`) and `shared?: boolean`. The `editColour` command gains the same optional fields (`level: unit.min(0.05)`, `fade: seconds`, `shared: z.boolean().optional()`).
- Rules in `editColour`:
  - `level` and `colour` need `canRecolour(p)` (one lit static layer); otherwise "Off can't be given a colour; add a new colour instead." (Off) or "that colour can't be changed here". `fade` and `name` work for every non-hidden preset, effects included.
  - `shared: true` with `colour`: if the target's layer points to a palette entry, set that palette entry's `hex` (keep its white, amber, UV); every preset pointing to it follows; the target keeps pointing to it. Without a palette entry, `shared` is ignored.
  - `shared` false/absent with `colour` on a palette colour: as today (the layer becomes a plain colour keeping the palette entry's other fields).
  - `level` always changes only the presets edited (the target, plus same-name ones), never the palette.
  - Swatches: every preset whose look changed gets its swatch recomputed (`displayColour` of its resolved colour × nothing — swatches show full brightness, as today).
  - `ids` lists every preset changed, including the ones that changed through the palette; "nothing changed" stays the refusal for a no-op.
- `OperatorPreset` gains `level: number | null` (the layer's intensity for a single static layer, else null), `fade: number`, and `shared: { groups: number; usedBy: string[] } | null` (when the preset's layer points to a palette entry: how many groups have a preset pointing to it, and the union of `presetUsers` over them; else null).

- [ ] **Step 1: Write the failing tests** in `presets.test.ts`:
  - `'brightness changes only the layer intensity'` (a plain colour at 1 → 0.5: layer intensity 0.5, hex unchanged, swatch unchanged).
  - `'fade changes the preset fade, also for an effect'`.
  - `'brightness is refused for Off, effects and multi-layer presets'` (exact messages).
  - `'with shared on, a new colour changes the palette entry and every colour that points to it'` (stage-L1 "Zils": every group's Zils layer still points to the palette; the palette entry's hex is new; ids include every group's Zils).
  - `'with shared off, a palette colour is cut loose and the others stay'`.
  - `'same-name and shared together change each preset once'`.
  - In `server.test.ts`: `'the layout gives each colour its level, fade and shared reach'` (a Zils preset: `shared.groups` = number of groups with Zils; `usedBy` union) and `'an editColour with shared is one Undo step'`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run jump-check`.
- [ ] **Step 5: Commit** — "Colour edits: brightness, fade and shared colours".

### Task 2: The editor on the page

**Files:** `web/operator/app.js`, `web/operator/index.html`, `web/operator/style.css`, `docs/STATUS.md`, `docs/DECISIONS.md`.

**Interfaces — Consumes:** Task 1's command fields and `OperatorPreset.level`, `fade`, `shared`.

- In the colour editor (`openEditor` / `renderEditor` / `#pEdit`), under the colour strip:
  - **Brightness**: a `ds-fill` slider 5–100 % (hidden when `level === null`), showing the value as "N %". Moving it changes only the editor's pending value (nothing is sent until Save), like the strip.
  - **Fade**: a quiet segmented choice Instant · 1 s · 2 s · 3 s · 5 s · 10 s; a fade not in the list shows as an extra selected button with its value.
  - **Change it everywhere**: a switch, shown only when `shared` is set, labelled "Change it everywhere — shared colour, used by N groups" (N = `shared.groups`). With it on, "Used in …" lists `shared.usedBy`; with it off, the colour's own `usedBy` (and same-name ones, as today).
- **Save** sends one `editColour` with only what changed: `name`, `colour`, `level`, `fade`, `sameName`, `shared`.
- Effects' editor is unchanged (its fade isn't in this task).
- Docs: STATUS — colour editing done (brightness, fade, shared colours); remove item 3 from "Not built yet". DECISIONS — a 20 Oct entry: the palette is edited through the shared-colour switch, no separate page; brightness is per colour, not in the palette.
- [ ] **Step 1: Implement.**
- [ ] **Step 2: Browser check** on http://localhost:8092 (a test server runs there; don't start/stop it — the controller restarts it with Task 1's server code before this task): edit Background's Zils with the switch on → every group's Zils changes, "Used in" lists them all; switch off → only Background changes; brightness 50 % on a lit colour fades on stage; Fade 5 s is saved and shown when reopened; Off shows no Brightness; no console errors.
- [ ] **Step 3: Run** `npm test && npm run typecheck`.
- [ ] **Step 4: Commit** — "Colour editor: brightness, fade and change it everywhere".
