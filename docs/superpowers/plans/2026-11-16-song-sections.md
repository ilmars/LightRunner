# Song sections and Auto-follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Songs loaded from the planning service come with their sections (verse, chorus …) and facts (key, tempo, time signature, chords); a section can have its own look; and with Auto-follow on, the lights follow the presentation app to the next item and to the section on screen.

**Architecture:** Sections and facts are read from the song library at load (pure, `packages/shared`). A section has a look only once a change is saved for it; until then it plays the song's look. The server keeps which section is on stage. A live connection (`server/src/planning/live.ts`) turns the presentation app's slide messages into `LiveSlide`s, a pure `followDecision` says what to start, and the App starts it: a new item as a tap would, a section within the same song as a colours-and-levels change that leaves tempo and timeline alone. Any start by hand switches Auto-follow off.

**Tech Stack:** TypeScript on Node 24 (type stripping, no build), zod, `node:test`; plain HTML/JS pages; Node's own `WebSocket` and `fetch`.

**Spec:** [docs/superpowers/specs/2026-11-16-song-sections-design.md](../specs/2026-11-16-song-sections-design.md) (builds on [the planning design](../specs/2026-10-25-planning-service-design.md) and [the research note](../../notes/song-sections-research.md)).

## Global Constraints

- TypeScript with erasable syntax only (no enums, namespaces or parameter properties), `.ts` import extensions, `import type` for types.
- The engine stays pure; timers, sockets and files live in `server/`. New engine behaviour gets a test in `packages/engine/test`.
- Every input becomes a `Command` (`packages/shared/src/protocol.ts`) through `App.command()`; pages only display state.
- No new dependencies: Node 24's `WebSocket` and `fetch`.
- No network in `npm test`; server tests use `FakePlanning` and a fake live socket. Never use `data/worshiptools-login.json` or any planning login on this PC: a second copy of the login can log the church Mac out.
- No lyrics are stored anywhere (show, logs, fixtures); chords as chord names only.
- Docs (STATUS, DECISIONS, guides, specs, plans) never name the planning service or the presentation app; code, comments and pages may.
- UI: design-system tokens and `ds-` components, dark, quiet, 44 px targets, iPad 1080 × 810; plain words, sentence case.
- Before every commit: `node --test "packages/*/test/*.test.ts" "server/test/*.test.ts" "launcher/test/*.test.js"` passes (two LAN tests always fail on this PC, and a whole-file crash can be a flake: rerun that file), `node node_modules/typescript/bin/tsc --noEmit` passes, and for Tasks 2, 5 and 6 `node tools/jump-check.ts` and `node tools/jump-check.ts --show shows/stage-l1.json` PASS.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `song-sections`; don't push.

## Review Focus

1. A song whose slides are all "Slide N" or untitled: no sections, no section rows, no save bar, and its slides never change the lights while followed. (Task 1, Task 3.)
2. The same song twice in one service: each item is told apart by its cue id, and both share the song's section looks. (Task 3.)
3. Messages arriving twice, late or not at all: following is idempotent (a message naming what is already on stage starts nothing) and the next message puts it right. (Task 3, Task 5.)
4. A song row deleted in Edit list, or a reload without the song: its slides change nothing and nothing throws; a delete takes its section looks with it. (Task 2, Task 3.)
5. A tablet in Prepare while Auto-follow changes the stage: its draft is untouched and its own taps don't pause following. (Task 5.)

---

### Task 1: Sections and song facts from the library

**Files:**
- Create: `packages/shared/src/sections.ts`
- Modify: `packages/shared/src/planning.ts` (`ServiceItem`, `toPlannedService`), `packages/shared/src/index.ts`
- Test: `packages/shared/test/sections.test.ts`, `packages/shared/test/planning.test.ts`

**Interfaces:**
- Produces:
  - `SectionKind = z.enum(['verse', 'pre-chorus', 'chorus', 'bridge', 'tag', 'intro', 'outro', 'interlude'])`; `SECTION_NAMES: Record<SectionKind, string>` = Verse, Pre-chorus, Chorus, Bridge, Tag, Intro, Outro, Interlude
  - `sectionKindOf(title: string): SectionKind | null`
  - `songSections(song: unknown): SongSection[]`, `SongSection = { kind: SectionKind; slides: string[]; chords?: string[] }` (kinds in order of first appearance; `slides` every library `slide_id` of that kind; `chords` left out until Task 0's finding is built in)
  - `ServiceItem` gains `sections?: { kind; slides: string[]; chords?: string[]; look?: id }[]` (max 8, slides max 200, chords max 64 names of max 12 characters), `key?: string` (max 8), `timeSignature?: string` (max 8), `artist?: string` (max 200), `notes?: string` (max 500)

- [ ] **Step 0 (church Mac, not this PC): find where the chords are.** Write `docs/notes/song-chords-research.md` from the church Mac session: the field names and shape that hold chords in a song document (inline marks in `slide_content`, or a separate field), one example section's chord names, no lyrics. If it can't be done before Task 1 is built, build Task 1 without `chords` and add them in a later small task from that note.
- [ ] **Step 1: Write the failing tests** (`sections.test.ts`)

```ts
test('section kinds from slide titles', () => {
  const cases: [string, string | null][] = [
    ['Verse 1a', 'verse'], ['Verse 2 b', 'verse'], ['Verse', 'verse'], ['PreChorus', 'pre-chorus'], ['Pre-Chorus 1', 'pre-chorus'],
    ['Chorus a', 'chorus'], ['Chorusb', 'chorus'], ['Chorus 2 a', 'chorus'], ['Chorus a EN', 'chorus'], ['chorus eng', 'chorus'],
    ['Bridge 1 a', 'bridge'], ['Tag', 'tag'], ['Intro', 'intro'], ['Ending', 'outro'], ['Outro', 'outro'],
    ['Instrumental', 'interlude'], ['Slide 11 a', null], ['', null], ['Choruses of angels', null],
  ];
  for (const [title, kind] of cases) assert.equal(sectionKindOf(title), kind, title);
});

test('a song lists each kind once, in order of first slide, with all its slides', () => {
  const song = { data: { slides: [
    { slide_id: 'v1', slide_title: 'Verse 1a' }, { slide_id: 'c1', slide_title: 'Chorusa' }, { slide_id: 'c2', slide_title: 'Chorus b' },
    { slide_id: 'v2', slide_title: 'Verse 2' }, { slide_id: 's', slide_title: 'Slide 9' }, { slide_id: 'b', slide_title: 'Bridge' },
  ] } };
  assert.deepEqual(songSections(song), [
    { kind: 'verse', slides: ['v1', 'v2'] }, { kind: 'chorus', slides: ['c1', 'c2'] }, { kind: 'bridge', slides: ['b'] },
  ]);
});

test('a song with no named sections, or no slides, has none', () => {
  assert.deepEqual(songSections({ data: { slides: [{ slide_id: 'a', slide_title: 'Slide 1' }, { slide_id: 'b' }] } }), []);
  assert.deepEqual(songSections({}), []);
});
```

In `planning.test.ts`: `toPlannedService` gives a song item `sections` (left out when none), `key` from `songMeta[cue].key` else `data.defaultKey`, `timeSignature` from `data.timeSignature`, `artist` from `data.text_artist`, `notes` from `songMeta[cue].notes`; and no field anywhere in the result holds `slide_content`.
- [ ] **Step 2: Run them; expect FAIL** ("sectionKindOf is not a function").
- [ ] **Step 3: Implement.** `sectionKindOf`: lowercase; drop a trailing language mark (`en`, `eng`), a trailing single slide letter (with or without a space), and numbers; match what is left, spaces and dashes removed, against one word table (`verse`; `prechorus`; `chorus`; `bridge`; `tag`; `intro`; `outro`, `ending`; `interlude`, `instrumental`). The table is one `const`, so Latvian words can be added later.
- [ ] **Step 4: Run the tests; expect PASS**; whole suite and typecheck.
- [ ] **Step 5: Commit** "Planning: a song's sections and facts come in with the service".

### Task 2: Section looks

**Files:**
- Modify: `packages/shared/src/planning.ts`, `packages/shared/src/runningorder.ts`, `server/src/app.ts` (`saveItem`, `itemGroup` if they check the running order)
- Test: `packages/shared/test/planning.test.ts`, `server/test/planning.test.ts`

**Interfaces:**
- Consumes: Task 1's `ServiceItem.sections`, `SECTION_NAMES`.
- Produces:
  - `sectionRememberKey(songId: string, kind: SectionKind): string` → `` `song:${songId}#${kind}` ``
  - `SectionRef = { song: string /* the song's look id */; kind: SectionKind }`
  - `sectionsOf(show: Show, songLook: string): { kind: SectionKind; look: string | null }[]` (the loaded song's sections, `look` its own or null)
  - `sectionLookOf(show: Show, ref: SectionRef): string` (its own look, else the song's)
  - `ensureSectionLook(show: Show, ref: SectionRef): { show: Show; id: string }` (its own look; made from the song's look (groups only) and remembered when it has none, named `"<song> · Chorus"`, not in the running order)
  - `loadService` sets `sections[].look` from `remembered` and creates nothing; `deleteItem` of a song also deletes its sections' own looks and forgets their keys.

- [ ] **Step 1: Write the failing tests:**
  - `a loaded song's sections have no looks of their own`: after a load, `sectionsOf` lists verse and chorus with `look: null`, and `sectionLookOf` gives the song's look.
  - `a section's own look comes back next week`: `ensureSectionLook` for chorus; the look exists, isn't in `runningOrder`, has the song's groups and no `tempo` or `timeline`; load the service again: `sectionsOf` gives the same id.
  - `deleting the song deletes its section looks`: after `deleteItem(songLook)` the chorus look is gone from `show.looks` and from `remembered`.
  - `itemGroup and saveItem take a section's own look`: `setItemGroup(show, chorusLook, …)` and `saveItem(show, chorusLook, stage)` work; a look outside the running order that is no section still throws "only running-order items can be changed here".
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.** Section looks are kept by `loadService` (they are remembered, like song looks); `forgetMissing` deletes a section's `look` that is gone. Check `app.ts` `case 'saveItem'` / `case 'itemGroup'` for running-order checks and allow section looks the same way; server test: `saveItem` on a section look is one Undo step.
- [ ] **Step 4: Run tests, typecheck, both jump-checks; expect PASS.**
- [ ] **Step 5: Commit** "Planning: a section of a song can have its own look".

### Task 3: What to follow (pure)

**Files:**
- Create: `packages/shared/src/follow.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/follow.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `LiveSlide = { service: string; cue: string; slide: string | null /* null: the item's Blank slide */; name: string }`
  - `parseSlideId(id: string): { cue: string; slide: string | null } | null` for `{cue}-{slide}-slide-{n}` and `{cue}-blank-{x}-slide-{n}` (cue and slide are 36-character UUIDs)
  - `OnStage = { look: string | null; section: SectionRef | null }`
  - `FollowPlace = { cue: string; part: string | null }` (the last item followed and the key of the header above it)
  - `FollowStart = { kind: 'item'; look: string } | { kind: 'section'; ref: SectionRef; look: string }` (`look`: what to start; for a section `sectionLookOf`)
  - `FollowNote = { item: string; section: SectionKind | null; kind: 'look' | 'verse' | 'nothing' | 'not-in-order' }`
  - `followDecision(show: Show, live: LiveSlide, last: FollowPlace | null, onStage: OnStage): { start: FollowStart | null; place: FollowPlace; note: FollowNote }`

- [ ] **Step 1: Write the failing tests**, one per row of the spec's table, against a show with a loaded service `[header Slavēšana, song A (verse, chorus; chorus has its own look), blank, song A again, header Vārds (with a look), blank, verse, verse]`:
  - a new item with a look → `{kind:'item', look}`;
  - song A's Blank slide → `{kind:'item', look: songA}`;
  - a chorus slide with song A on stage → `{kind:'section', ref:{song: songA, kind:'chorus'}, look: chorusLook}`; a second chorus slide with that section on stage → `null`;
  - a verse slide with the chorus on stage → `{kind:'section', ref: verse, look: songA}` (no look of its own: the song's);
  - a slide of no section → `null`;
  - the blank opening Vārds → the Vārds header look; a verse inside Vārds → `null`, note kind `verse`;
  - the second song A item → `{kind:'item', look: songA}`, `place.cue` the second cue;
  - a cue not in the service, or another `service` id → `null`, note kind `not-in-order`;
  - song A with no look (row deleted) → `null`;
  - the same message twice, its target already on stage → `null`;
  - `parseSlideId` on a song slide id, a blank id, and junk (`null`).
- [ ] **Step 2: Run them; expect FAIL. Step 3: implement from the spec's table. Step 4: run; expect PASS.**
- [ ] **Step 5: Commit** "Follow: what the lights do for each slide the presentation app shows".

### Task 4: The live connection

**Files:**
- Create: `server/src/planning/live.ts`
- Modify: `server/src/planning/index.ts` (`Planning` gains `liveKeys`, `liveAuth`), `server/src/planning/client.ts`, `server/src/planning/fake.ts`
- Test: `server/test/planning-live.test.ts`

**Interfaces:**
- Consumes: `parseSlideId`, `LiveSlide` (Task 3).
- Produces:
  - `Planning.liveKeys(account: string): Promise<{ key: string; cluster: string }>` (GET `/account/{account}/pusher`)
  - `Planning.liveAuth(account: string, socketId: string, channel: string): Promise<object>` (POST, the form `tools/worshiptools-live.ts` sends, with `client: 'light-runner'`)
  - `LiveStatus = { state: 'connecting' | 'waiting' | 'open' | 'closed'; problem: string | null; presenter: string | null }`
  - `class PresenterLive { constructor(opts: { planning: Planning; account: string; open?: (url: string) => WebSocketLike; onSlide: (s: LiveSlide) => void; onStatus: (s: LiveStatus) => void; log: (line: string) => void }); start(): void; stop(): void }`

- [ ] **Step 1: Write the failing tests** with a fake socket (`send`, `close`; the test calls `onmessage`/`onclose`), using `mock.timers`:
  - connects to `wss://ws-{cluster}.pusher.com/app/{key}?protocol=7&client=js&version=8.4.0&flash=false` and subscribes to `presence-{account}` with `liveAuth`'s answer;
  - a member with `client: 'weDesktop'` → subscribes to its `presence-` and `private-` channels (both the bare id and the `{account}.{id}` shapes) and, once the private one succeeds, sends `client-command {action:'activate'}`; `onStatus` says `open` with the computer's name;
  - a `client-event` in three chunks → one `onSlide` with `{service: cuelist.id, cue, slide, name: current_cue.name}`; a blank slide gives `slide: null`; the same `current_slide.id` again → no second `onSlide`;
  - `pusher:ping` → `pusher:pong`; `member_removed` → `waiting`;
  - a close → `closed` and retries after 1, 2, 4 … up to 60 s; `stop()` closes and never retries;
  - a message that isn't JSON, or chunks that never complete, is ignored without throwing.
- [ ] **Step 2: Run; expect FAIL. Step 3: implement from `tools/worshiptools-live.ts`; follow the first presentation computer that joins and log any other. Never throw out of a socket handler. Step 4: run; expect PASS.**
- [ ] **Step 5: Commit** "Planning: listen to the presentation app's slides on the server".

### Task 5: Auto-follow and sections on stage

**Files:**
- Modify: `packages/shared/src/protocol.ts`, `packages/engine/src/engine.ts` (`quickLook` with `only`), `server/src/app.ts`
- Test: `packages/engine/test/quicklook-only.test.ts` (new), `server/test/follow.test.ts` (new)

**Interfaces:**
- Consumes: `followDecision`, `sectionLookOf` (Tasks 2–3), `PresenterLive` (Task 4).
- Produces:
  - `quickLook` gains `only?: id[]`: set just those of the look's groups (the engine leaves the current look, tempo and other groups as `quickLook` does today)
  - Command `{ type: 'section'; song: id; kind: SectionKind }` (operator, no PIN; not a show edit): starts the section, as following does; in Prepare it acts on the tablet's draft
  - Command `{ type: 'autoFollow'; on: boolean }` (operator, no PIN; no Undo step)
  - `LiveState.section?: (SectionRef & { changed: boolean }) | null` (server-set; `changed`: a group's preset or level differs from `sectionLookOf`); a draft's state has the draft's section
  - `LiveState.follow?: { on: boolean; live: LiveStatus; note: FollowNote | null } | null` (server-set; null while Planning is off)
  - `RuntimeState.autoFollow?: boolean` (absent = off: it starts off everywhere), saved with the runtime file
  - `App.liveSlide(s: LiveSlide): Promise<void>`

**Starting a section** (from a follow or the `section` command): when the song on stage (`state.look`, or the `section`'s song) is the section's song, `stageCommand({type:'quickLook', id: sectionLookOf, only})` where `only` is the song's light groups minus the groups the running live timeline has blocks for; the timeline and the tempo are not touched; else start the song first as a tap would (`look`, its timeline), then the section the same way. Then set `section`. A `look`, `safe`, `blackout`, `blindGo` or `backToLook` clears `section`.

- [ ] **Step 1: Write the failing tests:**
  - engine: `quickLook` with `only: ['a']` changes group a, leaves b, the current look and the tempo;
  - with Planning on and a service loaded, `liveSlide` of a song's slide starts its look with the operator's Fade (`fadeTime` 2 → `lookFadeLeft` > 0);
  - a chorus slide → `state.section` is the chorus, the chorus look's groups are on stage, `state.look` stays the song, the tempo is unchanged after a `tempo` command during the song, and a running song timeline keeps its start time;
  - the `section` command does the same and switches `follow.on` off;
  - `autoFollow on:false`, then a slide → nothing; `on:true` → the last slide seen starts at once;
  - each of `look`, `quickLook`, `section`, `safe`, `blackout`, `blindGo` and a device `next` (`app.device`) switches `follow.on` off; `master`, `groupLevel`, `groupPreset`, `flash`, `undo`, `fadeTime`, `tempo` don't;
  - a tablet in Prepare (`blindStart`, `draft look`) doesn't pause it, and its draft is unchanged after a followed slide;
  - `state.section.changed` turns true after a `groupLevel` on a section's group, false again after `saveSection` (Task 6) or a new section;
  - Planning off → `follow` null and the connection stopped; on again → started;
  - Auto-follow starts off (a fresh data folder: `follow.on` false); switched on, it survives a restart (a new App on the same data folder).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** The App owns one `PresenterLive` while Planning is on (started in the constructor and when a settings save turns Planning on, stopped when off and on `close()`). `liveSlide` keeps the last slide; when following, runs `followDecision` and starts the result (an item: `stopLiveTimeline`, `look`, `startSongTimeline`, as `run()` does). In `run()`, before the stage command, the starting commands above set `autoFollow` false. Broadcast state when `follow` or `section` changes.
- [ ] **Step 4: Run tests, typecheck, both jump-checks; expect PASS.**
- [ ] **Step 5: Commit** "Auto-follow: the lights follow the presentation app until someone taps".

### Task 6: Saving a change for a section

**Files:**
- Modify: `packages/shared/src/runningorder.ts`, `packages/shared/src/protocol.ts` (command, `SHOW_EDITS`), `server/src/app.ts`
- Test: `packages/shared/test/planning.test.ts`, `server/test/follow.test.ts`

**Interfaces:**
- Consumes: `ensureSectionLook`, `sectionLookOf`, `sectionsOf` (Task 2), `setItemGroup`, `LiveState.section` (Task 5).
- Produces:
  - Command `{ type: 'saveSection'; scope: 'section' | 'song' }` (a show edit: one Undo step, a backup, no PIN; uses the stage's `section`, or the tablet's draft's in Prepare)
  - `saveSectionChange(show: Show, stage: Stage, ref: SectionRef, scope: 'section' | 'song'): Show`: the groups whose preset or level on `stage` differ from `sectionLookOf(ref)` go into the section's own look (`ensureSectionLook` first) for `section`, or into the song's look and every section look the song has for `song`.
  - Save to <item> (`saveItem`) with a section on stage saves into the section's own look (`ensureSectionLook` first).

- [ ] **Step 1: Write the failing tests:** with the chorus on stage (no own look yet), change the front lights' level and the background's colour; `section` → the chorus now has its own look with both changes and the song's other groups; the song's look is unchanged. `song` → the song's look and the chorus's own look (if any) both have the changes; the verse (no own look) still has none. A change equal to the look writes nothing. No section on stage → throws "No section is on stage." The server command is one Undo step.
- [ ] **Step 2: Run; expect FAIL. Step 3: implement with `setItemGroup` per changed group. Step 4: run; expect PASS** (and both jump-checks).
- [ ] **Step 5: Commit** "Sections: save a change for this section or the whole song".

### Task 7: The operator page

**Files:**
- Modify: `server/src/layout.ts`, `web/operator/index.html`, `web/operator/app.js`, `web/operator/style.css`
- Test: `server/test/planning.test.ts` (layout shape)

**Interfaces:**
- Consumes: `LiveState.follow`, `LiveState.section` (Task 5), `section` and `saveSection` (Tasks 5–6), `sectionsOf`.
- Produces: `layout.songs: Record<string /* song look id */, { sections: { kind: SectionKind; name: string; look: string | null }[]; key: string | null; tempo: number | null; timeSignature: string | null; artist: string | null; notes: string | null; chords: Record<SectionKind, string[]> | null }>`; section looks are in `layout.looks` like any look.

- [ ] **Step 1: Write the failing layout test:** after a load, `layout.songs[songLook]` has the sections in order (`look` null, then the chorus's id after `ensureSectionLook`) and the facts; each section look is in `layout.looks`.
- [ ] **Step 2: Run; expect FAIL. Step 3: implement `layout.ts`; run; expect PASS.**
- [ ] **Step 4: The page**, checked with the preview server (`.claude/launch.json` "start" with `LIGHT_RUNNER_FAKE_PLANNING` pointing at a scratchpad file whose songs have sections and facts, `LIGHT_RUNNER_OUTPUT=none`; revert `launch.json` afterwards):
  - **Section rows** under the song on stage (and under the song being prepared in Prepare): smaller, indented, with the own look's swatch dots or the song's as hollow dots; the one in `state.section` marked; a tap sends `section`. Not counted by Next.
  - **A quiet facts line** under the song on stage: key · tempo · time signature, the parts it has.
  - **Save to <item>** names "Chorus · <song>" while a section is on stage.
  - **The save bar** above the groups while `state.section.changed`: "Save this change for:" with **This section** and **The whole song** (quiet `ds-` buttons) sending `saveSection`.
  - **The Auto-follow pill** after the name in the top bar while `state.follow` is set, with the spec's texts (the page says "Presenter"); a tap sends `autoFollow` with the opposite value. One line on the upright iPad and the phone.
  - The phone shows the rows and the pill, never the save bar.
- [ ] **Step 5: Check in the browser** at 1080 × 810, 810 × 1080 and the phone preset: rows, a tap, the save bar both ways, the pill on and off; send screenshots.
- [ ] **Step 6: Commit** "Operator page: section rows, the save bar and the Auto-follow pill".

### Task 8: The agent skill, docs, and the church check list

**Files:**
- Modify: `.claude/skills/light-runner-control/SKILL.md`, `.claude/skills/light-runner-control/reference.md`, `.claude/skills/light-runner-service/SKILL.md`, `docs/STATUS.md`, `docs/DECISIONS.md`, `docs/running-a-service.md`, `docs/setting-up-a-show.md` (step 11)
- Create: `docs/notes/auto-follow-church-check.md`

- [ ] **Step 1: The control skill.** reference.md: `section`, `saveSection`, `autoFollow`, and `layout.songs`. SKILL.md: a recipe "Plan the lights for a service": read `layout.songs` and the running order; propose one table (song, section, colours, levels, why: tempo and key for energy and warmth, chords and notes for where it lifts); on a yes, for each song build in Prepare and Save to the song, then for each section `prepare` with `{"type":"section",…}` and the group changes and `{"type":"saveSection","scope":"section"}`; never `autoFollow` or anything live without a yes. Test it as the skill was tested before: a subagent with the skill, a preview server with the fake service, the prompt "plan moody lights for this Sunday's songs, brighter choruses"; it must build in Prepare only and leave `follow` alone.
- [ ] **Step 2: Docs.** STATUS: Planning gains sections, facts and Auto-follow; "Following the presentation app" moves to built; Known issues gets the spec's "Not known yet". DECISIONS: the spec's "Changes to the 25 Oct design" rows and the Claude's calls (section rows only under the song on stage; Next skips sections; untitled slides change nothing; a section has its own look only once a change is saved; sections change colours and levels only; deleting a song deletes its section looks; no answer saves nothing; no lyrics are kept). Guides: Auto-follow, what pauses it, the save bar, making a section's look in Prepare.
- [ ] **Step 3: The church check list** (`auto-follow-church-check.md`): what to try on the church Mac with the presentation app open (each row of the spec's table, blank/black/clear-all, a click in the app's own window, a reconnect, two computers open, where the chords are) and what to write down.
- [ ] **Step 4:** grep the changed docs for the platform's names; none.
- [ ] **Step 5: Commit** "Docs and skill: song sections, Auto-follow and planning the lights with an agent".
