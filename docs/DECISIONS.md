# Decisions

Choices made while building Light Runner, newest first, with the reason. Add an entry whenever the build departs from [SPEC.md](SPEC.md) or a choice would surprise someone reading the code.

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-18 | **Keep Lightkey project import** (command-line importer and Settings > Compare with a file). | Requested by Ilmārs: Lightkey is where the rig is set up today, and its projects are how changes arrive. |
| 2026-10-18 | The whole Open Fixture Library is downloaded from its GitHub archive (about 3 MB) into `data/ofl/database.json`; updates compare commit ids and list changes before installing. | The church may have no internet; OFL is small enough to keep whole; updates should never change a running show silently. |
| 2026-10-18 | Fixture types keep their channels when the database updates; to use a corrected definition, re-add it from Patch. | Changing channel layouts under a live show could break looks. |
| 2026-10-18 | Profiles allow up to 512 channels (spec implied fewer). | Some OFL pixel modes use up to 256 channels. |
| 2026-10-18 | "Compare with a file" ticks new and changed items by default, never removals; PIN and output settings are never imported. | Nothing should disappear or lock someone out by accident. |
| 2026-10-18 | Lightkey projects are compared on the patch only. | Lightkey has no groups, presets or looks in Light Runner's sense. |
| 2026-10-18 | Fade time is one shared setting on the server (Auto = each look's own), shown as a quiet "Fade" menu. | All tablets and Companion must agree; the user found a row of buttons too loud. |
| 2026-10-18 | Master fader always visible; group dimmers in a panel behind a fader-width "Groups" button that shows mini level bars and "N dimmed". | Keeps the bottom row small however many groups there are, without hiding a dimmed group. |
| 2026-10-18 | Undo keeps the last 20 look/preset changes on the server and fades back over 2 s. | Most common recovery after a wrong tap; shared by every device. |
| 2026-10-18 | Groups are named by the user: Front lights P1–P4, Key lights B1–B2, Background B3–B6, Drum cage L1, B8 side bar; P5 left out. | Told by Ilmārs. |
| 2026-10-18 | sACN output added (spec listed it as a non-goal). | Requested by Ilmārs. |
| 2026-10-18 | Programmer pages are plain HTML/JS, not React; the server uses `node:http` + `ws`, not Fastify. | Fewer dependencies, no build step on the church Mac. |
| 2026-10-18 | The node watch polls the Art-Net node (ArtPoll) and reports "not answering" after 3 misses, or "another desk is also sending" when the node says it is merging. | UDP sends can't fail visibly; a wrong IP once sent DMX nowhere unnoticed. |
| 2026-10-18 | Safe and Blackout don't hand shared fixtures between groups, and Safe resets master, speed and levels over 2 s (the wash still fades in 1 s). | Two simultaneous curves multiplied made jumps just over 5% per frame. |
| 2026-10-18 | The 5% rule is measured on intensity, and fades shorter than 1 s are excluded from the jump check. | A full 0–100% fade under 0.75 s can't stay below 5% per frame at 40 fps. |
| 2026-10-18 | Fade entries leave the mix only when their weight reaches 0 (cap of 8), not at 1% as the spec says. | Dropping at 1% made a visible ~1% dip at the end of every fade. |
| 2026-10-18 | Colour mixes as emitted light (weighted by intensity), then is scaled so its brightest channel is 1. | Fading up from dark keeps the target colour instead of passing through white; red to blue stays bright. |
| 2026-10-18 | CCT-only fixtures (AS600B) get a colour temperature estimated from the colour's blue/red ratio; the CCT channel is linear (no gamma). | Lets the same warm/cool presets drive RGB and white-only fixtures. |
| 2026-10-18 | A fixture in two groups follows the most recent change to either group, handing over with the same fade. | Spec rule ("most recent change wins") without a snap. |
| 2026-10-18 | Restart restores each group's preset (not just the look) with no fade. | Groups can differ from the look; the node holds the last frame, so a fade would dip. |
| 2026-10-18 | Atomic writes and backups from the start (spec put backups in Phase 4). | A corrupt show file would stop a service. |
| 2026-10-17 | Engine is a pure package; DMX runs on a worker thread with a drift-free clock. | Same code for output, tests and tools; a slow request can't delay a frame. |
