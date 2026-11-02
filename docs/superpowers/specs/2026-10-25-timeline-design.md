# Timeline: design

Date: 25 Oct 2026. Status: agreed with Ilmārs (25 Oct), from a mockup.

## Why

For Christmas the church plans a pre-recorded spoken-word piece as the opening of the service, with a video on the projection screen. The owner's picture (his words): the room starts dark; slowly, with a tempo, lights rise brighter and brighter until the whole stage is at full; and some lights follow the voice, "like a spectrum of the voice". Today Light Runner only changes the lights when someone taps; nothing runs by itself in step with a recording, and nothing reacts to sound.

The owner first thought of a separate app that would control Light Runner (not the lights), like an audio editor with layers of triggered looks; then agreed it should be part of Light Runner as a new page. He added an idea: a timeline you make can also be used again like an effect.

## Goals

### 1. The Timeline page (for Christmas)

A new page, **Timeline** (`/timeline/`), next to Operator, Patch and Settings, opened in any computer's browser (the Mac, or a PC at the mixer); programmer PIN like Patch and Settings. The mockup the owner approved: `.superpowers/brainstorm/3117-1792956273/content/timeline-editor.html` (layout and words; the look follows the design system).

- **Timelines are part of the show**: a list of them (New, rename, delete); each has a name and optionally **a recording** (an audio file added from the page: mp3, m4a/aac, wav; up to about 15 minutes).
- **Top bar**: the timeline's name, the recording and its length, **Live / Prepare**, the play position (0:00.0 / total), **▶ Start**, **■ Stop**, and moving the play position (click/tap on the ruler or waveform).
- **The recording's waveform** under a time ruler; **zoom** in and out; **◆ Mark here** drops a named marker at the play position while listening (markers are notes: "In the beginning…"; they do nothing to the lights).
- **Layers**: **Whole stage** and one per light group (smoke groups too, for a Puff later — see non-goals), shown in the show's group order; **＋ Layer** adds a group's layer if it was removed.
- **Blocks** on a layer, each with a start time and an end (an explicit time or "until the next block on this layer"). A block is one of:
  - a **colour** of that group (from its colour list) at a **level**;
  - a **level** only (dim the group up or down, keeping its colour);
  - an **effect** of that group (from its effect list), with its speed;
  - on **Whole stage**: a **look** (a song or quick look from the show), **Dark** (everything off), or **Everything full**;
  - **Follow the voice** (on a group's layer): the group's level rides on the recording's loudness for that stretch (see below).
  Each block has a **rise / fade in** time (how long it takes to reach its colour and level from whatever is on stage). Blocks are dragged to move, their edges to change start/end; the selected block's details are edited below the layers (what, level, starts at, rise, until); **Start at play position** snaps its start to where you are listening; **Delete**.
- **Follow the voice**: when a recording is added, the page works out its loudness over time once (in the browser, from the decoded file) and stores it with the timeline, so the lights never depend on a live microphone, room noise or the network. During a Follow the voice block the group's level follows that loudness between a **low** and a **high** level (set on the block, e.g. 10 % and 100 %), smoothed so it never flickers.
- **Live and Prepare**, as on the operator page: in **Prepare** the timeline plays on the stage view and the speakers only; the real lights stay as they are. In **Live**, Start plays the recording in this browser and the lights follow it.

### 2. Playing it (the owner: "the app runs on the Mac, but it could be opened and run from another PC")

- **Where Start is pressed, the sound plays**: the browser that presses ▶ Start plays the recording (into whatever that computer is plugged into, e.g. the mixer).
- **The lights follow the sound**: that page tells the server where the recording is, a few times a second; the server runs the timeline on its own clock and keeps it on that position (pausing, stutter or moving the play position are followed).
- **If that browser drops off** (Wi-Fi blip, tab closed), the server carries on with the timeline by itself to its end; the stage never freezes half way.
- **A timeline without a recording** runs on the server's clock alone; Start can then be pressed on any page that shows it.
- **Stopping**: ■ Stop, **Blackout**, **Basic lights** or starting a song stop a running timeline at once (as they stop an effect); the stage then does what that button does. Stop leaves the stage as it is at that moment.
- **Other pages** show that a timeline is running (on the operator page's top bar, like the Prepare state is shown), with its name and position, and a way to stop it.

### 3. A timeline used as an effect (the owner's extra idea)

- A timeline **without a recording** can be measured in **beats** instead of seconds (it then follows the tempo, like effects do) and can **loop**.
- It can be started like a look: as a step in the **running order**, from a **quick look**, or from a **controller key**.
- This comes after the Christmas page works (see "After it is built"); the design must not block it (timelines in the show, blocks that don't care whether time is seconds or beats).

## Non-goals

- WorshipTools Presenter starting the lights, or the timeline starting Presenter (kept for later by the owner; see the work list item "Later: WorshipTools Presenter and the timeline").
- Timecode in or out (LTC, MTC, Art-Net timecode); following a live microphone or the mixer's sound; analysing pitch/"spectrum" into colours (the voice drives level, not colour, for now).
- Playing the video (Presenter shows it).
- Smoke Puff blocks (the layer is there; Puff blocks can come later).
- Editing audio (cutting, volume): the recording is used as it is.

## Anti-goals

- **Anything that jumps or flickers.** Every block change fades; Follow the voice is smoothed; the existing light-safety rules and `npm run jump-check` (no fixture steps more than 5 % in a frame) hold, with timelines running (extend the jump check to run timelines).
- **The lights running away from the sound** (a timeline that keeps going after the recording was stopped, or sits seconds off): the sound's position is the truth while the page is there.
- **A timeline that can't be stopped**, or that blocks Blackout or Basic lights.
- **Prepare touching the real lights.**
- A second program or path sending to the lights: the timeline sends the same commands everything else does, through the server.

## Constraints

- The engine stays pure (takes `now`, returns DMX); timers, the timeline clock, audio files and sync live in the server. Every change the timeline makes goes through the same commands as everything else (`App.command()`), or a new command where needed (e.g. a level change with a fade time — `groupLevel` has none today; Follow the voice needs a per-frame level input that is smoothed).
- Recordings are stored in the data folder beside the show (not inside show.json); the timeline in the show refers to its recording by a file id. Export show file carries the timelines, not the audio: on another computer the page says the recording is missing and offers to add it.
- Plain JS page (no framework, no build), the design system (dark, nothing bright, 44 px targets, quiet controls), works in Safari on the iPad and Chrome/Edge/Safari on a laptop; the browser decodes the audio (Web Audio) for the waveform and the loudness.
- `npm test`, `npm run typecheck`, `npm run jump-check` pass; engine behaviour gets engine tests; the sync logic is testable without a browser.
- **Christmas is the deadline**: the owner will build the intro in December, so the page must be usable well before (aim: end of November).

## Decided by the owner (25 Oct, after the review)

- **Who starts it at Christmas:** the programmer (with the PIN) presses ▶ Start on the Timeline page, on a laptop or the Mac plugged into the mixer; the sound plays from that computer. Volunteers do not start recorded timelines from the operator page (a running-order step is goal 3, without a recording).

## Calls made while writing this up (not the owner's; check them)

1. **One Live timeline at a time**, run by the server; starting another stops the first. **Prepare** runs the timeline in that page's own Prepare draft (the server's per-tablet draft), with the sound in that page; it never touches the real lights and can run while a Live timeline runs elsewhere.
2. **The timeline is a function of its play position**: the stage at time t is worked out from the timeline's own blocks (what each layer's latest block at t says, with its rise counted from the timeline's own state just before the block, not from live history), so playing, seeking and replaying give the same result. A seek, or Start in the middle, fades to the state at that point over 1 s. **Start** at 0:00 fades from whatever is on stage to the timeline's first state; a new timeline gets a **Dark** block at 0:00 on Whole stage, so it starts dark unless you remove it.
3. **Layers**: on any group, the block that started most recently wins (a Whole stage block applies to every group at its start; a later group block overrides that group). A block with an explicit end takes its layer back, over its rise time, to what the timeline had on that layer before it (or, if nothing, to the stage as it was when the timeline started). When the timeline ends, the stage stays as it is (like Stop).
4. **Other inputs while it runs**: Flash, Master, the Individual lights holds and the stage view work on top as always. A quick look or a group's colour/level/effect tapped by hand changes those groups until the next block on their layer (the timeline is like an operator tapping at set times). Stop, Blackout, Basic lights and starting a song stop it (goal 2).
5. **Follow the voice** rides the level of whatever colour the group has at that moment (from an earlier block or the stage), between the block's **low** and **high** level; a block may also carry a colour of its own, then the group fades to it at the block's start. At the block's end the group fades back to the level the timeline gives it (over 1 s). The loudness is one track per recording at 25 values a second, smoothed (fast rise, slower fall) within the jump-check limit.
6. **Recordings**: mp3, m4a/aac or wav up to 100 MB, uploaded (streamed) behind the PIN into the data folder, played by the page's audio element from the server with range requests (it streams, nothing is decoded on playback). The waveform and loudness are worked out once, in the browser that adds the file, and stored with the timeline; a laptop is the recommended place to add a long file (an iPad may struggle with a long wav).
7. **Lights earlier / later**: a per-timeline setting in milliseconds (−500 to +500, default 0) to line the lights up with sound that reaches the room late through the mixer or a projector.
8. **Keeping in step**: the page reports its position about 4 times a second; within 100 ms the server eases its clock towards it, beyond 300 ms it jumps there (with the 1 s fade of call 2); between, it eases faster. Nothing the merge does may step a light more than the jump-check allows.
9. **Editing while it runs** is allowed; a change takes effect from the next block. A block whose group, colour, effect or look was deleted is shown as missing and skipped. A missing recording is shown with "Add the recording"; the timeline can still run silently on the server's clock.

## Left to the builder

- The data shape of timelines, blocks and the loudness track; how the server clock and the page's position reports are merged (as long as the lights follow the sound and carry on without it).
- How Follow the voice is smoothed (attack/release) within the jump-check limit.
- How the operator page shows a running timeline, and its Stop.
- Zoom levels, snapping, keyboard shortcuts on a laptop.

## After it is built

- Docs: a "Timeline" part in `docs/setting-up-a-show.md`, the service guide (running it at Christmas: test in Prepare, then Live), the skill, STATUS, DECISIONS, README.
- Then goal 3 (timeline as an effect), then the Presenter link.
