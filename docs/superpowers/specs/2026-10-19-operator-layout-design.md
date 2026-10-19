# Operator page layout: design

Date: 19 Oct 2026. Status: agreed at block level with Ilmārs; detailed UI is the next step.

This decides **where things live** on the operator page (`/operator/`): which blocks exist, where they sit, and how a change becomes part of the show. It does not decide sizes, colours, the colour picker, or how effects are edited. Those come next.

## Why

The page is used by the **live director**, not a dedicated lighting volunteer. Lights are one job among several during a service, so the page has to work at a glance and with one hand. The same person prepares the lights at the **Sunday morning rehearsal**, on the same iPad, in the time between songs.

A typical week:

- **Arriving, setup, rehearsal:** one tap for basic lights. Everything bright and plain, no effects.
- **Worship:** each song has its own look (colours, sometimes an effect), set at rehearsal and nudged live (warmer, darker).
- **Flash:** hold a button and a group (or everything) jumps to full; let go and it drops back, as in Lightkey. An occasional accent.
- **Sermon:** well lit and calm, key lights dimmed so they don't blind the hall, maybe a different colour scheme, no effects.
- **Midweek worship:** dimmed and warm, calm, with gentle movement at most.

Songs change every week and depend on who leads, so the director thinks in terms of "Song 1 to 5 for today", not a library of song looks.

## Goals

- Starting basic lights, sermon or midweek calm is one tap, always in the same place.
- What is on stage right now can be read at a glance: the stage preview, plus the group-by-group details.
- A song can be set up at rehearsal with the same controls used live. There is no separate edit mode.
- A live change (quick look, colour, dimmer) never changes the show until someone presses Save.

## Non-goals (for now)

- A library of saved song looks to pick from week to week. Wanted later, not now.
- Designing effects (Phase 2 / 2b). Effects only appear here as something a quick look or a group card can choose.
- Changing the settings and patch pages beyond reaching them from the ⚙.

## Anti-goals

- Controls that stand out or light up the operator's face (house style: dark, quiet).
- Anything that needs careful reading during a service.
- A live tweak silently overwriting a prepared song.

## Layout

iPad in landscape (1080 × 810). Block positions, not sizes:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Now: Song 3 · changed · fade 2 s · connected               12:04  ⚙ │  top bar
├───────────────────┬──────────────────────────────────────────────────┤
│ Stage preview     │ Quick looks   [Plain] [Colours] [Effects]     ›  │
│ (what is lit now) │ Bright  Warm  Cool  Soft  Sermon  Dim  Key  …     │
├───────────────────┤ Half  Candle  Evening  Low  …                     │
│ Running order     ├──────────────────────────────────────────────────┤
│  Basic lights     │ Song 3: details        [Back to Song 3] [Save]   │
│  Song 1           │ ┌ Front lights · warm ┐  ┌ Key lights · white ┐   │
│  Song 2           │ │ ▬▬▬▬▬▬▬▬▬▬▬▬  80 %  │  │ ▬▬▬▬▬▬▬▬▬   60 %   │   │
│ ▸Song 3 (changed) │ └─────────────────────┘  └────────────────────┘   │
│  Song 4           │ ┌ Background · wave ──┐  ┌ Drum cage · purple ┐   │
│  Song 5           │ └─────────────────────┘  └────────────────────┘   │
│  Sermon           │ ┌ B8 side bar · blue ─┐                          │
│  Midweek calm     │ └─────────────────────┘                          │
│  ＋ add           │                                                  │
├───────────────────┴──────────────────────────────────────────────────┤
│ Master ▬▬▬▬   Flash (hold): All Key Bars      Undo  Next ▸ Song 4  Blackout (hold) │
└──────────────────────────────────────────────────────────────────────┘
```

### Top bar
What's on stage now (name of the running-order item, plus "changed" when it differs from what's saved), fade time (the existing quiet Fade menu), connection state, clock, and a small **⚙** that opens Settings and Patch. Those stay separate pages behind the PIN, as today.

### Stage preview (left, top)
A small live view of what is lit, as the existing stage canvas draws it. For looking only, not for touching.

### Running order (left, main)
The full list for today, in service order: Basic lights, Song 1 to 5, Sermon, Midweek calm. Always a full list, never squeezed to a strip (decided). Tapping an item starts it with the current fade. The item on stage is marked, and "changed" when it has unsaved live changes. **＋ add** adds an item, for example a 6th song.

### Quick looks (right, top)
Ready-made looks to try on the current item, sorted into tabs **Plain**, **Colours** and **Effects**. There's room for 12 to 16 on screen, and the grid scrolls or swipes when there are more. The design has to allow many buttons (decided). Tapping one puts it on stage straight away and marks the current item "changed".

### Details (right, main)
The current item group by group: one card per group with its name, its colour or effect, and its own **dimmer bar**. Tapping the name picks the colour or effect (the picker is designed in the next step). Dragging the bar dims that group. Each change is live and marks the item "changed".

The header holds **Save to Song 3**, which writes what's on stage into that running-order item, and **Back to Song 3**, which drops the live changes and fades back to what's saved.

### Bottom bar
Master fader, **Flash** buttons you hold (All, Key, Bars), Undo, **Next ▸** showing the next item's name, and Blackout (hold 1 s).

## How a change becomes part of the show

1. Song 3 is running. The director taps the quick look "Warm", or changes a group's colour or dimmer in the details.
2. The stage changes now. Song 3 shows "changed" in the top bar and in the running order.
3. **Save to Song 3** (hold) keeps it: the item now holds what's on stage, colours and group dimmer levels included. **Back to Song 3** throws it away, and so does starting another item.
4. Rehearsal is the same flow, item by item. There's no edit mode.

This settles one of STATUS's open questions: a running-order item **does remember its group dimmer levels** once saved. The Master fader stays a live adjustment and isn't saved.

## Decided after review

Ilmārs's answers (19 Oct 2026):

- **Unsaved changes are dropped when another item is started.** No question, no draft. Live tweaks are temporary unless saved, as in Lightkey.
- **Save needs no PIN, but it is a hold** (like Blackout), so it can't happen by a stray tap. Undo can take back the last Save. ＋ add needs no PIN either.
- **Basic lights replaces the Safe button.** It is the show's Safe look (`operator.safeLook`), stays fixed at the top of the running order, and tapping it also resets Master and group dimmers, as Safe does today (see DECISIONS: Safe resets over 2 s). The HTTP API's Safe keeps working and does the same thing.
- **Quick looks are made on the operator page:** set the stage, then hold **Save as quick look** and give it a name and a tab. It's the same flow as Save to Song 3. Today's imported looks (Walk-in, Worship, Response, Prayer, All white) become the first quick looks.

Calls made while writing this up (Claude's, open to change):

- **Running order editing:** songs can be renamed (for example to the song's title), deleted and reordered. Items carry over from week to week until overwritten by the next rehearsal's Saves, so nothing disappears by itself. Basic lights can't be deleted or moved. Sermon and Midweek calm behave like songs.
- **Starting content:** on first use, the running order is Basic lights (from the current Safe look), Song 1 to 5, Sermon and Midweek calm, each starting as a copy of the closest imported look.
- **Quick looks set only the groups they list.** Other groups keep what they have, so a "Key lights low" quick look can be laid over any song.
- **Saving stores the item's own copy** of each group's colour, effect and level. A Save never changes a preset or quick look that something else uses. How the show file holds this is up to the builder (new presets per item, or colours stored in the look).
- **Flash:** while held, the group goes to full intensity in its current colour (white if it is dark), ignoring Master and group dimmers but not Blackout. It snaps in and out, so like short fades it is outside the 5% jump check. Buttons: All, Key (Key lights), Bars (Background and B8 side bar). Which groups get a Flash button can become a setting later.
- **Undo** covers starting items, quick looks, Save, Save as quick look and ＋ add. It doesn't cover each dimmer drag; Back to Song 3 covers those.
- **The group card picker** (colours, presets, effects) is designed in the detailed UI step.

## Where this meets what's built

- The current look tiles, group strip, group preset panel, dimmer panel and Safe button are replaced by the blocks above. Master, Undo, Next, Blackout, the Fade menu, the stage canvas and the reconnect banner carry over.
- "Changed" builds on the existing per-group "changed" badges.
- New on the server: Flash (hold and release), saving the stage into a running-order item or a new quick look, adding, renaming, deleting and reordering running-order items, quick looks as a separate list from the running order, and Undo for all of these.
- STATUS's "Record look / edit colours" (item 3) is largely this design. Its open question about dimmer levels is answered above. SPEC's Safe button becomes Basic lights; add that to DECISIONS when it's built. These are commands through `App.command()` like everything else.

## Left to the builder

- Exact sizes, spacing and touch targets within each block (thumb-sized, iPad 1080 × 810).
- How the quick-look grid scrolls (vertical or sideways).
- How "changed" is drawn, as long as it stays quiet.
