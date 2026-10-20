# Blind mode: design

Date: 20 Oct 2026. Status: agreed with Ilmārs (he asked for a proposal and approved it as written), not built yet. This is the spec's Blind (docs/SPEC.md: "previews a look, preset or manual change in the visualiser only, without sending it to the lights, until you press Go"), next to the Preview mode that is already built.

## Why

Preview changes a **saved song** without touching the lights. Blind is for the other case: getting the **next moment ready on the live stage**, out of sight, then sending it all at once — during a service or a rehearsal, while the lights keep doing what they're doing.

## What it does

- **Blind** sits in the top bar next to Preview. Only one of the two is on at a time; running-order Edit turns both off.
- **Turning Blind on** makes a draft copy of what's on stage now (every group's colour or effect and level, the tempo, the current song). Everything on the page then works on the draft: quick looks, colours, Any colour, White/Amber/UV, effects and their settings, dimmers, starting a song from the running order (it goes into the draft), Basic lights, the tempo control.
- **The stage picture shows the draft**, moving if it has effects, with a quiet "Blind" label. The real lights keep doing what they were doing.
- **Go** (a clear button in the top bar while Blind is on) sends the whole draft to the lights in one smooth change, using the operator's Fade setting (each look's own fade when it is Auto), and leaves Blind. Undo takes it back in one step.
- **Save to a song** in Blind keeps the draft in that song without ever sending it (the same as Save live, but from the draft).
- **Leaving Blind without Go** throws the draft away.
- **Always on the real stage:** Master, Flash, Blackout, Next and Undo. Undo in Blind undoes the draft's last change; once Blind is off it works on the stage as usual. *(My call: Undo follows what the page is working on.)*
- **Smoke machines** stay live: their slider and Puff act on the real stage, and Go never changes smoke.
- **Per tablet:** one iPad's draft doesn't affect another. It ends when the tablet reloads or loses its connection.
- **No Blind on the phone** (it stays a remote), as for Preview.
- **Manual control of single fixtures** stays out, as it is for operators today.

## Constraints

- The server holds each tablet's draft (the server is the single source of truth; the page only displays). A draft is a pure `Engine` driven by the same Commands; it never sends DMX.
- Go is one Command through `App.command()` and fades with the existing crossfade (`npm run jump-check` must pass).
- The draft picture runs on the server at the visualiser's rate and goes only to that tablet.
- Design system, quiet controls, 44 px targets, plain words.

## Left to the builder

- How the page marks commands for the draft (for example a wrapper command), and how Go carries the draft (for example the draft's runtime state).
- Keeping the draft's effects in step with the live beat clock when the draft starts.
