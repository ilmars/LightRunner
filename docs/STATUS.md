# Status

Last updated: 19 Oct 2026. Update this file whenever a feature lands or a priority changes, so whoever picks the project up next (on any computer) knows where things stand.

## Built

| Area | What works | Spec phase |
| --- | --- | --- |
| Engine | Per-group fades with ease-in-out; a change mid-fade continues from what is on stage; fixtures shared by groups hand over with a fade; manual override (0.2 s in, 1 s release); group levels and master (200 ms smoothing); Undo (20 steps); operator fade time (Auto / fixed); gamma 2.2; 8/16-bit and colour-temperature (CCT) channels; multi-segment bars | 1 |
| Output | Art-Net, sACN (multicast or unicast) and ENTTEC DMX USB Pro on a worker thread at 40 fps; Send DMX on/off switch; Art-Net node finder; node watch (warns when the node stops answering or another desk is also sending) | 1 (+ sACN) |
| Reliability | Atomic saves with 20 backups and fallback to the last good one; restore of the last stage after a restart, with no fade; worker restarted automatically if it crashes; reconnect every 2 s with a banner on the tablet; the server checks each tablet every 2 s and drops one that stops answering, which puts its Flash out | 1, 3 |
| Operator page | New layout for the iPad (design: [operator layout](superpowers/specs/2026-10-19-operator-layout-design.md)): a running order down the left (Basic lights always first, then songs; Edit to rename, delete, add and drag to reorder) above a small stage view; quick looks (Plain, Colours, Effects) that set only some groups, and Save stage as quick look; Details for the item on stage with a colour picker, Any colour and a dimmer per group, Back to the saved look and Save (hold 1 s); a top bar that shows only what matters (fade, Flash, lights not answering); Next, Undo, Master, Flash buttons (All and one per group, white) and Blackout (hold 1 s). Looks remember group levels. Everything is shared by all tablets through the server | 3 |
| Smoke machine | A group can be marked "Smoke or haze machine" in Patch. Its fixtures get only a level (dimmer channel, or the only channel; linear, no gamma). On the operator page it has a grey level slider and a Puff button (hold: full; ends when let go, when the tablet drops off, or after 15 s), no colour and no Flash button; the top bar says "Smoke: N %" while it runs. Looks, quick looks, Undo, Master and Flash All never touch it; Basic lights and Blackout turn it off (and its slider waits while Blackout is on); it is always off after a restart. Compare with a file keeps it a smoke group. Open Fixture Library fog channels become its dimmer, and Patch warns about a smoke machine it can't drive or one left in a light group (see DECISIONS, 19 Oct) | — (owner's request) |
| Patch page | Lightkey-style DMX map per universe (drag to re-address, overlaps striped red); fixture table; add many fixtures at once; groups (order, members); stage plan (drag); Identify (flash white 3 s) | Programmer tab 1–2 |
| Fixture database | Open Fixture Library: search, browse by manufacturer, add a fixture's DMX mode as a type; whole database downloadable for offline use (645 fixtures), with "Check for updates" listing new/changed/removed before installing; import an OFL fixture file | Programmer tab 1 |
| Settings page | Output, frame rate, gamma, operator manual permission, PIN, backups, export, and "Compare with a file" (show file or Lightkey project: tick which changes to take). Basic lights is not chosen here any more: it is set by Save on the operator page, and a show that loses it gets an empty one back | Programmer tab 6–7 |
| HTTP API | Looks, presets, manual, release, back to look, Basic lights (`POST /api/safe` starts it), Blackout, master, speed, group level, undo, fade time, state, looks list; local network only | 4 (HTTP part) |
| Tools | Lightkey importer, jump check (no fixture steps >5% per frame over hours of random changes), timing probe | — |

Tests: 155 (`npm test`): 154 pass, 1 is skipped (the Lightkey project test, needs `LIGHTKEY_PROJECT`).

## Not built yet (in rough priority order)

1. **Run as a service on the church Mac** (launchd, start at boot, restart on crash, sleep off). Today it only runs while someone starts it.
2. **Test on the real iPad**: add to home screen, Auto-Lock Never (Wake Lock needs HTTPS), check sizes in the dark room, short volunteer trial.
3. **Edit colours**: edit a preset's colour, level and fade; edit the palette. Today presets come only from the Lightkey import, the show file or Save on the operator page.
4. **Effects (spec Phase 2)**: colour fade, breathe, wave, chase, sparkle; speed dial; blind preview. The engine's layer model is ready for them.
5. **Companion feedback, OSC and MIDI (APC mini)**: the HTTP API exists; OSC and MIDI do not.
6. **Spec Phase 2b**: layered effect library and editor.
7. **Programmer niceties from the spec**: channel test view, manual tab with raw values, Blind mode, stage photo background, operator layout editor.

## Known issues

- Frame timing: about one frame in a few minutes is up to 3.4 ms late (spec: ±3 ms). Not visible, but the spec's 1-hour timing test would fail on it.
- The stage view on the operator page keeps showing the last frame while the tablet is offline (the red banner does show).
- "Compare with a file" with the Lightkey project lists P5 as new and ticked; untick it (P5 is not used).
- One server test (show saved with backups) has failed once on Windows and passed on re-run.
- Each Save of an Any colour adds a hidden custom preset; old ones aren't cleaned up.
- Not yet tried on the real iPad: finger drag in the running order, the on-screen keyboard over the quick-look sheet, two fingers on Flash, pointer capture on iOS Safari.
- Restoring a backup from before a group was marked as a smoke machine brings that group back as a light (Basic lights and looks would drive it); mark it again in Patch. "Compare with a file" never changes whether a group is smoke.
- Smoke support has not met a real smoke or haze machine yet. Machines with a separate fan or mode channel need a fixture type whose level channel is "dimmer" (Patch warns when it isn't); other channels keep their fixed values.
- The server test "Add, rename, move and delete edit the running order" has failed once in a full run on Windows and passed on re-run.

## Open questions

- Who besides the lighting lead gets the programmer PIN? (No PIN is set yet.)
- Effects needed first on the bars (Phase 2)?
- Should ProPresenter or the sound desk trigger looks over OSC?
