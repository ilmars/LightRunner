# Stage plan shapes: design

Date: 20 Oct 2026. Status: agreed with Ilmārs in chat (he picked outline, beam, angled bar and smoke from a list of seven, and chose a faint coloured cone for beams on the operator page); built. It builds on the stage plan editing just added (Dot, Across, Upright, resize handles, Add fixture here; see DECISIONS 2026-10-20). The spec already says fixtures appear "as coloured dots or beams" (SPEC.md, Stage visualiser).

## Why

Two things on the church's plan look least like the real stage: the drum cage strip (L1) is drawn as a straight line, and the front lights (P1–P4) are dots that don't show which way they point. Strips along a slanted truss can't be drawn at all, and a smoke machine would look like a light.

## What it does

### Shapes

The shape row under the Patch page's stage plan becomes **Dot · Beam · Bar · Outline · Smoke**. While Bar is chosen, two quiet text buttons, **Across** and **Upright**, set its angle to 0° or 90°.

| Shape | What it is | Handles on the Patch plan |
| --- | --- | --- |
| Dot | As now | None |
| Beam | A dot with a cone showing where the light points | One at the cone's tip: sets the direction and how far it reaches |
| Bar | As now, plus any angle | Ends (length), one long side (thickness), and a round turning handle just past the end |
| Outline | A rectangle with rounded corners: a strip round something | One at the bottom-right corner: width and height, evenly about the middle |
| Smoke | A small cloud mark, no colour | None |

- **Beam:** the spread is fixed at about 40° and not stored *(my call)*. A new beam points to the back of the stage (up), with a reach of about a third of the plan's height.
- **Angled bar:** the turning handle snaps to 15° steps; holding **Shift** turns freely (the Patch page is mostly used on the Mac). The bar turns about its middle, and its end and thickness handles turn with it. Its segments still run from one end to the other (segment 0 at the end that is left or top at 0°; Reversed runs them the other way).
- **Outline:** the segments run clockwise round it from the top-left corner; Reversed runs them anticlockwise. L1 has one segment, so today it lights all round in one colour. Outlines don't turn *(my call)*.
- **Smoke:** a fixture in a smoke group draws as a cloud unless it has been given another shape *(my call)*. On the operator page the cloud is faint grey and a little brighter while its group's level is above 0.

### Operator stage view

- Draws every shape from the same live colours as now.
- **Beams:** the cone glows faintly in the light's live colour, strongest at the lamp and fading to nothing at the tip (owner's choice). It follows the brightness rules in docs/design-system.md: no large bright area, so the cone's colour stays well under the 26 % tint limit at full brightness. The lamp itself is drawn as a dot, as now.
- Beams and smoke are drawn **first**, so they never cover a light.

### Storage

A fixture gets three optional fields:

- `shape`: `'dot' | 'beam' | 'bar' | 'outline' | 'smoke'`. When it is missing, the shape is worked out as today: smoke if the fixture is in a smoke group, a bar if it has a size (`w` or `h`), otherwise a dot. So Lightkey imports and existing shows draw exactly as before.
- `angle`: degrees, clockwise, 0 = pointing right. For a bar, how far it is turned from across; for a beam, the direction it points.
- `reach`: for a beam, the cone's length as a fraction of the plan's width.

`w` and `h` keep their meaning: for a bar its length and thickness (as now), for an outline its width and height.

**Proportions:** angles and lengths along an angle are measured in the Patch plan's proportions (2.4 : 1), so a slanted bar ends at the same points relative to the other fixtures in every view, even where a view is a different shape. An upright bar from before (taller than wide, no angle) keeps drawing as it does; the first time it is turned it is stored as a bar at 90°.

## Constraints

- The engine doesn't change: shapes are drawing only. The visualiser buffer stays "fixtures in show order, each fixture's segments in channel order"; only where each segment is drawn changes.
- The server sends the operator page each fixture's worked-out shape, `angle` and `reach` in the layout (`server/src/layout.ts`), so the page does not need to know the smoke-group rule.
- Compare with a file reports a change of shape, angle or reach as "changed on the stage plan" (today it says "moved on the stage plan" for x, y, w, h).
- **Shapes belong to this installation** *(my call, as a group's smoke setting already does in `merge.ts`)*: a fixture in the file with no `shape`, `angle` or `reach` (every fixture in a Lightkey project) is not reported for them, and taking it keeps ours. If ours is an outline, its size is kept too, since a Lightkey size means a line. A Light Runner file that has them is compared and taken as usual. So re-importing from Lightkey never turns a beam back into a dot.
- The church's own show (`shows/stage-l1.json`) is not changed here: the owner sets up L1 and P1–P4 in Patch *(my call: the cage's size and where each light points are his to judge)*. Lightkey's own angles for slanted items are not imported; imports draw as before.
- Nothing is kept until Save, as on the rest of the Patch page.
- Design system and quiet controls; the shape row stays one line on the iPad (1080 px wide).
- Tests: the geometry (shape rules, turning, beam aim, outline size, where each segment of an outline or turned bar is drawn) is pure and tested, as `web/patch/plan.js` is now; the schema and layout changes get server tests.

## Not included

Panels (grids of cells), paths along several points, dot sizes, background photos, turning outlines.

## Left to the builder

- How the Patch plan draws cones, outlines and turned bars (DOM, SVG or canvas), keeping the existing drag, select and add behaviour.
- The exact look of the cloud mark, the turning handle and the cone's falloff, within the brightness rules.
