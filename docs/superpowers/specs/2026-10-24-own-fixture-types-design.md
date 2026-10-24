# Your own fixture types in Patch: design

Date: 24 Oct 2026. Status: agreed with Ilmārs (24 Oct), from a mockup.

## Why

Most of the church's lights were not in the Open Fixture Library. In Lightkey the owner had to find a substitute type with the same channels, by reading each light's channel use and comparing, and then correct colours by hand where the substitute was wrong. In Light Runner today the only ways to get a type are the library, a Lightkey import, a fixture file, or the seven built-in generic types; nothing on the pages lets you see a type's channels, compare two, or make one.

The concrete case: the four front panels P1–P4 are **walimex pro LED Niova 600 Plus Bi Color**. They are patched as the substitute **Neewer AS600B (CCT 8 bit)**: 2 channels, dimmer then colour temperature, range 2500–10000 K (from Lightkey). Both channels work on the walimex. Its real range is **3200–5600 K** (walimex's own product page; one shop says 5500 K). With the substitute's range, a colour that asks for 3200 K sends the value meaning 3200 K on a 2500–10000 K scale, which the walimex shows as a different temperature. A type of their own with the true range fixes that with no manual correction.

## Goals

1. **See a type's channels.** Tap any fixture type in Patch (library, Lightkey, built-in or your own) and see its channels numbered 1, 2, 3… in order, each with what it does (and its range, fixed value, 16-bit fine byte), and how many segments it has.
2. **Compare two types side by side** (owner's choice over one-at-a-time). Pick two types; their channels line up row by row (channel 1 against channel 1…), and rows that differ (role, range, fixed value, fine byte, or a channel only one of them has) are marked. Used to judge a substitute against the light's manual.
3. **Make your own type** with **＋ New fixture type** next to the Fixture library:
   - a **Name**;
   - the **channels in the light's order**, each with a job: Dimmer, Red, Green, Blue, White, Amber, UV, Colour temperature, Strobe, or Fixed value;
   - a **Dimmer** can be **16-bit** (it then takes two channels: the second is its fine byte);
   - a **Colour temperature** channel has its **range in K** (warm end = DMX 0, cool end = 255, as today's `kelvin {min,max}`);
   - **Strobe** and **Fixed value** channels have the **value** they sit at (0–255; strobe's is the "open / no strobe" value), as today's `default`;
   - **↑ ↓** reorder a channel, **×** removes it, **＋ Add channel** adds one at the end;
   - a one-line **summary** in plain words ("2 channels · one light, warm-to-cool white · dimmer and colour temperature 3200–5600 K"; "18 channels · 3 segments · each red, green, blue, white, amber, UV");
   - **Save type** / **Cancel**.
4. **Copy and edit**: from any type's channel view, **Copy and edit** opens the editor with its channels and "Copy of <name>", for a substitute that is almost right.
5. **Bars**: segments come out by themselves, as today: when a colour comes again, a new segment starts (the same rule the engine and Patch already use). The editor shows the channels grouped by segment, and **Repeat the last segment** appends a copy of the last segment's channels (a 10-segment bar in a few taps).
6. **Use it for**: the editor lists the fixtures in the show with a tick each (empty for a new type; for Copy and edit, the fixtures of the type copied are offered first). Ticked fixtures switch to the new type on Save type. They keep their names, universes, addresses, groups and places on the plan; only the type changes. If the new type has a different channel count, Patch's existing address check shows any overlap in red as today.
7. **Edit a type in the show later** *(builder's call, see below)*: any type stored in the show that did not come from the Open Fixture Library can be opened and changed, including the ones the Lightkey import brought in (they carry no `source`); every fixture using it follows. Types from the Open Fixture Library or a fixture file (they carry `source.ofl`) and the built-in generic ones are read-only (their view has **Copy and edit** instead). **Delete type** is offered only for an editable type no fixture uses.
8. Your own types are **saved in the show** (with Save patch, like every Patch change), so **Export show file** carries them to another computer, Backups keep them, and Compare with a file / Open a show file bring them in.

## Non-goals

- Colours Light Runner doesn't mix today (lime, cyan, a second white, warm white + cool white as separate channels). The roles stay the ones the engine knows. (A colour temperature channel covers bi-colour panels like the walimex.)
- Pan/tilt, gobos, zoom, or any moving-head features.
- Uploading to or searching the Open Fixture Library; editing types that came from it (copy them instead).
- Converting existing colours when a fixture changes type: colours are stored as colours (hex and white levels), and the engine turns them into DMX for whatever type the fixture has, so P1–P4's "Silti 3200K" simply comes out at the panel's true warm end.

## Anti-goals

- A change in the editor reaching the lights before **Save patch** (Patch's rule today: nothing reaches the show until Save patch).
- Editing a type silently changing fixtures the person didn't mean: switching fixtures happens only through the **Use it for** ticks; editing one's own type shows how many fixtures use it ("Used by 4 fixtures") before saving.
- A type that the engine can't drive being saved: the editor refuses in plain words (e.g. no channels; a fine byte without the channel before it; a colour temperature range whose warm end isn't below its cool end; a smoke group's fixture losing its dimmer is already warned about by Patch).
- Jargon: the editor says "Fixed value", "16-bit", "warm end / cool end", "segment", never "role", "default" or "profile".

## Constraints

- The show schema already has everything a type needs (`Profile { id, name, channels: { role, fine?, default?, kelvin?, name? }[], gamma?, source? }`). Read-only types are those with `source.ofl` and the built-ins (the `generic-*` ids in `packages/shared/src/profiles.ts`); everything else in the show is editable. No schema change.
- Patch's page model: everything is edited in the page and stored with **Save patch** (`PUT /api/show?source=patch`); the server stays the single source of truth.
- Plain JS page, design system (`web/shared/theme.css`, `ds-` components, 44 px targets, quiet controls, dark), works on the iPad at 1080 × 810 and on a laptop. The mockup the owner saw is in `.superpowers/brainstorm/` (not in git); the final look follows the design system, not the mockup's styling.
- `npm test`, `npm run typecheck` and `npm run jump-check` pass; tests for any shared logic (summary text, segment grouping, validation, comparison rows) in `packages/shared/test`; the page checked in a browser.

## Calls made while writing this up (not the owner's; check them)

1. **What is editable:** every type in the show except library/fixture-file ones (`source.ofl`) and built-ins. So the Lightkey types (AS600B, SixBar 500, the strip) can be edited in place; the walimex is still best made as its own type (Copy and edit the AS600B), so the Neewer type stays as it was.
2. **Channels the jobs don't cover are kept:** the editor shows every channel. A channel with its own name (from Lightkey or a fixture file, e.g. "RGBW Color Change") shows that name beside its job, and Copy and edit keeps names, fixed values, ranges and fine bytes untouched. The job list maps to the schema as: Dimmer `dimmer`, Red…UV, Colour temperature `cct`, Strobe `strobe` (with its value), Fixed value `other` (with its value).
3. **16-bit** is offered on every channel that takes a level (dimmer, the colours, colour temperature), not only the dimmer: the engine already drives a fine byte on any of them. The fine byte shows as part of its channel ("2–3 Dimmer, 16-bit"), not as a row of its own.
4. **A segment** runs from a segment's first colour channel to its last colour channel (with their fine bytes and any channels between them). Channels before the first colour channel, or after the last segment's last colour channel, belong to the whole light. **Repeat the last segment** inserts a copy right after the last segment, before any of those trailing channels.
5. **Overlaps after Use it for** are only shown in red by Patch's existing address check, as today; nothing is blocked and addresses are not moved.
6. **Ids:** a new type's id is a slug of its name, made unique against the show's types and the built-in ids, and fixed once created; renaming changes only the name. Compare with a file matches types on id, as today.
7. **What the lists offer:** the channel view, Compare and Copy and edit work on the types Patch already lists (the show's types and the built-ins); a library fixture not yet in the show is added first as today.

## Left to the builder

- Where exactly the channel view, the comparison and the editor open (a sheet over Patch, a panel beside the Fixture library…), as long as they are reachable from the Fixture library list and from the Fixtures table's Type, and the editor is the one described above.
- How the two types for the comparison are picked (e.g. "Compare with…" in a type's view, then choosing the second type).
- The new type's id (a slug of its name, unique in the show).
- Whether `name` on a channel (today optional) is shown or editable.

## After it is built

- Docs: `docs/setting-up-a-show.md` step 2 ("A fixture that is in neither…" becomes "make your own type"), the skill's line about it, `docs/STATUS.md` (programmer niceties: own fixture types done), `docs/DECISIONS.md` (own types saved in the show; library types read-only, copy to change).
- The owner then makes the walimex type (3200–5600 K) and switches P1–P4 to it.
