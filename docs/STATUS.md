# Status

Last updated: 18 Oct 2026. Update this file whenever a feature lands or a priority changes, so whoever picks the project up next (on any computer) knows where things stand.

## Built

| Area | What works | Spec phase |
| --- | --- | --- |
| Engine | Per-group fades with ease-in-out; a change mid-fade continues from what is on stage; fixtures shared by groups hand over with a fade; manual override (0.2 s in, 1 s release); group levels and master (200 ms smoothing); Undo (20 steps); operator fade time (Auto / fixed); gamma 2.2; 8/16-bit and colour-temperature (CCT) channels; multi-segment bars | 1 |
| Output | Art-Net, sACN (multicast or unicast) and ENTTEC DMX USB Pro on a worker thread at 40 fps; Send DMX on/off switch; Art-Net node finder; node watch (warns when the node stops answering or another desk is also sending) | 1 (+ sACN) |
| Reliability | Atomic saves with 20 backups and fallback to the last good one; restore of the last stage after a restart, with no fade; worker restarted automatically if it crashes; reconnect every 2 s with a banner on the tablet | 1, 3 |
| Operator page | Look tiles that fill the screen, each with a colour strip per group; Next (service order); Undo; group strip with preset names and "changed" badges; group preset panel; Master fader plus a Groups button that opens group dimmers; quiet Fade menu; DMX status bar; fade countdown; live stage view; Safe; Blackout (hold 1 s) | 3 (mostly) |
| Patch page | Lightkey-style DMX map per universe (drag to re-address, overlaps striped red); fixture table; add many fixtures at once; groups (order, members); stage plan (drag); Identify (flash white 3 s) | Programmer tab 1–2 |
| Fixture database | Open Fixture Library: search, browse by manufacturer, add a fixture's DMX mode as a type; whole database downloadable for offline use (645 fixtures), with "Check for updates" listing new/changed/removed before installing; import an OFL fixture file | Programmer tab 1 |
| Settings page | Output, frame rate, gamma, operator manual permission, Safe look, PIN, backups, export, and "Compare with a file" (show file or Lightkey project: tick which changes to take) | Programmer tab 6–7 |
| HTTP API | Looks, presets, manual, release, back to look, Safe, Blackout, master, speed, group level, undo, fade time, state, looks list; local network only | 4 (HTTP part) |
| Tools | Lightkey importer, jump check (no fixture steps >5% per frame over hours of random changes), timing probe | — |

Tests: 58 (`npm test`), all passing.

## Not built yet (in rough priority order)

1. **Run as a service on the church Mac** (launchd, start at boot, restart on crash, sleep off). Today it only runs while someone starts it.
2. **Test on the real iPad**: add to home screen, Auto-Lock Never (Wake Lock needs HTTPS), check sizes in the dark room, short volunteer trial.
3. **Record look / edit colours**: set the stage, tap Record, name it; edit a preset's colour, level and fade; edit the palette. Today looks and presets come only from the Lightkey import or the show file.
4. **Effects (spec Phase 2)**: colour fade, breathe, wave, chase, sparkle; speed dial; blind preview. The engine's layer model is ready for them.
5. **Companion feedback, OSC and MIDI (APC mini)**: the HTTP API exists; OSC and MIDI do not.
6. **Spec Phase 2b**: layered effect library and editor.
7. **Programmer niceties from the spec**: channel test view, manual tab with raw values, Blind mode, stage photo background, operator layout editor.

## Known issues

- Frame timing: about one frame in a few minutes is up to 3.4 ms late (spec: ±3 ms). Not visible, but the spec's 1-hour timing test would fail on it.
- The stage view on the operator page keeps showing the last frame while the tablet is offline (the red banner does show).
- "Compare with a file" with the Lightkey project lists P5 as new and ticked; untick it (P5 is not used).
- Group names in the bottom dimmer bar are not shown any more (they are in the Groups panel).

## Open questions

- Should a look remember the dimmer fader levels, or should faders stay a live adjustment that Safe resets? (Current: live adjustment.)
- Who besides the lighting lead gets the programmer PIN? (No PIN is set yet.)
- Effects needed first on the bars (Phase 2)?
- Should ProPresenter or the sound desk trigger looks over OSC?
