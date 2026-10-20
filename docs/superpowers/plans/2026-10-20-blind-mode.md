# Blind mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-tablet Blind mode: the page works on a server-held draft copy of the stage (shown in the stage picture), and Go sends the whole draft to the lights in one smooth, undoable change.

**Architecture:** The engine gets an `applyStage` command that takes a whole stage (each light group's preset, level and live colour/effect, the tempo, the current look) and fades to it as one Undo step. The server keeps one draft `Engine` per WebSocket in Blind; the page wraps its draft-able commands in `{ type: 'draft', cmd }`, the server runs them on the draft and sends that tablet the draft's state and picture; `blindGo` turns the draft's runtime into one `applyStage` on the live engine. The page shows the draft instead of the stage while Blind is on.

**Tech Stack:** Node 24 (type stripping), TypeScript (erasable syntax only), zod, node:test, ws, plain HTML/JS/CSS.

**Spec:** [docs/superpowers/specs/2026-10-20-blind-mode-design.md](../specs/2026-10-20-blind-mode-design.md)

## Global Constraints

- Branch `blind-mode` from `main` (after colour editing is merged); main checkout, no worktree; don't push.
- The engine stays pure; a draft engine never sends DMX.
- Every input is a Command through `App.command()` (the draft wrapper is a command too); the server is the single source of truth.
- Master, Flash, Blackout, Next, smoke slider and Puff always act on the real stage; Go never changes smoke.
- Go fades with the existing crossfade; `npm test`, `npm run typecheck`, `npm run jump-check` pass before every commit.
- TypeScript erasable syntax only, `.ts` imports, `import type`.
- Web: design system tokens, quiet controls, 44 px targets, plain words. No Blind on the phone.

## Review Focus

1. Blind on, an effect started in the draft, then Go: the live stage fades to the same effect and it keeps the draft's pattern phase as nearly as the beat clock allows (no restart flash). Pinned in Task 1.
2. Two tablets, one in Blind: the other tablet's state and picture never show the draft. Pinned in Task 2.
3. A tablet in Blind disconnects: its draft is dropped, nothing reaches the stage. Pinned in Task 2.
4. Save to a song in Blind stores the draft, not the live stage. Pinned in Task 2.
5. Undo in Blind undoes the draft only; after Go, one Undo takes the stage back. Pinned in Tasks 1–2.

---

### Task 1: `applyStage` in the engine

**Files:** `packages/shared/src/protocol.ts`, `packages/engine/src/engine.ts`. Test: `packages/engine/test/blind.test.ts` (new).

**Interfaces — Produces:**
- Stage command `{ type: 'applyStage', stage: RuntimeState, fade?: number }` (zod for `RuntimeState`'s fields: `look`, `groups`, `levels`, `tempo?`, `effects?`, `lastLook?`; master, speed and fadeTime in it are ignored).
- Rules: one Undo step; for every **light** group in `stage.groups`, set its preset (live `live:` colours and `fx:` effects included — `stage.effects` registers the live effect layers first) with `fade ?? this.fadeTime ?? that preset's fade`, and its level over the same time × the look level factor used for looks; smoke groups are left alone; `bpm = stage.tempo ?? bpm`; the current look becomes `stage.look` (so "changed" and Next work as if that look had started), Blackout's memory is cleared; `beforeBlackout` in it is ignored. A Basic-lights stage (`look === 'safe'`) applies like Basic lights (groups without an entry go to the safe light).
- Effect phase: a new effect run started by `applyStage` starts from the stage clock as usual.
- `Engine.adoptClock(from: Engine)` (or an equivalent constructor option) sets a draft engine's stage beat and seconds clocks to another engine's, so a draft's effects run in step with the live stage. *(Pure: it copies two numbers.)*

- [ ] **Step 1: Write the failing tests** in `blind.test.ts`: `'applyStage fades every light group to the given stage as one Undo step'`; `'applyStage registers live colours and effects and leaves smoke alone'`; `'applyStage sets the tempo and the current look, so Next and changed follow it'`; `'a draft engine that adopted the clock runs effects in step with the live engine'`; `'applyStage of a Basic-lights stage acts like Basic lights'`; a jump test: applying a stage with a different effect on Background fades within ownMotion + 5 %.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run jump-check`.
- [ ] **Step 5: Commit** — "Engine: apply a whole stage in one change".

### Task 2: Drafts on the server

**Files:** `packages/shared/src/protocol.ts`, `server/src/app.ts` (a `BlindSession` per WebSocket; may live in a new `server/src/blind.ts`). Test: `server/test/blind.test.ts` (new) using the helpers in `server/test/server.test.ts` (copy what's needed).

**Interfaces — Produces:**
- Commands (WebSocket only; the HTTP API doesn't take them): `{ type: 'blindStart' }`, `{ type: 'blindEnd' }`, `{ type: 'blindGo' }`, `{ type: 'draft', cmd: StageCommand }`.
- `blindStart`: the tablet's session gets a fresh `Engine` built from the current engine show (`engineShow()`), restored from the live stage's latest runtime with no fade, with the live clock adopted (Task 1). A second `blindStart` restarts the draft.
- `draft { cmd }`: runs `cmd` on the tablet's draft engine. Refused (plain message, e.g. "That works on the real stage only.") for `master`, `flash`, `blackout`, `manual`, `release`, `releaseAll`, `speed`, and a `groupLevel` on a smoke group. `undo` inside `draft` undoes the draft's own history. Refused with "Blind is off." without a session.
- Show edits while in Blind that use the stage (`saveItem`, `addSong`, `saveQuickLook`) use **the draft's** stage (`runtime()` + live effects + tempo) instead of the live one.
- `blindGo`: one live `applyStage` with the draft's runtime (`fade` = the live engine's operator fade time, as for looks), then the session ends. Refused without a session.
- `blindEnd` and the WebSocket closing drop the session.
- While a session exists, the server sends that tablet only: `{ type: 'draftState', state: LiveState }` whenever the draft's state changes (same shape as `state`, `outputProblem` etc. copied from the live state), and the draft's visualiser frames at the live visual rate as `{ type: 'draftVisual', data: <base64 of the 3-bytes-per-segment frame> }`; the draft engine is framed on the server at that rate (it is cheap: about 35 µs a frame).
- Live `state` messages keep going to every tablet unchanged.

- [ ] **Step 1: Write the failing tests** in `server/test/blind.test.ts`: start → draft groupPreset → the tablet gets a `draftState` with the new preset while the live `state` keeps the old one; another tablet never gets `draftState`/`draftVisual`; refused commands (exact messages); Save to a song in Blind stores the draft; Go → live state shows the draft's presets, one Undo step, session ended; closing the socket drops the draft and nothing changes live; draft Undo undoes the draft only.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run jump-check`.
- [ ] **Step 5: Commit** — "Server: Blind drafts per tablet, and Go".

### Task 3: Blind on the operator page

**Files:** `web/operator/app.js`, `web/operator/index.html`, `web/operator/style.css`, `docs/STATUS.md`, `docs/DECISIONS.md`, `docs/design-system.md` (if new patterns).

**Interfaces — Consumes:** Task 2's commands and messages; the existing Preview code (`preview`, `setPreview`), `send`, `render`, `renderDetails`/`renderPicker`/`groupStatus`, `drawStage`, the tempo control, the phone layout.

- A **Blind** switch in the top bar next to Preview (`#blindBtn`, `aria-pressed`, quiet). Turning it on sends `blindStart`, turns Preview and running-order Edit off; turning it off sends `blindEnd`. Preview on turns Blind off. Blind is hidden on the phone and turned off when the phone layout starts or the connection drops (the server drops the draft itself).
- While Blind is on:
  - The top bar shows a quiet "Blind" strip (distinct from Preview's, not amber, not Flash blue) and a **Go** button (44 px, the one clear control in the bar while Blind is on, design-system accent at rest level — not bright) that sends `blindGo` and turns Blind off on success.
  - Every command the page sends for the stage goes as `{ type: 'draft', cmd }` — running-order taps (look/safe), quick looks, groupPreset, groupColour (and continues drags), groupEffect, groupLevel for light groups, backToLook, tempo, undo — **except** Master, Flash, Blackout, Next, smoke slider and Puff, which stay live.
  - Details, picker, Effects tab, tempo readout, "changed" and the running order's on-stage mark read `draftState` instead of `state` (the live on-stage item gets a quiet outline so it stays visible); the stage picture draws `draftVisual` frames with a quiet "Blind" label (dark until the first frame).
  - Save to a song works as usual (the server saves the draft).
- Docs: STATUS — Blind mode built (what it does), take it out of "Not built yet"; DECISIONS — a 20 Oct entry for the design's calls (Undo follows the page; smoke and Next stay live; per tablet).
- [ ] **Step 1: Implement.**
- [ ] **Step 2: Browser check** on http://localhost:8092 (the controller restarts the test server with Task 2's code first; don't start/stop it yourself) at 1080×810, with two pages (two tablets): Blind on page A → tap Song 3 and a Background effect → A's picture shows it, B's and the live state don't; Master on A dims the real stage; Go → the stage fades to the draft, one Undo on B takes it back; Blind on, change, Blind off → nothing changed live; Save to a song in Blind saves the draft; phone 390×844 shows no Blind; no console errors.
- [ ] **Step 3: Run** `npm test && npm run typecheck`.
- [ ] **Step 4: Commit** — "Operator page: Blind mode and Go".
