# Song sections, and lights that follow the presentation app

16 Nov 2026 · @Ilmārs · agreed in conversation (16 Nov); builds on the [planning design](2026-10-25-planning-service-design.md) (25 Oct) and the [song sections research](../../notes/song-sections-research.md) (4 Nov)

## Why

In most services nobody runs the lights, so they change late or not at all. The running order already comes from the planning service, and the presentation app already tells the world which slide is on screen, within about a tenth of a second. This makes the lights follow it: the next song gets its look when the presenter moves to it, and within a song the verse, the chorus and the bridge each get their own look when the presenter clicks to their slides.

Success: a Sunday where nobody touches the iPad, every song starts on its own look, and the chorus looks different from the verse.

**Names.** As in the planning design, the docs don't name the planning service or the presentation app; the code and the pages may.

## What this builds

The 25 Oct design described following the presentation app item by item (its section "Following the presentation app"), and the owner deferred it on 26 Oct. This builds it, with the changes the owner made on 16 Nov (listed under "Changes to the 25 Oct design"), and adds sections.

1. **Sections come in with the service.** Loading a service also reads each song's sections from the song library.
2. **Each section can have its own look.** Until someone changes it, a section plays the song's look, so it starts the same as the song and is changed later.
3. **Auto-follow.** With it on, the lights follow the presentation app: to the next item, and to the section on screen.
4. **By hand on the iPad.** A song's sections are rows under it; a tap starts one. A tap by hand pauses Auto-follow.
5. **Saving a change for a section.** A change made while a section is on stage asks whether to keep it for this section or for the whole song.
6. **Song facts for planning the lights** (owner, 16 Nov: "import also tempo, and accords, so that this info could be given to ai agent that could plan lights for it all"). Each song comes in with its key, tempo, time signature and chords, and an agent can read them all to plan the looks.

## Goals in detail

### 1. Sections from the song library

A song in the library lists its slides once each, in order, each with a title and a colour (the research note, section 1). A section is the slides that share a title once the trailing slide letter is taken off ("Chorus a", "Chorusb" → "Chorus").

**One look per kind of section in a song** (owner, 16 Nov: "all chorus looks like the same"): the section's name is cleaned down to its kind, and every slide of that kind in the song shares one look.

| Kind | Titles it covers (examples from the church's songs) |
| --- | --- |
| Verse | Verse 1a, Verse 2 b, Verse |
| Pre-chorus | PreChorus, Pre-Chorus 1 |
| Chorus | Chorus a, Chorusb, Chorus 2 a, Chorus a EN |
| Bridge | Bridge 1 a, Bridge |
| Tag | Tag |
| Intro | Intro |
| Outro | Outro, Ending |
| Interlude | Interlude, Instrumental |

- The number, the slide letter, the language mark ("EN", "eng"), case and spaces are ignored. The list of kinds and the words that map to them is one table in the code, easy to extend (Latvian titles such as "Pants" or "Piedziedājums" are added there if they turn up).
- A slide whose title fits no kind ("Slide 11", an empty title) belongs to no section: on screen it leaves the lights as they are. *(Claude's call: the colour could group untitled slides, but the research found the colour is usually missing exactly where the title is.)*
- A song with no slide of any kind has no sections and works as today, one look.
- The sections of a song, in the order they first appear in its slides, are kept with the loaded service (they say what rows to draw and what to match live); they are refreshed on every load.

### 2. Section looks

- **A section plays the song's look until someone changes it** (owner: "Copy the song's look to all sections, change later"). It gets a look of its own only when a change is saved for it (the save bar, or Save to <section>), made from the song's look as it is then plus that change. *(Claude's call, after the builder check: a copy made at load would go stale as soon as the song's look is shaped after the load, which is when it usually is, and the song would then fade back to the old default at the first verse. An unchanged section has nothing to go stale.)*
- **Remembered like songs.** A section's own look is remembered against the song id and the kind, as song looks are remembered against the song id, so the next service with that song gets it back.
- **The song's own look stays.** It is what a tap on the song's row starts, what the song's Blank slide starts (below), and what every section without its own look plays.
- **A section's look is colours and levels (with effects).** The tempo and the timeline belong to the song: moving into a section never changes the tempo (a tempo tapped during the song carries on) and never stops, starts or restarts a timeline. A group a running timeline drives stays the timeline's. *(Claude's call, after the builder check: a section is a moment within the song, not a new song.)*
- Section looks are not rows of the running order: Next, the controllers' running-order pads and Companion's item numbers skip them, and count songs as today *(Claude's call: the order of sections in a service isn't planned anywhere, so stepping through them in library order would be wrong half the time)*.
- Deleting a song's row (Edit list) deletes its section looks too, as it deletes the song's look and forgets it today; a load that no longer has the song keeps them (remembered). *(Claude's call, after the builder check: matches what a delete does today.)*

### 3. Auto-follow

The presentation app sends a message on every slide change, naming the item and the library slide on screen (the research note, section 2). Light Runner matches the item against the loaded service by its id, and the slide against that song's sections by the library slide id.

**With Auto-follow on, when the presentation app moves:**

| On screen now | The lights |
| --- | --- |
| A new item that has a look of its own (a song; slides, a picture or a blank someone saved a look to) | that item's look starts, as a tap on its row would (the 25 Oct rule 1) |
| The first item live in a new part (the header above it), whatever its kind | the part's look starts, if the part has one (the 25 Oct rule 2: the blank that opens Vārds starts the sermon look) |
| A song's Blank slide (every song starts on one) | the song's own look |
| A slide of a section, when that section isn't the one already on stage | the section's own look, or the song's look when the section has none |
| Another slide of the section already on stage ("Chorus b" after "Chorus a"), a slide of no section, a Bible verse, a blank inside a part | nothing changes |
| An item that isn't in the loaded service | nothing changes; the pill says "not in the running order" |

- Going back to a section, or a second chorus, starts that section's look again; both look the same, so it doesn't matter that the two can't be told apart.
- **Fade:** every change Auto-follow makes fades exactly as the same tap would: the top bar's Fade, or each look's own when Fade is Auto.
- **Never on a Prepare draft.** Prepare is per tablet and follows nothing; what Auto-follow does is on the real stage, and a tablet preparing keeps its draft.
- **Catching up** is as in the 25 Oct design: when Light Runner learns what is on screen late (a reconnect, a restart), it acts on it as if it had just come, unless it is what it last followed.
- **A missed message** is fine: every message carries the whole state, so the next one puts it right (the research saw 1 of 20 go missing on two quick clicks).
- **Moving between sections of one song** changes only the groups' colours and levels (above): the tempo and a running timeline carry on. Moving to another item is a full look change, as a tap is.

**The Auto-follow switch:**

- **One switch for all tablets** (shared, like Fade), on the server, kept across restarts. It exists only while Planning is on in Settings, and is on when Planning is first switched on.
- It is a quiet pill in the top bar after the name on stage (the 25 Oct pill), and the pill is the switch: a tap turns it on or off. *(Claude's call on its look and place; the owner asked for "an autofollow button".)*

| State | The pill says |
| --- | --- |
| On, following | ● Auto-follow · **Uz Krustu** · Chorus |
| On, on an item that changes nothing | ● Auto-follow · **Vārds** · verse |
| On, the item isn't in the running order | ● Auto-follow · <Presenter> is on **…** · not in the running order |
| Off (paused by a tap, or switched off) | ○ Auto-follow off · <Presenter> is on **Uz Krustu** |
| The presentation app isn't reachable | ○ <Presenter> not open (or the plain reason: no internet, the login has run out) |

- **Switching it on** starts what the presentation app has on screen now, straight away, by the rules above (the director's own tap, like the 25 Oct Start; the separate Start button is not needed).
- **A tap by hand pauses it** (owner, 16 Nov: "what was tapped by hand stays until someone switches Auto-follow back on"): starting anything on the real stage from the iPad, the phone, a controller or Companion switches it off. That is a song or section row, a quick look, Basic lights, Next, Blackout, Go in Prepare, and a timeline started live. Master, Flash, Undo, smoke, Individual lights and changing a group's colour or level do not pause it.
- The pill's text then says it is off, on every tablet, so anyone can see why the lights stopped following.

### 4. Sections on the iPad

- **Under the song that is on stage,** its sections show as smaller, indented rows in the running order, in the order they first appear in the song (Verse, Chorus, Bridge …), each with its own look's swatch dots, or the song's as hollow dots when it has none; the one on stage is marked as rows are today (Light Runner keeps which section is on stage, since a section without its own look plays the song's look). *(Claude's call: only under the song on stage, and under the song being prepared in Prepare, because every song's sections at once would push the running order off the screen.)*
- **A tap on a section row** starts its look, as a tap on a song does (and pauses Auto-follow). In Prepare, it makes it the prepared item, so a section's look is made in Prepare and saved with **Save to <section>** like a song's.
- **Save to <item>** names the section when one is on stage ("Save to Chorus · Uz Krustu", hold), and saves into that section's look.
- A song without sections has no section rows.
- The phone remote shows the section rows the same way and can tap them; it doesn't save (it never edits). *(Claude's call.)*

### 5. Saving a change for a section

When a section is on stage (followed or tapped) and someone changes a group's colour or level, a quiet bar shows above the groups:

> **Save this change for:** This section · The whole song

- **This section** saves the changed groups into this section's own look (made from the song's look first, if it has none yet).
- **The whole song** saves them into the song's own look and into every section of the song that has its own look (sections without one follow the song's look anyway).
- Only the groups changed since the section started are saved, each with its new colour and level; the rest of each look stays as it was (as `itemGroup` changes one group of a song today).
- **No answer:** nothing is saved, and the change lasts until the next section or item replaces it. The bar goes when that happens. *(Claude's call: the safe choice, nothing lingers by surprise.)*
- Both saves are an Undo step and make a backup, like other operator edits, and need no PIN.
- **Save to <section>** (hold) still works as well and saves the whole stage into the section, as Save to a song does.

### 6. Song facts for planning the lights

What a person (or an agent) needs to choose a song's looks, read at load with the rest of the song and kept with the loaded service:

| Fact | Where it comes from |
| --- | --- |
| Key | the service's key for the song, else the song library's default key |
| Tempo | as today: the service's, else the library's (40–240 bpm) |
| Time signature | the library ("4/4", "6/8") |
| Artist | the library |
| The service's notes for the song | the service (short text the worship leader wrote, such as "slow start, full band from chorus 2") |
| Per section: how many slides, and the chords | the library; the chords as chord names in order ("G D Em C"), once per section |

- **No lyrics are kept** (they aren't needed to light a song, and they are someone else's words). Chords are kept as names only.
- **Where the chords are in the library is not known yet**: inside the slide text as marks, or a separate chord chart. Finding out (on the church Mac, field names only, as the research did) is the first task; until then the chords are simply missing, and everything else works.
- **Shown on the iPad** only as a quiet line under the song on stage: key, tempo and time signature ("G · 72 bpm · 6/8"). The rest is for planning.
- **For an agent:** the facts are in the operator layout (no PIN), and the `light-runner-control` skill gets a recipe "plan the lights for a service": read every song's facts and sections, propose a look per song and per section in one table (tempo and key guide energy and warmth; chords and the notes guide where it lifts), and on a yes build each in Prepare and save it to the song or the section. Nothing goes on stage without a yes, as the skill's rules already say.

## Changes to the 25 Oct design

| 25 Oct | Now | Why |
| --- | --- | --- |
| Following carries on after a tap by hand (the director "steps in", and the next item takes over) | A tap by hand pauses Auto-follow until it is switched back on | The owner's choice, 16 Nov |
| Following waits during Blackout | Blackout is a tap by hand, so it pauses Auto-follow | Follows from the row above |
| The pill opens a menu with Follow on/off and Start | The pill is the switch; switching on starts what is on screen | One control instead of two |
| An item is the smallest thing followed | A song's sections are followed too | This design |

Record these in DECISIONS.

## Non-goals

- Laying out a song's sections in a planned order ("V1 C V2 C B C") or a timeline across the whole song: nobody writes that order (the research note, section 3).
- Telling a second chorus from going back to the chorus.
- Writing anything back to the planning service (renaming "Slide N" slides is done there by people).
- Automatic sign-in (unchanged from 25 Oct).

## Anti-goals (a failure even if it works)

- **The lights depend on the internet.** If the presentation app, the live channel or the internet is gone, every control works as today; only following stops, and the pill says so quietly.
- **A tap by hand is overridden** by the next slide while Auto-follow is paused.
- **A Bible verse, or a slide with no section, changes the lights.**
- **A section change jumps** instead of fading, or restarts a song's running timeline.
- **The running order becomes unreadable** with section rows.
- **Loud controls.** The pill and the save bar are quiet (the owner dislikes controls that stand out).
- **Platform names in the docs.**

## Constraints

- Every change is a Command through `App.command()`, the server is the only source of truth, and pages only display state: Auto-follow on/off, a section tap, the two saves.
- The engine stays pure. The live connection (WebSocket, the channel's sign-in over the planning API, pings, joining chunked messages, reconnecting) lives in `server/planning/`, never blocks a frame or a command, and uses Node 24's own `WebSocket` and `fetch` (no new dependencies). `tools/worshiptools-live.ts` already does all of it and is the starting point.
- Matching a live message to an item and a section, and choosing what to start, is a pure function in `packages/shared` with unit tests; the server tests use a fake live connection fed from recorded messages (the research recording, kept outside the repo, with slide text removed). No network in `npm test`.
- Section looks and their remembered keys are part of the show (they travel with export and backups); the live connection and the login are not. `checkReferences` stays valid; Basic lights and the kept rows stay as they are.
- New engine behaviour (if any) gets a test in `packages/engine/test`, and `npm run jump-check` passes (a section change is a look change, so it must fade like one).
- UI: the design system's tokens and `ds-` components, dark, quiet, 44 px targets, the iPad at 1080 × 810; plain words, sentence case.
- Docs: STATUS, DECISIONS, `running-a-service.md` and `setting-up-a-show.md` (step 11) in the same words as this file.

## Not known yet (find out on the church Mac, early in the build)

- Where the song library keeps chords (see "Song facts").

From the research note, section 3:
- What a blank, black or clear-all on the presentation app sends. Until known: nothing changes for them.
- What a click in the presentation app's own window sends (the recording only had a remote's clicks; expected to be the same).
- Whether auto-advance is used in Rīga's services (the lights would then change without anyone clicking: fine, but worth knowing).
- How the connection behaves over a whole service: reconnects, two presentation computers open, the app restarted.

The live part can only be tried where the planning login and a presentation computer are: the church Mac. Everything else (loading sections, the rows, the saves, the matching) can be built and tested on this PC with the fake.

## Left to the builder

The data shapes (how sections sit in the loaded service and how section looks are remembered), the module layout in `server/planning/`, the live connection's reconnect timing, how the section rows and the save bar look within the design system, and how the pill fits the top bar on the upright iPad and the phone.
