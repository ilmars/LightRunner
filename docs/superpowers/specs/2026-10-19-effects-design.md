# Effects: design

Date: 19 Oct 2026. Status: agreed with Ilmārs, not built yet. This is the product spec's Phase 2 (docs/SPEC.md, "Effects in version 1" and "Effects engine and transitions"), shaped by what the owner asked for.

## Why

During worship songs, and especially fast ones, the owner wants the lights to move the way Lightkey can make them move: the four background bars joined into one line of light, with waves (one, or several repeating) rolling across the wall, colours drifting from one to the next, chases and sparkle. They have hardly used effects so far. The main reason is Lightkey's cheapest licence, which caps the DMX channels, and effects across every segment of every bar need more than it allows. Light Runner has no such cap.

It must never be "my app is too simple and it can't do that" (owner's words, paraphrased). Most Sundays stay simple, but when a lights volunteer is there, they should have the full creative range.

## Who uses it, and how

- **The live director alone (most Sundays):** effects are prepared into songs at rehearsal, like colours today. Starting the song starts its effect. Nothing to watch or tap.
- **A lights volunteer is there:** they can start, change and stop effects live during a song, change speed and colours, and tap the tempo along with the band. Live changes act on the stage only; Save (or Preview) keeps them in the song, as for colours today.
- Slow songs get gentle movement (or none); fast songs can be very dynamic. It depends on the song and the Sunday.

## Goals

1. **Effects on any light group**, mainly the background bars, sometimes the key lights.
2. **A group's lights act as one line of segments.** The four background bars (B3–B6, 8 colour segments each) make one line of 32 segments, in group order, so a wave runs across the wall as one image. The key lights (3 segments each) make a line of 6.
3. **The first set of effects** (owner's picks first):
   - **Colour fade:** all lights drift together through a list of colours, one to the next, and round again.
   - **Wave:** colour or brightness rolls along the line.
   - **Repeating waves:** the same wave repeated along the line, so every third (or fourth …) segment peaks together and several waves roll at once. This can be one "Wave" effect with a "Waves" setting.
   - Then, inspired by Lightkey's pattern effects: **chase**, **sparkle**, **breathe**, **meteor** (a bright head with a fading tail), **fill** (the line fills up and empties) and **yo-yo** (a block running back and forth).
4. **Every effect uses a colour list:** 1 to 6 colours picked from the group's own colour list (the swatches the picker already shows). Colour fade drifts through them; a wave rolls them along the line (two colours gives one colour moving over another).
5. **An effects list per group,** next to its colour list, in the colour picker's **Effects** tab (today a placeholder). Light Runner comes with ready-made effects, and the list can be changed like the colour list: tap to run; **Edit** to rename, change settings or colours, or delete; "Used in …" shows where a change lands; **Save as a copy** to try a variation without touching what songs use.
6. **Effect settings:** colours; speed; direction (left to right, right to left, centre out, outside in); number of waves; size (how much of the line is lit, for waves, chases, meteor and yo-yo); soft or hard edges.
7. **Tempo:**
   - Each song has its own tempo (beats per minute), saved with the song; starting the song sets it.
   - Effect speed counts in beats (for example one wave every 4 beats), so one effect fits slow and fast songs without editing. An effect can instead run free (seconds per cycle), which suits slow colour fades.
   - A tempo control on the operator page shows the current tempo, with **Tap** (tap a few times with the band), **×2 / ÷2**, and **− / +**. During a song it changes only the stage; Save keeps it in the song.
   - This replaces the spec's planned speed dial (50–200 %).
8. **Smooth everywhere:** changing from one effect to another, or between an effect and a plain colour, fades like any look change today, with both running during the fade (no freeze, snap or restart). Master, group dimmers and Undo work with effects as with colours.
9. **Works with what exists:** quick looks, Save, Back to, Preview, Add song and the phone remote handle effects like colours. The stage picture shows effects moving.

## Non-goals (for this design)

- Layering several effects on one group (the spec's Phase 2b layer stack and blend modes). The engine should be built so layers can come next.
- Importing Lightkey's effects. The owner can't reach the project file now; this comes later, once the file can be looked at.
- Movement effects (pan/tilt): the rig has no moving heads.
- Keeping time with the band automatically (audio, MIDI clock, Ableton Link). Tap tempo only.
- Strobe (left out of version 1 for photosensitivity, as the spec says).

## Anti-goals

- An effect that makes the stage jump when it starts, stops or changes.
- Flashing that could trouble someone with photosensitivity: no effect may flash the whole group, or a large part of it, more than 3 times a second, at any tempo (my call, following common photosensitivity guidance).
- Effects that start by themselves on Basic lights, Blackout, the sermon, or after a restart without the song that holds them. Basic lights and Blackout are always still.
- A volunteer's live tinkering changing the prepared show without Save.

## What the owner decided

- Effects go mainly on the background bars, sometimes the key lights.
- The first effects: wave, repeating waves (every third segment …), colour fade; then Lightkey-like pattern effects.
- A colour list per effect, from the group's colours.
- An effects list that can be edited like the colour list.
- A tempo per song with a tempo control and tap.
- Effects from Lightkey should come across in the import, later.

## My calls (check these)

- **Segments become the unit of light.** Each repeated set of colour channels in a fixture type (SonicPulse Bar 10: 8 × RGBW; SixBar 500: 3 × RGBWAUV; SonicPulse Bar 05: its segments) is one segment the engine can light on its own. Plain colours light every segment the same, as today. The stage picture draws each segment.
- **One effect per group at a time** (no layers yet). A group runs either a colour or an effect.
- **The tempo control sits in the top bar,** next to Fade, quiet, with a 44 px Tap button. On the phone it sits in the Groups tab.
- **Default tempo** for a song without one: 120 beats per minute.
- **The 3-flashes-a-second limit** is enforced by the engine, whatever the settings and tempo.
- **Flash still wins:** holding Flash puts the group at full white over any effect, as today.
- **Preview's stage picture** shows a still moment of a song's effect (not moving), with its "Preview" label.
- **The phone** can pick effects from the Effects tab and tap the tempo, but not edit effects (it stays a remote).
- **Ready-made effects** for the background and key lights are added to the show the first time this version runs, named in English (the owner can rename them).

## Settled after the builder check (my calls)

- **What counts as a flash, and what the engine does about it.** The rule works per segment: no segment's brightness may rise and fall by more than 20 % more than 3 times a second. If an effect's settings and the tempo would break that, the engine runs that effect at half speed (again, if needed) until it doesn't. Colour changes at the same brightness (a colour fade, a colour wave) don't count. The check sits in the effect itself, before crossfades, Master and Flash. Flash (the held button) is not an effect and keeps working as today.
- **Bars hung the other way round.** Each fixture gets a "Reversed" switch in Patch, which flips the order of its segments. Group order plus each fixture's direction makes the line. The owner checks at the church whether any bar needs it.
- **Tempo and other controls.** In Preview, the tempo control edits the selected song's saved tempo, like every other Preview edit. Quick looks, Basic lights, Blackout and Undo leave the tempo alone; only starting a song (or the tempo control) sets it. Undo does take back a tempo change made with the tempo control.
- **The old speed dial.** The page's speed control goes. The `speed` command (and `POST /api/speed`) stays as an overall multiplier on the tempo (50–200 %, default 100 %), so existing clients keep working. Basic lights resets it to 100 %, as today.
- **Ready-made effects**, added to each light group that has more than one segment, or more than one fixture:
  - Background: Colour fade, Wave, Three waves, Chase, Sparkle, Meteor, Fill, Yo-yo and Breathe.
  - Key lights: Colour fade, Breathe and Wave.
  - Each uses the first two or three coloured (non-white, non-Off) swatches of that group's colour list. Speeds are 4 beats per cycle (16 beats for Colour fade). All of them are editable.
- **Segments:** a fixture type without repeated colour channels is one segment. A segment's brightness goes on its colour channels; a fixture-level dimmer stays at the fixture's overall level.
- **One beat clock** for the whole stage, so every group's effects stay in step.

## Constraints

- Every input is a `Command` through `App.command()`; the server is the single source of truth (CLAUDE.md).
- The engine stays pure: effects are functions of time (or beat phase), segment position and settings. Phase advances by speed × elapsed time, so changing the tempo or speed never makes an effect jump (docs/SPEC.md).
- Timing comes from the clock, never the frame count (docs/SPEC.md).
- Fades between anything keep the existing smooth crossfade and must pass `npm run jump-check`. An effect's own motion (a chase stepping, a meteor's head) is not a fade; the jump check has to judge transitions while effects run, not the effects themselves.
- 40 frames per second with the whole rig running effects, within the timing target (±3 ms of 25 ms) on the church Mac mini.
- Design system, quiet controls, 44 px targets, nothing bright on the operator page (CLAUDE.md).

## Left to the builder

- How effects are stored (new layer kinds in a preset is the natural fit; the schema already allows a layer stack of up to 8).
- How segments are found in a fixture type (repeated colour roles in order is the obvious rule) and how Patch shows them.
- The exact maths of each effect, and soft/hard edges.
- The look of the Effects tab, the effect editor and the tempo control, within the design system.
- How the jump check is extended for effects.
- How the stage picture draws segments.
