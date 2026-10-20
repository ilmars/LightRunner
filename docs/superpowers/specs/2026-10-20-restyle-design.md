# Operator page restyle: design

Date: 20 Oct 2026. Status: agreed with Ilmārs. A designer's proposal ("Light Runner redesign", 8 artboards: Live, Prepare, colour picker, effect editor, colour editor, individual lights, phone, app icon) is to be built as drawn, with three decisions from the owner:

1. **Prepare replaces Preview and Blind** (one "Live / Prepare" switch).
2. **Inter** is the font, shipped with Light Runner (works offline).
3. **"Who to call"** (a name and a phone) is a setting, shown in the problem explanation.

The proposal's files (`.dc.html` mockups with their exact styles and wording) are the reference for every value not written here. Where the mockup and this text disagree, this text wins; where both are silent, keep today's behaviour.

## Look

- Ground `#090F1C`; panels `rgba(28,39,62,.58)` with a 1 px edge `rgba(148,163,184,.14)`, radius 18; tiles `rgba(255,255,255,.035)`, radius 10–12; text `#E3E8F0`, muted `#97A4BA`.
- Meanings: blue `#4389E8` (tint `.16`) = selected / on stage; amber `#E3A646` = changed, Master below full, problems; red `#EC8286` = Blackout, delete; violet `#B0A6F5` (tint `.13`) = Prepare.
- Inter 400/500/600/700. Small labels: 11 px, `.09em` spacing, upper case, 600, muted.
- 44 px minimum targets; 52 px for the bottom bar's buttons.
- Dashed edges mark "add" tiles (＋ Add song, ＋ Save stage as a look, ＋ New colour, ＋ New effect).
- The design system tokens (`web/shared/theme.css`) are updated to these values, so Patch and Settings follow.

## Top bar

- Live: "On stage" label over the item's name, "● changed" in amber.
- Prepare: violet bar, "Preparing · the lights don't change" over the prepared item's name and "On stage: <name>".
- Blackout: red bar, "Blackout" over "Lights are off" and "Tap a song or Basic lights to bring them back".
- A problem pill (only when something is wrong) opens an explanation: what is wrong in plain words, that it isn't the volunteer's fault, **Who to call** (from Settings; the box is left out when empty), a line on what still works, and "Got it".
- Right side: Fade (label over value), Tempo (label over "120 bpm"), Tap, the **Live / Prepare** switch, **Go ▸** while preparing, the clock, a settings icon.

## Prepare (replaces Preview and Blind)

- Prepare on: the tablet gets a draft of the stage (today's Blind draft). A running-order tap picks the item being prepared: the draft starts it, nothing reaches the lights. Everything the page changes goes into the draft (colours, effects, levels, quick looks, tempo, Undo).
- **Save to <item>** (hold) stores the draft in that item without touching the lights (rehearsal use). **Go ▸** sends the whole draft to the lights in one smooth change and returns to Live (service use).
- Master, Flash, Blackout, Next, Basic lights in the bottom bar (see below), Fade, smoke and Puff act on the real stage, as in Blind today.
- Running order: the prepared item is violet with "preparing"; the item on stage has a dashed outline and "on stage". Stage view shows the draft with "Draft · <name>".
- Live turns Prepare off and drops the draft (as Blind off today). No Prepare on the phone.
- Preview's "edit a song in place" commands stay in the server for other callers but the page no longer uses them.

## Left column

- Stage view on top, then **Running Order** with "Edit list", Basic lights first with a quiet "safe look" tag and a divider under it, "next" on the item Next starts, "● changed" on the item on stage, ＋ Add song at the bottom.

## Right column

- **Quick Looks**: subtitle "change only the groups they set", the tabs, "Edit looks", tiles with name and colour strip, last tile "＋ Save stage as a look".
- **Groups** (was Details): subtitle "drag to dim" (Prepare: "<name> · draft"), **Individual lights**, "Back to saved" (only when changed), "Save to <name> hold" (amber edge when changed, violet in Prepare). One row per group: name · a colour button (swatch, colour name, chevron) · a 48 px slider · level.
- The colour picker, colour editor, effect editor and individual lights replace the Groups panel in place. The picker keeps Quick Looks visible; the editors and individual lights take the whole column.

## Colour picker

- Header: "‹ Groups", group name, current colour and level, Colours / Effects, Done.
- Colours: "Colours · tap to fade to it" with **Edit this colour** (edits the group's current colour); the grid with **＋ New colour** always last; "Any colour · drag to try it live" with **＋ Keep as a colour** (saves the strip pick, extras included); the strip; White, Amber, UV where the group has them. No separate Edit mode.
- Effects: "Effects · tap to run on <group>"; a group that isn't a line shows "Effects need a line of lights" and which groups take them; the grid with **＋ New effect** always last; while one runs, a card: "<effect> is running", the round's length ("one round = 2 s at 120 bpm", plus "· slowed to stay safe" when light safety slowed it), a Speed choice and **All settings ›** (the effect editor).

## Colour editor (also for a new colour)

- Header: "‹ <group>", Name, Cancel, Save. A preview card: swatch, "<colour> on <group>" or "New colour for <group>", and "The stage changes only when you Save" / "Trying colours here never changes the stage".
- Rows: Colour (strip + No colour), White · Amber · UV, Brightness (5–100 %), Fade into it, **Apply to** (Only <group> | Every group with <colour>), Used in.
- **Apply to**: "Every group" changes the shared colour when it is one, otherwise every group's colour with this name (today's two switches become this one choice).
- Delete colour: "Tap again to delete", with one plain line on what happens to songs that use it (true to the code).

## Effect editor

- Header: "‹ <group>", Name, ⋯ (Save as a copy, Delete), Cancel, Save. "Preview on <group> — only here — the stage doesn't change until Save" over the moving strip.
- Rows: Effect (type chips), Colours (numbered chips, ＋ Colour, "hold & drag to reorder"), Base (None | a colour | Own colour, with its brightness), Speed (1–32, Free, the round's length), Direction.
- **Fine-tune** (folded, with a one-line summary): Waves at once (− / +), Size, Edges.

## Individual lights

- From **Individual lights** in the Groups header (shown when operators have manual control, Settings). Subtitle "Lights you set here leave their group until you release them"; **Release all · N** and Done.
- "Pick": All, each group, None. A plan of the stage with every fixture as a button (name under it, a dot when it is held); tapping toggles it.
- With one bar picked: its segments as buttons, "tap to colour single segments".
- The pick's summary, colour circles (the group's colours) and "Any colour …", a Level slider, **Release picked**.
- Uses the engine's manual control (it holds until released, then fades back). Single segments only if the engine can hold one segment; otherwise the segment row is left out and that is said in STATUS.

## Bottom bar

- Master (amber below 100 %), "Flash" with All and a short name per group, Undo (icon and word), **Safe · Basic lights**, Next ▸ with the next item's name, Blackout (hold 1 s).

## Phone

- As the Phone artboard: "On stage" header with the problem pill, Order / Groups / Looks, Master, then Undo · Basic lights · Next · Blackout.

## App icon

- The designer's icon: a run of six segments brightening left to right to a warm-white head, on a dark blue rounded square; a 16 px version with three thicker segments. Used as the pages' favicon, the iPad home-screen icon and in the page titles' place where one fits.

## Not changing

- What every command does, the engine, light safety, the server's API, Patch and Settings layouts (they only take the new tokens and font, plus the Who to call fields).
