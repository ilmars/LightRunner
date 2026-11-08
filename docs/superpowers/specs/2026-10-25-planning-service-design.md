# Planning service: the running order from the plan, and lights that follow the slides

Oct 25, 2026 · @Ilmārs · design agreed in conversation, mockups seen and accepted (`.superpowers/brainstorm/…/service-follow.html`)

## Why

In about 8 services out of 10 there is no lights volunteer: the live stream director runs the room, mostly busy with cameras and the stream. Today the looks only change when someone taps the iPad, so in those services the lights sit on one look or change late.

The church already plans every service in an online **planning service** (songs, headers, Bible verses, slides), and the songs are shown on screen by its **presentation app**. Each time the presentation operator moves to the next song, the lights should move with it, with a look chosen in advance. The director only steps in when something looks wrong (Basic lights, Blackout, Next).

Success: a Sunday where nobody touches the iPad during the songs and every song gets its own look on time.

**Names.** This document doesn't name the planning service or the presentation app: the integration uses their unofficial API, and the owner wants the docs (SPEC, STATUS, DECISIONS, this file) to describe how it works without naming the platform. The code and the pages may use the real names (the person who sets it up needs to know what to log in to; the operator page already says "Presenter" in the mockups). Below, `<Presenter>` stands for the presentation app's name as the page shows it.

## Goals

1. **Load a service into the running order.** On the iPad, next to Edit list, **Load service** lists the coming services; Load replaces everything after Basic lights with that service's items, in order.
2. **Every song remembers its look.** A song gets the look it had the last time it was used (found by the planning service's song id), or the default look when it is new. A different look can be picked from the existing ones.
3. **Follow the presentation app.** When the presentation operator puts an item live, Light Runner starts that item's look, by the rules below. It can be switched off, and a quiet line in the top bar always says what the presentation app is on.
4. **Optional.** Off unless switched on in Settings. With it off, Light Runner is exactly what it is today.

## Non-goals

- Nothing loads by itself. A load is always a person's tap.
- No writing back to the planning service.
- No automatic sign-in with an email and password (kept for later; see Login).
- No timing-based cues: the lights change only when the presentation operator changes the slide, which is still a person's action (the spec's "every change is triggered by a person" holds; record this in DECISIONS).
- Not on the phone remote: no Load service there (the phone has no editing). Whether the phone shows the follow line is the builder's call.

## Anti-goals (a failure even if it works)

- **Basic lights is touched by a load.** Basic lights is protected: a load never replaces, renames, moves or removes it; it stays first and the service's items come after it.
- **A Bible verse changes the lights.** During the sermon the presentation operator flicks through up to ~18 verses; none of them may move the lights. (The one exception is entering a new part, rule 2 below: if a part happens to open on a verse, that is the part's look starting, not the verse's.)
- **The lights depend on the internet.** If the planning service, the live channel or the internet is down, the running order and every control work as today; only following stops, and the top bar says so quietly.
- **Following brings the lights back from Blackout,** or acts on a Prepare draft. Following acts on the real stage only, and waits during Blackout.
- **Loud controls.** The owner dislikes controls that stand out: the follow line is a quiet pill, Start is small.
- **Platform details in the docs** (see Names).

## What the planning service has (found 21 Oct from the last 25 services)

A service is an ordered list of items. Each item is one of:

| Kind | How the connector knows it | Example | Light Runner |
| --- | --- | --- | --- |
| Kind | How the connector knows it | Example | Light Runner |
| --- | --- | --- | --- |
| Song | foreground of type text holding a song id (a UUID) | "Klints uz mūžiem" | look: remembered by song id, else the default look |
| Header | the item's type is the header flag (`g`) | Ievads, Slavēšana, Vārds, Beigas | look of that part, remembered by its name; none until someone saves one |
| Bible verse | foreground of type `bible` (the background may be media) | "Jāņa evaņģēlijs 15:16 L1" | never a look; never changes the lights by itself |
| Slides | foreground of type `slides` | "Draudzes Nedēļas Aktivitātes" | a look only if someone saves one, remembered by name |
| Picture or video | no foreground, background of type `media` | "dm_intro_screen_fhd.jpg" | same as slides |
| Blank | no foreground and no background, or a text foreground that is empty; named "[blank]" | [blank] | **never a look of its own** (every blank has the same name, so one saved look would reach every blank); the part's look covers it *(Claude's call)* |

Anything else (a kind not seen yet) is treated like slides. The connector's calls are in `tools/planning*.ts`: the service is one document with its items in order; the services are listed with a query on the account's service collection (it worked on 21 Oct with the pasted login, newest change first; each service has its type and its start times, so choosing a type and sorting by date can be done by Light Runner after the query if the query itself can't filter). Turning the kind rules above into code with samples of each kind is part of the first task.

Songs carry a default key, tempo and time signature in the song library; the service can set its own key per song. Only the Rīga Sunday services use headers (Ievads, Slavēšana, songs, Vārds, verses, Beigas, closing songs); other services are mostly songs. Services have a **service type** (Rīga, Kuldīga, Liepāja, Jelgava … Sunday services), and the account has several types.

**A header is never live in the presentation app**: it can't be clicked. The presentation operator opens the first item under it (usually a blank, sometimes a verse or a song).

## How it works

### Settings (programmer, behind the PIN)

A new **Planning** section (the page names the service):

- **On / off.** Off: no Load service button, no follow line, no connection to anything.
- **Login.** A field to paste the login cookie (the same one `tools/planning-service.ts --login` takes today; how to copy it from the browser is written next to the field). Light Runner keeps it in `data/` (never in the show file, never exported, never shown again: the page only says "Logged in · works" or the problem in plain words). It renews its short-lived token from it as needed and keeps a new cookie when the service hands one out. When the login stops working, Settings and the iPad's Load service say so ("The planning login has run out. Paste a new one in Settings.").
- **Which services.** A menu of the account's service types (default: the first; the stage L1 church uses "Rīga - Svētdienas Dievkalpojums"). Load service lists only these.
- **Look for new songs.** A menu of the quick looks; default: the first quick look on the first tab.

### Load service (iPad)

- **Load service** sits in the Running order header next to Edit list (mockup 1), only when Planning is on. Not in Prepare (like Edit list, it turns Prepare off) and not during running-order Edit.
- It opens in the right column, as the colour editor does (mockup 2): "‹ Running order", "Load service", the service type's name; then the services of that type, nearest coming first, then the most recent past one ("last week"). Each row: the date and time, the number of items and songs, and how many songs already have a look and how many will get the default ("2 new get "All white""). An empty service says "not planned yet" and can't be loaded.
- **Load** (with Cancel) and the note "Replaces the songs after Basic lights with this service's items. Basic lights stays first. Undo takes it back."
- A load is **one Undo step**, and makes a backup like other operator edits. The running order header then shows the loaded service's date and place under its title ("Sun 18 Oct · 08:00 · Rīga").
- Loading again (the plan changed on Saturday night) replaces the items again; remembered looks come back, so nothing saved is lost.
- With the planning service unreachable, the panel says so in plain words and the running order is untouched.

### The running order after a load

Basic lights, then every item of the service in order (mockup 1):

- **Headers** show as small spaced-capital labels (Ievads …) with "look" or "no look" on the right.
- **Songs** show as today's rows, with their look's swatch dots.
- **Items without a look** (slides, pictures, blanks, a header without one) show muted with hollow dots and their kind ("video", "slides").
- **A run of Bible verses folds into one muted row**, "18 Bible verses" with "lights stay". (Builder's call whether it can be unfolded.)
- "on stage" and "next" work as today. **Next ▸ skips items without a look** (the next item that has one, headers included). Live, tapping a muted item changes nothing and says quietly "No look yet. Use Prepare to give it one." (Bible verses and blanks: "Verses don't change the lights." / "Blanks use their part's look.")
- **Giving an item without a look its look** goes through Prepare *(Claude's call)*: in Prepare a tap on a header, slides or a picture makes it the prepared item with the draft as it is (nothing to start), and **Save to <item>** (hold) stores the draft as its look, as Save to a song already does in Prepare. No new page state is needed.
- **Save to <item>** works on songs, headers, slides and pictures (not verses or blanks): it saves the stage (or the draft) as that item's look, and Light Runner remembers it (songs by song id; headers, slides and pictures by name) so the next service that has it gets it back.
- **The default look is a copy** of the chosen quick look's look, made at load time and remembered at once for that song, as `editQuickLook` already copies a shared look before changing it *(Claude's call)*. So a song that only ever had the default counts as "has a look" the next week, a later change to the quick look doesn't reach it, and Save to <song> never changes the quick look. Picking another look from the menu likewise copies it.
- **Controllers and Companion count only items that have a look** (`item N`, the APC's running-order pads, Next), so buttons set up today keep their meaning and no pad is a dead row *(Claude's call)*.
- **Picking another look:** a song (or any item that can have a look) can take an existing look from a menu, e.g. a song's look from last month or a quick look. Where that menu lives (the running order's Edit list is the natural place) is the builder's call; it must be reachable on the iPad without the PIN.
- **Edit list** still works (rename, delete, add, reorder); a song added by hand is an ordinary song, as today.
- The **tempo** of a new song's look is the planning service's tempo for that song when it has one (40–240 bpm), otherwise as today. A remembered look keeps its own tempo.

### Following the presentation app

The presentation app publishes what it shows on a live channel (it is what the app's own web stage display listens to; `tools/planning-live.ts` follows it today). The server listens while Planning is on and a presentation computer is open on the account; with several open, it follows the first and Settings may name which (builder's call).

When the presentation app puts an item live, Light Runner finds that item in the loaded service and, **if following is on**:

1. **The item has its own look** (a song; slides, a picture or a blank someone saved a look to): that look starts, exactly as a tap on it in the running order would (its fade, its tempo; the Fade setting applies; unsaved changes are dropped as today).
2. **Otherwise, if it is the first item live in a new part** (the part is the header above it), whatever its kind, a blank or a verse included: the part's look starts, if the part has one. The blank that opens Vārds starts the sermon look; so would a verse if the operator opened Vārds on one *(Claude's call: the owner wants the lights to look after themselves, and a sermon on the last song's look is the failure this feature exists to stop)*.
3. **Otherwise nothing changes.** Bible verses and blanks inside a part always fall here, as do slides or pictures without a look.

A song with its own look inside Slavēšana always uses its own look; the part's look only covers items without one.

**Never acts:** during Blackout (it waits; the item that is live when the lights come back is not started by itself), on a Prepare draft (Prepare is per tablet and follows nothing), on smoke, Master, Flash or manual holds beyond what starting a look does today.

**Catching up** *(Claude's call)*: when Light Runner learns what is live late (the live channel reconnects after a blip, the server restarts, Planning is switched on mid-service), it judges the live item by the rules above against the last item it saw, as if it had just gone live, so a song that started while it wasn't listening still gets its look; if that item is the one it last followed, nothing happens. **Switching following on** by hand starts the live item's look straight away when the rules give one (it is the director's own tap, like Start). Coming back from Blackout is different: nothing starts by itself (above), the next change does.

**The item isn't in the loaded service** (the presentation app runs another service, or the plan changed): nothing changes; the line says "<Presenter> is on <name> · not in the running order".

**The top bar line** (mockup 3) is one quiet pill after the name on stage, shown only when Planning is on:

| State | Text |
| --- | --- |
| Following, on an item with a look | ● Following <Presenter> · **Uz Krustu** |
| Following, on a verse or an item without a look | ● Following <Presenter> · **Vārds** · verse |
| Not following | ○ <Presenter> is on **Uz Krustu** · [Start] |
| Presenter closed, no internet, login gone | ○ <Presenter> not open (or the plain reason) |

Tapping the pill opens a small menu with **Follow <Presenter>** on or off. **Start** (only when not following and the live item has a look, by the same rules) starts that look on the real stage. Whether the line should also warn while following, or before a song, is left to try on a real Sunday (the owner's call: "can be answered by using and testing").

**Following on or off is one shared setting** on the server (every tablet shows the same, like Fade), kept across restarts, on by default when Planning is switched on. Every change goes through `App.command()` as a Command, like everything else: load a service, follow on/off, Start.

### Login (first version)

Pasting the cookie, as above. It is not known how long the cookie lasts; Light Runner must say clearly, in Settings and on the iPad, when it has run out, and never stop the lights because of it. **Later** (not in this version): Light Runner signs in by itself with a stored email and password, ideally of a separate planning-service user made just for Light Runner. Whether the sign-in page allows that hasn't been checked.

## Constraints

- **The engine stays pure.** The connector (HTTP to the planning service, the live channel's WebSocket, token renewal, retries) lives in `server/`. Matching a live item to the running order and choosing what to start is a pure function with unit tests (no network in `npm test`; the server tests use a fake connector).
- **Every input is a Command through `App.command()`**, and the server is the single source of truth; pages only display state.
- **No new dependencies if avoidable:** Node 24 has `fetch` and `WebSocket`; the live channel's protocol is small (connect, authorise a channel over the planning API, subscribe, answer pings, join chunked messages). The scripts in `tools/` already do all of it.
- **Show data:** remembered looks (song id → look, header / item name → look) are part of the show (they travel with export and backups); the login and the live connection are not. Looks no longer in the running order are kept (hidden, as today's unused looks) so a song coming back finds its look. `checkReferences` must stay valid; Basic lights stays first (see the existing rule in DECISIONS, 19 Oct).
- **Writing, UI:** plain words, sentence case, the design system's tokens and `ds-` components, dark, quiet; 44 px targets; the iPad at 1080 × 810.
- **Docs:** STATUS and DECISIONS get entries in the same words as this file (no platform name). The scripts move to `tools/planning.ts`, `tools/planning-service.ts` and `tools/planning-live.ts`, with the login file `data/planning-login.json` (the code inside may name the platform).
- `npm test`, `npm run typecheck` and `npm run jump-check` pass before every commit.

## Not known yet (find out first)

- **What a live message carries.** The live channel's "event" message is known to carry the live item's name, the next item's name, the live slide and the service's name and date; whether it carries the item's id (or the song id) is not known: no presentation computer was open while this was looked at. **First task:** with the presentation app open on a test service, run `node tools/planning-live.ts --json` and keep a sample of each message kind (with nothing secret in it) as a test fixture. Match by item id if there is one, else by song id, else by name within the loaded service; a song twice in one service must still be told apart if at all possible.
- **Whether the cookie lasts weeks or hours.** Watch it during the build.

## Left to the builder

The data shape for remembered looks and for items without a look in the running order; the module layout in `server/`; how the folded verses unfold; where the "pick another look" menu lives; how the phone shows the running order's new rows; reconnect timing for the live channel (it must never block a frame or a command).
