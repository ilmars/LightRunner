# Finishing colour editing: design

Date: 20 Oct 2026. Status: agreed with Ilmārs (he asked for a proposal and approved it as written), not built yet.

## Why

The colour editor (colour list → Edit → tap a colour) can rename, recolour and delete a colour, but not change how bright it is or how long it fades in. Most of the show's colours (40 of 49 in stage L1) aren't stored as their own colour: they point to one of the 10 shared colours from Lightkey (the palette), so "Zils" in every group is the same blue. Recolouring one today quietly cuts it loose from the shared blue.

## What it does

All in the existing colour editor, next to name, colour strip and Delete:

1. **Brightness:** a slider, 5–100 %, for the colour's level (its layer's intensity). If the colour is on stage, the change fades in like a recolour does today. Off colours (intensity 0) have no slider.
2. **Fade:** how long a change into this colour takes: Instant, 1, 2, 3, 5 or 10 s (the preset's own fade). The operator's Fade setting in the top bar still overrides it when set.
3. **Shared colours:** when the colour points to a shared colour, the editor shows a switch **"Change it everywhere — shared colour, used by N groups"**.
   - On: a new colour or brightness changes the shared colour itself, so every colour that points to it follows (in every group).
   - Off (the default, as today): only this colour changes and it no longer points to the shared colour.
   - Brightness is per colour (layer intensity), so with the switch on only the hue/white/amber/UV of the shared colour change; brightness changes stay on this colour. *(My call: the palette holds colours, not levels.)*
   - "Used in …" lists every song and quick look the change reaches.
4. The same-name switch that already exists keeps working for name, colour, brightness and fade.

## Not in this

- A separate palette page (my call: volunteers never meet the word "palette").
- Editing effects (done in the effects editor).

## Constraints

- Every edit is a Command through `App.command()`; the server is the single source of truth.
- A lit colour that changes fades, never jumps (`npm run jump-check`).
- Design system, quiet controls, 44 px targets, plain words.
