# Volunteer Lighting Cue Runner — Specification

Oct 17, 2026 · @Ilmārs

> The original product spec for Light Runner, kept as written. Where the build deliberately departs from it, see [DECISIONS.md](DECISIONS.md); for what is built so far, see [STATUS.md](STATUS.md).

## Overview and goals

A browser-based lighting app lets untrained volunteers run a church service by tapping a handful of pre-built looks, each with its own effect. Control works on two levels: whole-room looks, and group presets that change only one group of lights. Manual control and a live stage visualiser cover everything in between.

Version 1 succeeds when:

- A new volunteer can run a full service after a 5-minute briefing.
- Every look change fades smoothly, including from one moving effect to another, with no visible jump or flicker.
- No volunteer action can leave the stage dark or broken; the Safe button always recovers.
- A 2-hour service runs with no visible stutter and no restart.
- Bitfocus Companion and a Stream Deck can trigger the same looks as the tablet.

## Control levels

Every light belongs to a group, and each group always runs exactly one group preset: a colour or palette, an effect and a fade. The three control levels differ only in how many groups they change at once.

| Level | Changes | Typical use | Who |
| --- | --- | --- | --- |
| Look | Every group listed in the look, each to its own preset | Switching service sections: Walk-in, Worship, Sermon | Operator and programmer |
| Group preset | One group only | Back wall to slow blue during a song, stage wash untouched | Operator and programmer |
| Manual | One group or one fixture | Quick fixes: brighten the pulpit, warm up a reader's face | Programmer; operators if enabled |

**Priority rules:**

- Per group, the newest look or group preset wins. A look changes only the groups it lists; the rest keep running.
- Manual sits on top of both. It holds until Release, then fades back to whatever preset that group is running at that moment.
- A group that differs from the current look is marked "changed" on the operator page. "Back to look" returns every group to the current look's presets.
- Master brightness and speed apply to every group. Safe and Blackout also clear all manual overrides.

## Users and roles

Two roles, separated by a PIN, keep volunteers away from anything that can break the setup.

| Role | Who | Can do | Cannot do |
| --- | --- | --- | --- |
| Operator | Sunday volunteers | Pick looks and group presets, use manual control if the programmer enables it, set brightness and speed, press Safe or Blackout | Change patch, groups or looks |
| Programmer | Lighting lead (1–2 people) | Everything: patch, groups, group presets, palettes, looks, button layout, visualiser plan, settings | — |

The operator page needs no login and opens straight from a bookmark on the tablet. The programmer page asks for a 4–6 digit PIN, stored hashed on the server. Several operator devices can be connected at once and always show the same live state.

## Volunteer interface

One screen, no menus, no scrolling on an iPad in landscape. Everything is reachable with a thumb and readable in a dark room.

**Layout, top to bottom:**

1. **Status bar.** Current look name, a green "Connected" dot (red and pulsing if the link drops), and a clock.
2. **Mini visualiser.** A small live view of the stage plan, one dot per fixture in its real colour, so the operator sees what the room shows without looking up. Tapping a group's area selects that group.
3. **Look grid.** 6–12 large buttons (at least 120 × 90 px), each with a name and a colour swatch or small animated preview of its effect. The active look has a bold outline; the look being faded into shows a progress fill.
4. **Group strip.** One button per group (Front wash, Back wall, Audience). Each shows the group's current colour and a badge: "changed" when it differs from the look, "M" when under manual control. Tapping a group opens its panel.
5. **Group panel.** Slides up over the look grid and affects only the selected group: its preset buttons, then a Manual tab (colour swatches, colour wheel, intensity fader) and a Release button. Closes with one tap outside.
6. **Two dials.** Master brightness (0–100%) and effect speed (50–200% of the programmed speed). Both have a small reset-to-default button. *Built differently: the speed dial became the tempo control (Tempo, ×2, ÷2, −, + and Tap in the top bar); see [the effects design](superpowers/specs/2026-10-19-effects-design.md).*
7. **Bottom row.** Back to look, Safe (large, always green) and Blackout (press and hold for 1 second to avoid accidents).

**Behaviour rules:**

- One tap on a look or group preset starts the fade immediately, using its programmed fade time (default 3 s). No confirm step.
- Tapping another look or preset mid-fade starts a new fade from whatever is on stage at that moment; nothing snaps.
- Group presets and manual changes affect only the selected group; every other group keeps running untouched.
- Manual changes follow the finger live with 0.2 s smoothing. Release fades back to the group's current preset in 1 s.
- Back to look returns every group to the current look's presets and clears manual overrides.
- Safe fades to a fixed warm white stage wash in 1 s, clears manual overrides, and resets brightness and speed to default.
- Blackout fades to zero in 1 s; tapping any look or Safe recovers from it.
- Looks are optionally grouped by service section (Before, Worship, Word, Response) with a small label above each group.
- Dark theme only, high contrast, no element brighter than needed so the tablet does not light the operator's face.
- Screen stays awake while the page is open (Wake Lock API).

## Programmer interface

A desktop-first page, usable on a laptop at the back of the room, with seven tabs.

1. **Patch.** Add fixtures by picking a profile, universe and start address. Warns on address overlaps. Profiles come from a built-in list plus imports from Open Fixture Library JSON.
2. **Groups.** Named, ordered sets of fixtures, e.g. Front Wash, Back Wall (left to right), Audience. Order matters because waves and chases travel along it. A fixture can belong to several groups; when two groups drive the same fixture, the most recent change wins.
3. **Group presets.** Pick a group, then build its presets: plain colour, palette plus effect, effect parameters and fade time. Each preset gets a name and a swatch for the operator button.
4. **Looks.** Build a look by choosing one preset per group, or leaving a group out so it keeps running. Each group can have its own fade time inside the look.
5. **Manual.** Full manual control for the programmer: per group or per fixture, colour picker, intensity, and raw values for any effect parameter. "Save as preset" turns the current manual state into a new group preset.
6. **Operator layout.** Arrange looks in the volunteer grid, set section labels, choose which groups and presets appear in the group strip, which look Safe uses, and whether operators get manual control.
7. **Settings.** Output (Art-Net IP or USB DMX port), frame rate, PIN, backup and restore.

**Stage visualiser.** Visible on every tab, drawn from the same output frames sent to DMX, so what you see is exactly what the rig would show. The programmer drags each fixture onto a 2D stage plan: a grid, or a photo or floor plan of the room uploaded as the background. Fixtures appear as coloured dots or beams in their real colour and intensity, and groups can be outlined. Two modes:

- **Live:** shows what is on stage now.
- **Blind:** previews a look, preset or manual change in the visualiser only, without sending it to the lights, until you press Go. This is how looks are built during a service or away from the church.

**Utilities:** a channel test view (raw 0–255 faders per channel), "highlight fixture" to find a light in the room, and export/import of the whole show as one JSON file.

## Data model

A whole show is one JSON document. Looks point to group presets, and presets point to groups and colours, never to DMX channels, so re-patching a fixture never breaks a look or preset.

| Entity | Key fields | Notes |
| --- | --- | --- |
| Fixture profile | name, channel list (role per channel: dimmer, red, green, blue, white, amber, UV, strobe, other), 8/16-bit flags | Built-in or imported from Open Fixture Library |
| Fixture | id, name, profile, universe, start address, stage x/y | One physical light; x/y places it on the visualiser plan |
| Group | id, name, ordered fixture ids | Order defines direction for waves and chases |
| Palette | id, name, list of colours (RGB hex + optional white level) | Shared across presets |
| Group preset | id, name, group, layer stack (up to 8 layers; one layer before Phase 2b), fade time, swatch | What a group panel button triggers |
| Look | id, name, list of group + preset + optional fade | What a look button triggers; groups not listed keep running |
| Manual override | group or fixture, colour, intensity | Runtime state only; saved only via "Save as preset" |
| Stage plan | background image, grid size | Visualiser layout |
| Library entry | id, name, tags, one layer or a whole stack, linked flag | Copied into presets when used (Phase 2b) |

**Effects in version 1.** Phase 2 ships these as single effects; Phase 2b turns them into the first entries of the layered library (see Effect library and layers):

| Effect | What it does | Parameters |
| --- | --- | --- |
| Static | Solid colour from the palette | colour index, intensity |
| Colour fade | Cycles smoothly through palette colours, all fixtures together | speed, intensity |
| Breathe | Intensity rises and falls gently | speed, depth (min–max %) |
| Wave | Colour or intensity travels along the group order | speed, spread, direction |
| Chase | One or more fixtures step on in sequence | speed, width, direction, fade between steps |
| Sparkle | Random fixtures briefly brighten | density, speed |

Speeds are stored as cycles per minute so the operator speed dial can scale every effect the same way. Strobe is deliberately left out of version 1 for photosensitivity reasons.

Example: one group preset and a look that uses it. The Audience group is not listed, so it keeps whatever it was running.

```json
{
  "presets": [
    { "id": "back-blue-wave", "name": "Blue wave", "group": "back-wall",
      "palette": "blue-purple", "effect": "wave", "speed": 6, "spread": 0.5,
      "direction": "left-to-right", "intensity": 1.0, "fade": 3.0 }
  ],
  "looks": [
    { "id": "worship", "name": "Worship",
      "groups": [
        { "group": "front-wash", "preset": "front-warm-static" },
        { "group": "back-wall", "preset": "back-blue-wave", "fade": 5.0 }
      ] }
  ]
}
```

## Effects engine and transitions

Every group runs its own fade. During a change, the outgoing and incoming presets of that group both keep running and are blended per fixture, so a chase fading into a wave never freezes, snaps or restarts, and other groups are not touched. This is the core of the app and gets the most testing.

**Frame pipeline (every 25 ms, 40 fps):**

1. Read a monotonic clock. Never use frame counts for timing, so a late frame does not slow effects down.
2. For each group, render its active presets into every fixture's abstract state: colour (R, G, B, W as 0–1 floats) and intensity (0–1).
3. Blend each group's presets by their current weights, then apply manual overrides on top.
4. Apply group levels and operator master brightness (both smoothed over 200 ms so fader and dial moves never step).
5. Apply each fixture's gamma curve (default 2.2) so slow fades look even at the dark end.
6. Map to the fixture's channels via its profile, quantise to 8 or 16 bits, and send the DMX frame.

**Effects are functions of phase, not of time directly.** Each effect keeps a phase that advances by speed × elapsed time each frame. Moving the speed dial changes how fast the phase advances, never the phase itself, so the effect speeds up smoothly instead of jumping.

**Transitions.** A fade is a weighted mix of a group's outgoing and incoming presets, using a smooth ease-in-out curve on progress p (0 to 1):

```latex
\text{out} = (1 - e(p))\,A + e(p)\,B, \qquad e(p) = 3p^2 - 2p^3
```

- Colour and intensity are blended separately. Blending only final RGB values makes red to blue pass through a dim muddy purple; blending colour and intensity separately keeps the room evenly lit during the change.
- A look is simply a set of group preset changes started at the same moment. A new look or preset tapped mid-fade is added on top of whatever that group is blending. Each group keeps a stack of up to 3 presets with weights; one whose weight falls below 1% is dropped.
- Safe and Blackout are ordinary looks with fixed 1 s fades, so they use exactly the same path.

**Done when:** a slow-motion recording of the preview shows no frame where any fixture jumps more than 5% in intensity during any fade between any two looks or presets, including mid-fade interruptions and manual release.

## Effect library and layers

Effects are combined from six building blocks instead of being coded one by one, so 7 waveforms yield a library of hundreds of named effects. Each group preset holds a stack of up to 8 layers. This arrives in Phase 2b; the 6 core effects become the library's first entries.

**Building blocks of one layer:**

| Block | Options | Example |
| --- | --- | --- |
| Waveform | sine, triangle, saw, square, step, random, smooth random (noise) | Smooth random for a candle flicker |
| Target | intensity, hue, saturation, palette position, white or amber mix | Hue for a slow colour drift |
| Range | minimum and maximum of the target | Intensity 70–100% |
| Spread | phase offset 0–360° across the group; direction left to right, right to left, centre out, outside in, random order | Centre out for a pulse from the middle of the stage |
| Grouping | blocks (n fixtures move together), wings (halves mirrored), groups (every nth fixture) | Wings 2 for a symmetrical stage |
| Timing | speed (cycles per minute), duty cycle, per-fixture delay, fade in and out | 25% duty for short flashes |

**Layer stack.** Layers render bottom to top. Each layer is one building-block combination plus a blend mode, an opacity (0–100%) and an on/off switch.

| Blend mode | Result | Typical use |
| --- | --- | --- |
| Replace | Covers the layers below, scaled by opacity | Base colour |
| Add | Adds to the layers below, clipped at 100% | Sparkle on top of a wash |
| Multiply | Scales the layers below | Breathe over a colour wave |
| Highest wins | Larger value per attribute | Two intensity chases combined |
| Mask | This layer's intensity limits what shows from below | A wave revealing a colour |

Example preset, "Ocean" on the back wall:

1. Replace: static deep blue
2. Add: hue sine wave, ±20°, spread 360° left to right, 4 cycles per minute
3. Multiply: intensity breathe, 70–100%, 3 cycles per minute
4. Add: white sparkle, smooth random, 5% density

**Library.**

- An entry is a named single layer or a whole stack, with tags (calm, upbeat, seasonal) and an animated thumbnail rendered by the engine itself.
- A built-in starter library ships with about 30 entries, including the 6 core effects.
- Using an entry copies it into the preset, so editing the library never changes a look someone relies on for Sunday. An optional "linked" flag keeps a preset in sync on purpose.
- The library imports and exports as JSON, so churches can share effects.

**Layer editor (programmer only).** A layer list with drag to reorder, solo and mute per layer, a parameter panel with a small waveform graph, and live preview in the visualiser in Blind mode. Volunteers never see layers; they still tap "Worship".

**Rendering rule.** Every layer is a pure function of phase, the fixture's position in its group, and its parameters. The stack is evaluated per fixture before presets are blended, so transitions work exactly as in the previous section. The budget of 30 fixtures × 8 layers × 40 fps is about 10,000 evaluations per second, far below what a Raspberry Pi can do.

**Left for later:** modulators (one wave driving another's speed or range), tap tempo and beat sync, and position effects for moving heads.

## System architecture

One small server runs everything. Browsers and Companion only send commands and display state, and only the engine thread writes DMX.

**Stack:** Node.js LTS on the server, plain HTML and JavaScript (or React) for the two pages, WebSocket for live state, a worker thread for the engine, and Art-Net over UDP port 6454 or USB DMX over serial. The app runs as a service (launchd on a Mac, systemd on a Pi) that starts on boot. Every connected device receives a state update within 100 ms of any change.

## External control API

Companion, a Stream Deck or any other tool controls the app through the same commands as the operator page, so every device always agrees on what is live.

**HTTP (for Bitfocus Companion's Generic HTTP module):**

| Method and path | Effect |
| --- | --- |
| `POST /api/look/{id}` | Fade to look, using its fade times |
| `POST /api/look/{id}?fade=5` | Fade to look over 5 s |
| `POST /api/group/{group}/preset/{id}` | Fade one group to a preset |
| `POST /api/group/{group}/manual` | Manual colour and intensity for one group (JSON body) |
| `POST /api/group/{group}/release` | Release manual control of one group |
| `POST /api/back-to-look` | Return every group to the current look |
| `POST /api/safe` | Safe look |
| `POST /api/blackout` | Blackout |
| `POST /api/master/{0-100}` | Set master brightness |
| `POST /api/speed/{50-200}` | Set speed multiplier |
| `GET /api/state` | Current look, each group's preset and manual status, fade progress, master, speed, connection status (JSON) |
| `GET /api/looks` | Looks and group presets with id, name and colour, for building buttons |
| `POST /api/group/{group}/level/{0-100}` | Set one group's level (same as an APC mini fader) |

**OSC (UDP port 8000):** the same commands as addresses, e.g. `/look worship`, `/group back-wall blue-wave`, `/master 80`, `/safe`. Useful for ProPresenter or a sound desk triggering looks.

**Companion feedback:** Companion polls `GET /api/state` every 500 ms so the active look's button can light up on the Stream Deck.

The API only accepts requests from the local network. Programmer-level actions (patch, editing looks) are not exposed.

## MIDI controllers (APC mini and similar)

A grid controller gives volunteers physical buttons and faders: one press per look or preset, with pad lights showing what is live. Controllers plug into the server by USB, so they keep working if a tablet drops off Wi-Fi. If the server is not at the operator position, a USB extension or a network MIDI bridge (rtpMIDI) is used.

| Device | What it offers | Support |
| --- | --- | --- |
| Akai APC mini mk2 | 8×8 RGB pads, 17 buttons, 9 faders | Built-in profile, full colour feedback |
| Akai APC mini mk1 | 8×8 pads (green, red, amber), 17 buttons, 9 faders | Built-in profile, 3-colour feedback |
| Novation Launchpad Mini or X | 8×8 RGB pads, no faders | Built-in profile |
| Akai APC40 mk2, Akai MIDImix, Korg nanoKONTROL2, Behringer X-Touch Mini | Pads, knobs, faders | Generic profile set up with MIDI learn |

**Default APC mini mapping:**

- **Rows 1–2:** 16 looks. The active look lights bright in its swatch colour, the others dim; a look that is fading in blinks.
- **Rows 3–8:** group presets. Each column is one group and each row one of its presets, so 8 groups with up to 6 presets each. The group's active preset lights bright.
- **Track buttons:** select a group for manual control on the tablet; lit while that group is under manual. Shift plus a track button releases that group.
- **Scene buttons:** Safe, Blackout (hold 1 s), Back to look, Release all manual, Speed −, Speed +, Speed reset, Next page of looks.
- **Faders 1–8:** group level, an intensity multiplier per group. **Fader 9:** master brightness.

**Behaviour rules:**

- Pads send the same commands as the operator page and the API, so tablet, Stream Deck and controller always agree.
- Faders use soft takeover: a fader does nothing until it passes the current value, so a fader left in the wrong position never makes the lights jump. The tablet shows the fader position until it catches up.
- Pad lights refresh on connect and on every state change; unplugging and replugging restores them within 1 s.
- Controllers follow operator permissions: manual-control buttons work only if the programmer has enabled manual for operators.
- Several controllers can be connected at once.

**Programmer setup.** A Controllers tab in Settings lists connected devices, picks a profile, and offers MIDI learn for any pad, button, fader or knob on generic devices. Mappings are saved per device model. The server reads MIDI with a Node MIDI library (such as easymidi) and handles hot-plugging.

## Reliability and failure behaviour

The stage must keep its current look whatever fails, because a frozen look is invisible to the congregation and darkness is not.

| Failure | Required behaviour |
| --- | --- |
| Tablet Wi-Fi drops | Lights keep running on the server. Operator page shows a red banner and reconnects automatically every 2 s, then resyncs state. |
| Tablet battery dies or browser closes | No effect on stage. Any other device can open the page and take over. |
| Server process crashes | Process manager restarts it within 5 s. On restart it restores the last active look, master and speed from disk. |
| Server computer sleeps or reboots | Sleep is disabled in setup. On boot the app starts automatically and restores the last look. |
| Art-Net node or USB interface unplugged | Engine keeps running and retries every 1 s; status bar shows "Output lost". |
| Corrupt or missing show file | Loads the last good automatic backup (one kept per save, last 20 kept). |

**Design rules that make this work:**

- The server is the single source of truth; browsers only send commands and display state.
- State (current look, master, speed) is written to disk on every change, at most once per second.
- The Art-Net node should be set to hold the last frame on signal loss. Note this in the setup guide; it is a node setting, not app code.
- The output loop runs in its own worker thread, so a slow web request can never delay a DMX frame.
- A soak test runs the engine for 8 hours with random look changes every 10–60 s before each release.

## Non-goals for version 1

These are left out on purpose to keep the first version small and reliable; each can be revisited later.

- Moving heads: pan, tilt, gobos, positions and shape effects.
- Strobe effects.
- Timecode, audio-reactive or beat-synced effects.
- A 3D visualiser (the 2D stage visualiser covers testing).
- sACN output (Art-Net and USB DMX only).
- Timed cue stacks that run automatically. Every change is triggered by a person.
- Multi-user editing of looks at the same time.
- Remote access over the internet.

## Build phases

Five phases, each usable in a real service on its own, so the app earns trust step by step.

**Phase 1: Static looks with fades**

Server, Art-Net and USB output, patch, groups, palettes, static group presets and looks, manual control, per-group fades, Safe and Blackout, basic stage visualiser.

- [ ] A static look fades in over 3 s with no visible stepping on real fixtures
- [ ] Tapping a second look mid-fade continues smoothly, and a group preset change leaves every other group untouched
- [ ] Server restart restores the last look within 5 s

**Phase 2: Effects engine**

Colour fade, breathe, wave, chase, sparkle inside group presets; speed control; transitions between moving effects; blind preview in the visualiser.

- [ ] Every pair of effects fades into each other with no jump above 5% (see Effects engine)
- [ ] Speed dial changes never cause a visible jump
- [ ] Output timing stays within ±3 ms of 25 ms per frame over 1 hour

**Phase 2b: Layered effect library**

Waveform and layer engine, blend modes, layer editor, effect library with tags and thumbnails, starter library, JSON import and export.

- [ ] The 6 core effects are reproduced exactly as library entries
- [ ] A 4-layer preset fades into another 4-layer preset with no jump above 5%
- [ ] Output timing stays within ±3 ms of 25 ms per frame with 30 fixtures × 8 layers
- [ ] Editing a library entry leaves presets that copied it unchanged

**Phase 3: Volunteer page**

Look grid, group strip and panel with presets and manual, mini visualiser, dials, Back to look, Safe, Blackout hold, multi-device sync, reconnect banner, Wake Lock.

- [ ] A volunteer who has never seen the app runs a mock service after a 5-minute briefing
- [ ] Two tablets show the same state within 200 ms of any change
- [ ] Killing Wi-Fi on the tablet does not change the stage

**Phase 4: Integrations and polish**

HTTP and OSC API, Companion feedback, MIDI controllers with APC mini mk1 and mk2 profiles, show export/import, automatic backups, 8-hour soak test.

- [ ] A Stream Deck button triggers a look and lights up while it is active
- [ ] 8-hour soak test passes with no crash or memory growth above 10%

## Open questions and assumptions

The spec assumes 10–30 LED fixtures (RGB, RGBW or RGBA) on 1–2 DMX universes, and a Mac or Raspberry Pi left permanently at the church. These questions decide details before Phase 1 starts:

- [ ] Which fixtures and channel modes are in the rig?
- [ ] Output via an Art-Net node (which model?) or a USB interface such as ENTTEC DMX USB Pro?
- [ ] Server hardware: an existing Mac, a dedicated mini PC, or a Raspberry Pi 4/5?
- [ ] Does the church Wi-Fi isolate clients from each other? If so, a dedicated lighting router is needed.
- [ ] Which groups does the rig split into, and which presets does each group need?
- [ ] Which looks does a typical service need? A list of 6–12 names sets the default operator grid.
- [ ] Should volunteers get manual control, or only the programmer?
- [ ] Is there a floor plan or stage photo to use as the visualiser background?
- [ ] Are there conventional (non-LED) dimmers or house lights that should also be controlled?
- [ ] Should ProPresenter or the sound desk trigger looks via OSC, or only Companion?
- [ ] Who besides the lighting lead needs the programmer PIN?
