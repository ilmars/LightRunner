# Stage view, from above and from the audience: design

Date: 26 Oct 2026. Status: agreed with Ilmārs (26 Oct), from mockups (`.superpowers/brainstorm/9976-1793038375/content/stage-view.html`, rendered as `stage-view-mockups-2.png` in the session scratchpad).

## Why

The stage view (the live picture on the operator page, in Prepare and on the Timeline page) is drawn today as simple dots, bars and cones on the stage plan. The owner wants it to look more like the real stage, as in lighting-planner apps he has seen, but kept simple: 2D, no 3D, in the same drawing style. "If a bar has 9 LEDs, keep it" — the drawing must show the real LEDs.

He liked option A (from above) and asked for both A and B (from the audience), switchable.

## Goals

1. **A switch on the stage view**: **From above / From the audience**, a quiet control on the stage view itself, wherever it is shown (operator page, its Prepare draft view, the Timeline page's stage view). Each device remembers its own choice (per-browser, `localStorage`, wrapped so it never breaks the page); the default is From above.
2. **A — From above** (the stage plan as arranged in Patch):
   - the stage floor dark, with a faint back-wall band at the top;
   - each fixture drawn as its **housing** (a dark body at its plan size and angle) with its **real LEDs** lit in their segment's colour, a soft glow around lit LEDs;
   - the light **falls on the floor as soft pools** in its colour, added together where they overlap (additive blending), in the direction the fixture points (a beam's angle; bars and dots straight down/forward as today's shapes imply);
   - panels (a light with one segment and no bar shape) as a small grid of LEDs; strips/outlines as a glowing line; smoke as today.
3. **B — From the audience** (a front view of the same stage):
   - left-to-right position from the stage plan's x;
   - each fixture's **Hangs on** (new, set in Patch): **Truss** (hangs from a truss drawn across the top; shines down through the haze as a soft beam with a pool on the floor), **Back-wall floor** (stands at the foot of the back wall; washes the wall upwards as a soft glow), **Riser** (on a low riser in front of the back wall, e.g. the drum cage's strip around it), **Stand** (on a stand at the front, facing the stage; a glow on the floor in front of it), **Side** (an upright bar at the side, its LEDs one above the other);
   - a fixture with no Hangs on yet gets a guess from the plan: near the back (plan y < 0.3) → Back-wall floor; a bar between 0.3 and 0.6 → Back-wall floor; an upright bar (taller than wide on the plan) → Side; near the front (y > 0.75) → Stand; otherwise Truss;
   - the beams and washes are flat, soft shapes (gradients), never 3D.
4. **The real LED count**: a fixture type gets an optional **LEDs** number (in the fixture type editor in Patch, with the channel list): how many LEDs the light really has. They are spread evenly over its segments (LEDs ÷ segments per segment, the remainder to the first segments). Without it, one LED per segment is drawn. The church's types get their real counts: SixBar 500 **6** (3 segments × 2), SonicPulse LED Bar 10 **24** (8 × 3), SonicPulse LED Bar 05 **12** (4 × 3) — set in `shows/stage-l1.json` and offered when the type is made from the Open Fixture Library if it says (else empty).
5. Both views draw from the same live data the stage view uses today (the engine's per-segment colours) and keep up with its updates (20 fps pictures) on an iPad without slowing the page.

## Non-goals

- 3D, perspective, moving heads' pan/tilt, gobos, people on stage, a picture of the real church.
- Changing the stage plan editor in Patch (beyond the Hangs on field), or Individual lights' picker (it stays the plan picture as today).
- Photorealism: the look stays the design system's dark, quiet style; nothing in the view may be bright enough to light the operator's face (the design system's brightness rules apply to the drawing too — keep the whole picture dim, the lit parts glow but don't flare).

## Anti-goals

- A view that is slower or heavier than today's on the iPad (measure: a frame of the larger view must draw well under the picture interval).
- A wrong LED count shown with confidence: when a type has no LEDs number, draw one per segment (honest), never a made-up number.
- A setting volunteers must touch: Hangs on and LEDs are Patch (programmer) settings; the view switch is the only control on the operator page.

## Constraints

- The drawing lives in `web/shared/stagedraw.js` (moved there on the timeline branch); pure helpers (LED layout per fixture, the Hangs on guess, pool/beam geometry) go in a DOM-free module tested from `server/test` like `stage.js`.
- Schema: `Profile.leds?: number` (1–512, whole) and `Fixture.hangs?: 'truss' | 'wall' | 'riser' | 'stand' | 'side'` — optional, no schema version bump; the layout message carries them to the pages.
- Design system tokens for the surrounding UI; the drawing itself uses the light's own colours on a near-black stage.
- `npm test`, `npm run typecheck`, `npm run jump-check` pass.

## Calls made while writing this up (not the owner's; check them)

1. **LED counts are the real ones** (looked up, owner's rule "keep the real LEDs"): SixBar 500 6, SonicPulse Bar 10 24, Bar 05 12. The mockup drew 8 and 4 (one per segment); the built view is denser on those bars.
2. **The church show gets explicit Hangs on** in `shows/stage-l1.json`: P1–P4 Stand, B1–B2 Truss, B3–B6 Back-wall floor, L1 Riser, B8 Side (as in the mockup). The guess for fixtures without one is extended: a strip/outline → Riser, a beam → Truss, smoke → Back-wall floor; then the rules in goal 3.
3. **View A uses Hangs on too** (or its guess) for where a light's pool falls: a truss light's pool lies a little downstage of it, a stand light throws its pool upstage (towards the back), a back-wall bar's pool hugs the wall, a riser strip glows round itself, a side bar's pool lies beside it; a beam keeps its own angle and reach.
4. **Panels:** a one-segment light whose type has LEDs ≥ 16 is drawn as a panel face with a fine LED texture (the number is real, the texture is just its look); a light with no LEDs number is drawn as one lamp (honest). The church's front-light type has no number until the owner types one.
5. **Sizes:** the operator page keeps its stage box; view B is laid out to fit any height (truss, wall and floor scale with the box). The Timeline page's stage view may grow to its panel's width (keeping the plan's proportions) when not in the small sticky Prepare mode.
6. **The switch** is one per browser (`lr-stage-view`), shared by the operator and Timeline pages; the Timeline's own Hide/Show key stays separate.

## Left to the builder

- The exact look of housings, LEDs, pools, beams, truss and wall within the mockup's style; the toggle's placement on each view; how far pools reach; how the view scales from the operator page's small view to the Timeline page's larger one.
- Whether Patch shows Hangs on in the Fixtures table, on the stage plan's selected fixture, or both.
