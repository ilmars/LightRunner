# Light Runner: Implementation Plan

Based on the spec of Oct 17, 2026. Written Oct 18, 2026.

This plan turns the spec into a build order, a code layout and concrete tasks, and flags the places where the spec is ambiguous or will be hard to meet as written. Section 1 lists those issues first, because several of them change the engine design and are cheaper to settle before any code exists.

---

## 1. Spec issues to resolve before or during Phase 1

| # | Issue | Why it matters | Proposed resolution |
|---|---|---|---|
| 1 | **Phase 1 has no operator page.** The volunteer UI arrives in Phase 3, but "each phase is usable in a real service". | Without a page, Phase 1 cannot be used on a Sunday. | Ship a bare operator page in Phase 1 (look buttons, Safe, Blackout, master). Phase 3 becomes the polished version. |
| 2 | **Wake Lock needs HTTPS.** iPad Safari only exposes the Wake Lock API in a secure context, and `http://192.168.x.x` is not one. | The tablet would dim and lock mid-service. | Primary fix: set the church iPad's Auto-Lock to Never and use Guided Access. Also call Wake Lock when it's available. Optionally serve HTTPS with a local CA (mkcert) installed on the tablets. |
| 3 | **Fixtures in several groups.** "Most recent change wins" is a per-fixture rule, but fades are defined per group. | If group B takes a shared fixture from group A, that fixture would snap unless ownership also fades. | Track an owner per fixture and crossfade ownership over the fade time of the change that took it. Build this into the Phase 1 engine. |
| 4 | **Fade stack limit of 3.** If a 4th preset arrives while 3 are still active, dropping one with real weight causes a jump. | This breaks the 5% rule when someone taps quickly. | Drop entries only when their weight falls below 1%, and set a hard safety cap of 8. With the drop rule doing the work, "3" is only the typical case. Test with rapid taps. |
| 5 | **The "no jump above 5%" test is undefined for moving effects.** A chase or sparkle steps by more than 5% on its own. | The acceptance test can't pass as written. | Measure the extra jump the fade adds: `|Δout| − max(|ΔA|, |ΔB|)` per fixture per frame must stay ≤ 5%. Static-to-static uses the raw delta. |
| 6 | **"Changed" badge for groups a look doesn't list.** It's unclear whether an unlisted group counts as changed, or what Back to look does with it. | Operators will see inconsistent badges. | An unlisted group is never "changed". Back to look leaves unlisted groups alone and clears manual everywhere. |
| 7 | **Restart restores "last look", but groups can differ from the look.** | After a crash the stage would visibly change. | Persist and restore each group's active preset, plus master and speed. |
| 8 | **Backups are scheduled for Phase 4, but the corrupt-file rule applies from day one.** | A bad write in Phase 1 could lose the show. | Use atomic writes (temp file + rename) and the 20-backup ring from Phase 1. |
| 9 | **Preset format changes.** The example JSON uses flat fields (`effect`, `speed`), but the data model uses a layer stack. | Shows saved in Phase 2 would need migrating. | Store presets as a layer stack from Phase 2 onward (one layer), and add `schemaVersion` with migrations from Phase 1. |
| 10 | **iPad layout budget.** Status bar, mini visualiser, 12 buttons of 120×90, group strip, two dials and a bottom row must fit with no scrolling. | On a 1080×810 iPad this is tight. | Build an HTML mock at real size in Phase 1 week 1 and check it in a dark room before building Phase 3. |
| 11 | **macOS timer throttling.** App Nap and timer coalescing can delay a background Node process. | This risks the ±3 ms timing target on a Mac server. | Set `ProcessType=Interactive` in the launchd plist, keep `pmset` sleep off, and measure with the timing probe. |

---

## 2. Architecture decisions

| Area | Decision | Reason |
|---|---|---|
| Language | TypeScript throughout. The server runs `.ts` directly through Node's built-in type stripping (current LTS), so there is no build step on the Pi. | Types catch schema and command mistakes without adding tooling to deploy. |
| Engine | A **pure package** (`packages/engine`) with no I/O, no timers and no Node APIs. It runs as `render(state, now) → frame`. | It runs unchanged in the worker, in tests, in the soak test, for blind preview and for library thumbnails. |
| Threads | The main thread handles HTTP, WebSocket, OSC, MIDI and persistence. A worker thread holds the engine, the frame clock and DMX output. They communicate through `postMessage` only. | A slow web request can never delay a DMX frame. |
| Frame clock | `performance.now()`, drift-corrected `setTimeout` scheduling with a short spin for the last ~1 ms, and the target computed from the start time (not from the previous frame). | This meets ±3 ms on a Pi and a Mac without busy-looping a core. |
| Output | Art-Net `ArtDmx` packets written by hand over `dgram` (about 40 lines, no dependency). ENTTEC DMX USB Pro uses `serialport` (label 6 packets). | Both are small and well documented. Open DMX/FTDI boxes aren't supported in v1 because they need precise break timing. |
| Web | Vite + React. There are two entry points (operator and programmer) and a shared `Visualiser` component on a canvas. | One component library, and the visualiser is written once. |
| HTTP | Fastify, with WebSocket through `@fastify/websocket`. | Small, fast, and schema validation is built in. |
| Validation | `zod` schemas for the show file, commands and API bodies, shared by server and web. | One source of truth for the data model. |
| OSC | `osc` (osc.js) on UDP 8000. | Mature library. |
| MIDI | `@julusian/midi` (a maintained fork of node-midi) with a 1 s port poll for hot-plug. | `easymidi` wraps an unmaintained native module and node-midi has no hot-plug events. |
| Auth | PIN hashed with `crypto.scrypt`. An HttpOnly session cookie carries the programmer role. PIN attempts are rate-limited. | No dependencies, and enough security for a LAN. |
| Persistence | `show.json` for the programmer's data and `runtime.json` for live state (at most one write per second). Both use atomic writes, with `backups/` holding a ring of 20. | Matches the reliability table. |

### Data flow

```
 Operator / Programmer browsers ─┐
 Companion (HTTP)  ──────────────┤
 OSC (UDP 8000)    ──────────────┼──► Command bus (main thread) ──► role check ──► Engine worker
 MIDI controllers  ──────────────┘          ▲                                       │
                                            │ state snapshots (on change)           │ DMX frames
                                            │ visual frames (≈25 fps, binary)       ▼
                      WebSocket broadcast ◄─┴──────────────────────────────── Art-Net / USB DMX
```

Every input becomes the same typed `Command` (`{type:'look', id, fade?}`, `{type:'groupPreset', group, preset}`, `{type:'manual', target, colour, intensity}`, …), so the tablet, Companion, OSC and the APC always agree.

### Engine core (the part that gets the most tests)

Each group keeps this runtime state:

```ts
GroupRuntime {
  stack: Entry[]          // newest last; each Entry = { preset, layerPhases, weight, fadeFrom[], fadeStart, fadeDur }
  manual?: { colour, intensity, smoothed, weight, releasing }
  level: Smoothed         // 200 ms slew
}
```

- **Weights.** When a new entry is pushed, the current weight of every existing entry is snapshotted as `w0`. During the fade, the old entries have weight `w0 × (1 − e(p))` and the new one has `e(p)`, with `e(p) = 3p² − 2p³`. The weights always sum to 1, so an interruption mid-fade continues smoothly from what is on stage. An entry is dropped when its weight falls below 1%, and the rest are renormalised (a jump of at most 1%).
- **Phase.** Each entry keeps its own phase per layer, advanced every frame by `cpm/60 × speedMul × dt`. The speed dial changes the rate, never the phase.
- **Per-fixture render.** The stack is evaluated bottom-up into `{rgbw unit colour, intensity}`. Colour and intensity are blended separately by weight.
- **Ownership** (issue 3). Each fixture keeps a small owner crossfade, so a change of owning group fades the same way a preset change does.
- **Manual.** The target follows the finger through a 0.2 s one-pole filter. Engaging manual ramps its weight 0→1 over 0.2 s, and Release ramps 1→0 over 1 s, onto whatever preset is running at that moment.
- **Post stage.** Group level, then master (both slewed over 200 ms), then gamma 2.2 per fixture, then the profile channel map (RGBW/RGBA, white and amber mapping, dimmer channel), then 8- or 16-bit quantisation.
- **Safe and Blackout** are built-in looks with 1 s fades that also send `clearManual` and (for Safe) `resetMasterSpeed`.

---

## 3. Repository layout

```
light-runner/
  packages/
    shared/        zod schemas (show, commands, state), types, constants
    engine/        waveforms, layers, blend modes, effects, group runtime, pipeline, profile mapping
  server/
    src/main.ts            boot, config, process wiring
    src/worker/engine-worker.ts   clock, engine instance, blind instance, output
    src/output/artnet.ts, enttec.ts, index.ts   (retry every 1 s, "Output lost" status)
    src/bus.ts             command bus + role checks
    src/store/             show + runtime persistence, backups, migrations
    src/api/http.ts, ws.ts, osc.ts
    src/midi/              device manager, profiles (apc-mini-mk1/mk2, launchpad), MIDI learn, soft takeover
    src/auth.ts
  web/
    src/operator/          volunteer page
    src/programmer/        7 tabs
    src/components/Visualiser/
  fixtures/                built-in profiles + OFL import mapper
  library/                 starter effect library (JSON)
  tools/
    timing-probe.ts        frame-interval histogram
    jump-check.ts          headless random-transition test (issue 5 metric)
    soak.ts                8 h random look changes, memory + timing log
  deploy/
    launchd/ systemd/ SETUP.md   (sleep off, static IP, node hold-last-frame, dedicated router)
```

---

## 4. Build phases and tasks

The spec's phases stay as they are. Phase 0 is new and is short groundwork. Each phase ends with the spec's acceptance checks plus the automated tests listed.

### Phase 0: Foundations

- Answer the open questions that block Phase 1 (see section 6).
- Monorepo scaffold, lint, test runner (Vitest), CI script.
- Zod schemas for the whole show document, including `schemaVersion`.
- Worker thread with the frame clock and Art-Net output of a test pattern. Run `timing-probe` on the actual server hardware for 1 hour **now**, so timing risk is found early.
- HTML layout mock of the operator page at iPad size (issue 10).

### Phase 1: Static looks with fades

**Engine**
- Fixture profiles (built-in list for the church's rig) and the channel mapping for RGB, RGBW and RGBA, with dimmer and 16-bit support.
- Group runtime with the weighted fade stack, interruption, ownership crossfade and manual override.
- Static presets, looks (per-group fade override), and Safe and Blackout as built-in looks.
- Master and group level slewing, and gamma.

**Server**
- Command bus, WebSocket state broadcast (100 ms target), and binary visual frames.
- Show store with atomic writes, backups and migrations. Runtime store with per-group restore (issue 7).
- Art-Net and ENTTEC output with retry and status.
- PIN auth.
- launchd and systemd units, and the setup guide.

**Web**
- Programmer: Patch (address overlap warning), Groups (ordered, drag to sort), Palettes, Group presets (static), Looks, Manual, Settings (output, PIN, backup and restore).
- Basic visualiser: grid, drag fixtures, live mode.
- Bare operator page (issue 1).

**Tests**
- Unit tests for the fade maths, interrupt continuity and ownership handover.
- `jump-check` covering static looks, rapid taps, manual engage and release, Safe and Blackout.
- Restart test: kill the process, check that output is restored within 5 s.

**Acceptance** is the spec's three checks, plus a run on real fixtures in the church.

### Phase 2: Effects engine

- Build the waveform and layer evaluator now (single layer) and implement the six effects as layer presets: Static, Colour fade (palette-position saw), Breathe (intensity sine), Wave (spread across group order), Chase (square with duty and width, step fade), and Sparkle (seeded random per fixture). Phase 2b is then UI and stacking, not an engine rewrite.
- Global speed multiplier as a phase rate.
- Blind mode: a second engine instance in the worker that renders the visualiser only, with Go committing the change to the live engine.
- Programmer UI: effect parameters on presets, plus Live/Blind switch.
- **Tests:** `jump-check` across every pair of the six effects (36 pairs × interruption at 0.25, 0.5 and 0.75), a speed-dial sweep, and a 1 h `timing-probe`.

### Phase 2b: Layered effect library

- Stack of up to 8 layers, the five blend modes (Replace, Add, Multiply, Highest wins, Mask), opacity, mute and solo.
- Full building blocks: 7 waveforms, the targets (intensity, hue, saturation, palette position, white or amber), range, spread directions (including centre out, outside in, random order), grouping (blocks, wings, nth) and timing (duty, per-fixture delay, fade in and out).
- Library store: tags, copy-on-use, `linked` flag, JSON import and export.
- Thumbnails rendered by the engine package in the browser on a small canvas.
- Layer editor: reorder, waveform graph, live Blind preview.
- Starter library of about 30 entries. Golden tests prove the six core entries reproduce Phase 2 output frame-for-frame.
- **Tests:** a 4-layer to 4-layer `jump-check`, timing with 30 fixtures × 8 layers on the Pi, and a check that editing a library entry leaves copied presets unchanged.

### Phase 3: Volunteer page

- The full layout from the spec: status bar, mini visualiser (tap a group's area to select it), look grid with section labels and fade progress fill, group strip with "changed" and "M" badges, group panel (presets, Manual tab, Release), dials with reset, Back to look, Safe, and a 1 s hold for Blackout.
- Operator layout tab in the programmer page.
- Reconnect banner, auto-reconnect every 2 s with a full resync, and Wake Lock (issue 2).
- Dark-theme contrast pass. The brightest element should be dim enough not to light the operator's face.
- **Tests:** a two-tablet sync latency test (< 200 ms), Wi-Fi kill, and a hallway test with a volunteer who has never seen the app, using a 5-minute briefing script that lives in `deploy/BRIEFING.md`.

### Phase 4: Integrations and polish

- HTTP API (all endpoints in the spec) restricted to private address ranges, plus OSC with the same commands.
- Companion: an example page config exported to `deploy/companion/`.
- MIDI: device manager with hot-plug, APC mini mk1 and mk2 and Launchpad profiles with pad feedback, a generic profile with MIDI learn, soft takeover, paging, and a Controllers tab in Settings.
- Whole-show export and import.
- 8-hour `soak` before the release: random looks every 10–60 s, logging heap size and frame timing. Pass means no crash, heap growth below 10% and timing within target.

---

## 5. Testing strategy (summary)

| Layer | What | How |
|---|---|---|
| Engine maths | Easing, weights, phase, blend modes, gamma, channel mapping | Vitest unit tests on the pure package |
| Transitions | The 5% rule (issue 5 metric) | `jump-check`: headless engine at 40 fps, randomised and exhaustive pair runs |
| Regression | Core effects and starter library | Golden frame snapshots |
| Timing | ±3 ms at 25 ms | `timing-probe` on the actual server hardware, histogram plus max deviation |
| Integration | Commands from WS, HTTP, OSC and MIDI give the same state | Server tests with a fake output sink |
| Reliability | Crash restore, output unplug, corrupt show file | Scripted fault-injection tests |
| Humans | 5-minute briefing | Hallway tests with real volunteers in Phases 1 and 3 |

---

## 6. Open questions, mapped to the phase they block

| Question | Blocks |
|---|---|
| Fixtures and channel modes in the rig | Phase 1 (profiles) |
| Art-Net node model or USB interface (recommend ENTTEC DMX USB Pro, or a node that can hold the last frame) | Phase 0 |
| Server hardware (Mac, mini PC, Pi 4 or 5) | Phase 0 (timing probe) |
| Does the church Wi-Fi isolate clients? | Phase 1 (whether a dedicated router is needed) |
| Groups and presets per group | Phase 1 (seed show) |
| Look list for a typical service | Phase 1 (operator grid) |
| Manual control for volunteers? | Phase 3 (default setting only; built either way) |
| Floor plan or stage photo | Phase 1 (visualiser background) |
| Conventional dimmers or house lights | Phase 1 (needs a dimmer-only profile; small) |
| OSC from ProPresenter or the sound desk | Phase 4 |
| Who else gets the PIN | Before go-live |
| **New:** Is a self-signed HTTPS setup on the tablets acceptable, or is Auto-Lock Never enough? | Phase 3 |
| **New:** Confirm the rules for issues 3, 4, 6 and 7 above | Phase 1 |

---

## 7. Main risks

1. **Transition smoothness.** This is the core promise. Mitigation: build the pure engine first, test it headless from Phase 1, and use the `jump-check` metric as a CI gate.
2. **Frame timing on a Mac server.** Mitigation: measure it in Phase 0, and fall back to a Pi or mini PC if the Mac can't hold ±3 ms.
3. **Tablet staying awake and connected.** Mitigation: Auto-Lock Never, a dedicated router, and reconnect with full resync.
4. **Scope.** Phase 2b (the layer library and editor) is the largest phase. It can be deferred without affecting Sunday use, because Phase 2 already covers every effect volunteers need.
