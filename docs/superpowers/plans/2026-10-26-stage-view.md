# Stage view from above and from the audience: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The stage view draws the rig more like the real stage — from above (housings, real LEDs, light pools on the floor) or from the audience (truss, beams, back-wall washes) — with a switch, real LED counts per fixture type, and where each fixture hangs.

**Architecture:** Two new optional schema fields (`Profile.leds`, `Fixture.hangs`) reach the pages in the layout message. A DOM-free module `web/shared/stageview.js` (+ `.d.ts`, tested from `server/test`) works out the LEDs of each fixture, the Hangs-on guess, and the geometry of pools, beams and washes for both views. `web/shared/stagedraw.js` draws view A and view B on the existing canvas from the live per-segment colours; the operator and Timeline pages get the switch. Patch gets the two fields.

**Tech stack:** plain JS ESM pages, canvas 2D, TypeScript server, zod, node:test.

**Spec:** [docs/superpowers/specs/2026-10-26-stage-view-design.md](../specs/2026-10-26-stage-view-design.md) (read "Calls made…"). Mockup: `.superpowers/brainstorm/9976-1793038375/content/stage-view.html`.

## Global constraints

- Branch `stage-view` (on top of the unmerged `timeline` branch; main checkout, no worktree). New commits only; never push or tag.
- 2D only; dim overall (nothing bright enough to light the operator's face); the live colours on a near-black stage; design-system tokens for the UI around it; 44 px targets for the switch.
- A frame of the larger view draws in well under the 50 ms picture interval on an iPad-class device (measure on a laptop with CPU throttling ×4 in devtools if available: under 15 ms).
- Honest LEDs: without a type's `leds`, one LED per segment.
- `npm test`, `npm run typecheck`, `npm run jump-check` pass before every commit. Every process an implementer starts is stopped before it reports; no sound plays; `node --check` every .js; never touch ports 8080/8089 or the owner's installed Light Runner; leave untracked `.claude/launch.json`, `.claude/preview.env`, `tools/worshiptools*.ts` alone.

## Review focus

1. A show where no fixture has Hangs on or LEDs (every existing show): both views still draw sensibly (the guess; one LED per segment). (Task 1 test.)
2. A bar with more segments than LEDs given (e.g. leds 4 on 8 segments), or leds not a multiple of segments: no crash, every segment shown, LEDs spread with the remainder to the first segments. (Task 1 test.)
3. The view at the operator page's small size (about 300 × 124) and at 1600 px wide: nothing overlaps badly, view B fits the height. (Task 2 browser check.)
4. A fixture rotated or a beam with a long reach near the plan's edge: pools and beams are clipped to the view, never drawn outside the canvas. (Task 2.)
5. Smoke groups and the drum-cage outline still draw (smoke clouds unchanged). (Task 2.)

---

### Task 1: The data and the pure geometry

**Files:** Modify `packages/shared/src/schema.ts` (`Profile.leds?: z.number().int().min(1).max(512)`, `Fixture.hangs?: z.enum(['truss','wall','riser','stand','side'])`), `server/src/layout.ts` (carry `leds` per fixture via its profile and `hangs` per fixture in the layout), `shows/stage-l1.json` (leds: SixBar 500 → 6, SonicPulse LED Bar 10 → 24, SonicPulse LED Bar 05 → 12; hangs: P1–P4 stand, B1–B2 truss, B3–B6 wall, L1 riser, B8 side). Create `web/shared/stageview.js` + `stageview.d.ts`; test `server/test/stageview.test.ts`.

**Interfaces — Produces** (`stageview.js`): `ledLayout(segments: number, leds?: number): number[]` (segment index of each LED, spread evenly, remainder to the first segments; `[0,1,…]` without leds); `hangsOf(fixture): 'truss'|'wall'|'riser'|'stand'|'side'` (the field, else the guess: outline/strip → riser; beam → truss; smoke → wall; upright bar (h > w) → side; y < 0.3 → wall; bar with 0.3 ≤ y ≤ 0.6 → wall; y > 0.75 → stand; else truss); `poolOf(fixture, hangs, view: 'above')` and front-view placement helpers as the drawing needs (`frontPlacement(fixture, hangs, w, h) → {x, y, ...}`), all in plain numbers so they're testable.

- [ ] Tests first (RF 1, 2): ledLayout cases (6/3 → [0,0,1,1,2,2]; 24/8; 12/4; 4/8 → every segment once? — rule: when leds < segments, draw one LED per segment (ignore leds)); hangsOf for every church fixture without the field equals the explicit values given, plus the generic cases; layout carries leds/hangs; parseShow accepts old shows.
- [ ] Implement; checks; commit "Stage view: real LED counts and where each light hangs".

### Task 2: Drawing view A and view B, and the switch

**Files:** Modify `web/shared/stagedraw.js` (both views; keep today's call signature, add a `view` option), `web/operator/app.js` + `index.html` + `style.css` (the switch on the stage view, incl. the Prepare view; `localStorage` key `lr-stage-view`, try/catch), `web/timeline/timeline.js` + `index.html` + `style.css` (the same switch; the stage view may grow to the panel width outside the sticky Prepare mode).

- View A per the spec goal 2 and calls 3–4: housings at plan size/angle, LEDs from `ledLayout` in their segment's colour with a small glow, pools on the floor with additive blending in the direction of hangs/beam, panels (one segment, leds ≥ 16) as a LED-textured face, no leds → one lamp; outlines/strips glowing; smoke as today.
- View B per goal 3: truss across the top with hanging fixtures and soft downward beams + floor pools; back-wall floor bars washing the wall upward (soft, not spiky — see the mockup's final version); riser strip and riser box; stand lights at the front with a floor glow; side bars upright with their LEDs vertical; everything clipped to the canvas.
- **Resizable preview card** (owner, 26 Oct): the stage view card gets a quiet grip (44 px touch target) at its bottom edge (operator page: taller/shorter, the running order below gives way, within a minimum of today's height and a maximum that keeps the running order at least 3 rows; phone: unchanged) and at its bottom-right corner on the Timeline page (width and height, within its panel). The size is remembered per browser (`lr-stage-size`, try/catch); a double-tap/double-click on the grip resets it. The canvas redraws at the new size (device-pixel-ratio aware).
- Performance: cache static parts (floor, truss, wall, housings) in an offscreen canvas per size/view, redraw only lights per frame; measure and report a frame time.
- [ ] Browser check on your own server (`LIGHT_RUNNER_OUTPUT=none`, scratch data folder, port 8097, the church show; set looks via the API or operator page): both views at the operator size, in Prepare, on the Timeline page, at 1600 px; a show with no hangs/leds (the demo show) in both views; screenshots `shots/stage-view-*.png` (use headless Chrome `--screenshot` or the browser tools). Commit "Stage view: from above and from the audience, with a switch".

### Task 3: Patch fields and docs

**Files:** `web/patch/patch.js`, `index.html`, `style.css` (Hangs on: a select on the stage plan's selected fixture and/or the Fixtures table — your call; LEDs: a number field in the fixture type editor with a hint "how many LEDs the light really has (spread over its segments)"; read-only types show it), `docs/setting-up-a-show.md` (the stage plan step: Hangs on; the fixture type: LEDs; the operator page: the view switch), `docs/STATUS.md`, `docs/DECISIONS.md`, README (one line).

- [ ] Browser check (Hangs on changes view B at once after Save patch; LEDs changes the drawn LEDs); checks; commit "Patch: where a light hangs and how many LEDs it has" and "Docs: the stage view".
