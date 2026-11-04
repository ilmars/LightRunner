# Song sections: what the planning service and the presentation app know

4 Nov 2026 · research only, nothing built · no lyric text here, only section names, slide counts and field names.

The owner's idea: a song loaded from the planning service gets sections (verse, chorus, second verse …), each with its own look, effects or timeline, and the lights change when the presentation app reaches that section. This note says whether the data allows it.

Sources: the church's account, read with the saved login on 4 Nov: the last 60 services (207 songs) for the planning data; for the live part, the presentation app 2026.1.11 open on the church Mac, recorded while the owner clicked through four songs of the 4 Nov service (about 15:08 EET; 199 messages). The clicks came from another of the planning service's clients acting as a remote, not from the presentation app's own window. The recording is kept outside the repo, with all slide text removed.

## 1. In the planning service

**Sections live in the song library, not in the service.** A song document (`accounts/{account}/songs/{songId}`) has `data.slides`, one entry per slide, in order:

| Field | What it is | Example |
| --- | --- | --- |
| `slide_id` | a UUID, stable for the slide | `a3e849ed-…` |
| `slide_title` | the slide's name, typed by whoever entered the song | `Verse 1a`, `Chorusb`, `Bridge 1 a`, `PreChorus`, `Slide 11 a`, `Tag`, `Intro`, `Chorus a EN` |
| `slide_label` | a colour, one per section (all slides of a section share it) | `#91c854` (verse 1), `#00b1e1` (chorus), `#ed5466` (verse 2), `#e6a400` (bridge) |
| `slide_content` | the text (lyrics; a string or rich-text parts) | — |

- **A section is several slides.** Titles end in a, b, c … for the slides of one section ("Verse 1a", "Verse 1b", "Verse 1c"), with or without a space ("Chorusa", "Chorus a"). The section is the title with that letter taken off.
- **Names are free text and not always kept.** Over 207 songs: about 850 verse slides, 420 chorus, 200 bridge, 80 pre-chorus, and about 100 slides called "Slide N" (no section name; the colour is often missing then too). 132 songs have colours; 8 have a slide with no title. English parts are marked "EN" or "eng".
- **No arrangement.** `data.order` (entries `{text_order_slide, text_order_order, text_order_text}`) and `data.text_useorder` exist, but only 1 song of 207 uses them, and its order is just the slides in their own order. `data.song_orders` is empty for every song. So "V1 C V2 C B C" is not written anywhere: **a song's slides are listed once each, and repeats are not planned.**
- **The service's copy of a song is only a pointer.** A song item (`data.cues[]`) holds the song id (`cue_foreground.text`) and nothing about sections. The service can set three things per song, in `data.songMeta[cue_id]`: `key`, `notes` and (rarely, 9 times in 60 services) `tempo`. Nothing per service about sections or order.
- Items also have `cue_options.automation` (`{goTo: "", after: "5"}`) on about 90 items, songs among them: the presentation app can move on by itself after N seconds. If that is used in a service, a slide change is not always a person's action.

Example, one song per line (the 8 Nov Rīga service, as the library has them):

| Song (id) | Slides | Sections in order |
| --- | --- | --- |
| 22aa31e6 | 4 | Verse 1, Chorus, Verse 2, Bridge (no colours) |
| 5f13825f | 12 | Verse 1 (a–c), Chorus (a–c), Verse 2 (a–c), Bridge (a–c) |
| 4fb9b930 | 13 | Verse 1, Chorus (a–b), Bridge, Verse 2 (a–b), Chorus 2 (a–e), Bridge 1, Slide 11 |

## 2. What the presentation app sends live

It sends on the account's Pusher channel `private-{account}.{appId}` (2026.1.11 has a bare id; older versions had `{account}.{machine}`, and the older live tool in `tools/` now handles both). Once a listener sends `client-command {action: "activate"}`, it answers with the state and then sends on each change:

- **`client-event`**, one per slide change: `cuelist {id, name}` (the planning service's service id and name), `current_cue {id, name, foreground {type, text}, background}`, `prev_cue`, `next_cue` (`{id, name}`), `current_slide {id}`, `preview` (always true here), `stageDisplayLayoutEnabled`.
- **`client-slides`** when a new item goes live: `cue` (its id), `type` ("text"), `slides [{id, title, content, notes, songKey}]`.
- `client-cuelist` (the items: `{id, type, name, icon}`), `client-stage-display` (the stage display's layout) and `client-preview` (a small picture of the slide, about 1.2 kB) on most changes.
- **`client-command`** from a remote: `{action: "next"}`, `"previous"`, `{action: "fireSlide", id}`, `{action: "fireCue", id}`. These are the remote's clicks, seen because they go over the same channel. A click made in the presentation app itself was not recorded this time.

**One slide change** is a `client-event` whose `current_slide.id` reads

    {cue_id}-{slide_id}-slide-{n}        e.g. 31cf749f-…-943e24cb-…-slide-2

- `cue_id` is the planning service's item id (`data.cues[].cue_id`), `current_cue.foreground.text` is the song id, and `cuelist.id` is the service id. **The live item matches the loaded running order exactly**, by the same ids Light Runner already keeps (`ServiceItem.key`, `songId`, the service `id`).
- `slide_id` is the song library's `slide_id`, and `n` is the slide's place in the presentation app's list. Each song's list is **a "Blank" slide first** (`{cue_id}-blank-{random}-slide-1`), then the library's slides in library order, with the library's titles: checked for four songs, every title and order matched.
- **So a slide's section can be known**: `client-slides` gives the title ("Chorusb") straight away, and the library gives it too, with the colour. Neither says "second time through the chorus".

**What happened on each action** (the remote's clicks; the message came 29–132 ms after the click, median 76 ms):

| Action | What was sent |
| --- | --- |
| Next | a `client-event` with the next slide; on the last slide, the next item's Blank slide |
| Back | the slide before; on an item's Blank slide, the last slide of the item before |
| Jump to a slide out of order | a `client-event` with that slide's id, nothing else to tell it apart |
| Back to a chorus already sung | **the same id as the first time**: a repeat can't be told from going back |
| New item | `client-event` (on its Blank slide), then `client-slides` about a second later |
| Blank or black (clear) | **not seen**: none was recorded, so it is unknown what they send |

- **Reliability:** in 20 slide changes, one `client-event` never came (two quick clicks 0.6 s apart; the second one's event came). A follower must not depend on every message arriving; the next one carries the whole state again.
- **Speed:** under 0.15 s from the click to the message over the internet; the screen itself was not timed against it.

## 3. What this means for "each section has its own look or timeline"

**Possible:**
- Knowing the section on screen, live: the slide id names the library slide, and its title and colour name the section. Matching to the loaded song needs nothing new: the item id and song id are the ones already loaded.
- Listing a song's sections ahead of time (for an editor): the song library's slides, grouped by title without the trailing letter, or by colour. One look or timeline per section name ("Verse", "Chorus", "Bridge", "PreChorus"), or per numbered section ("Verse 1", "Verse 2").
- Starting the section's look the moment its first slide comes (the message is fast enough), and staying on it through that section's later slides.
- The Blank slide at the start of every song is a natural "song is about to start" moment.

**Not possible from the data:**
- The planned order of sections or repeats ("V1 C V2 C B C"): nobody writes it, so a timeline for the whole song in section order can't be laid out ahead of time. The lights would follow whatever the operator clicks.
- Telling "chorus again" from "back to the chorus by mistake": both send the same slide.
- Sections for songs whose slides are called "Slide N" (about 1 in 10 slides): no name, often no colour; those songs would have one look only, unless someone renames the slides in the planning service.

**Still unknown:**
- What blank, black and clear-all send (not done in the recording), and what a click in the presentation app itself sends (the recording only had remote clicks; the app's own `client-event` is expected to be the same).
- What `preview: true` means, and whether it changes in a real service.
- Whether auto-advance (`cue_options.automation`) is used in Rīga's services: then a section change can happen without anyone clicking.
- How it behaves over a whole service (reconnects, two presentation computers open, the app restarted mid-service): only a few minutes were recorded.
- Whether slide titles are kept tidy enough: "Chorusa" and "Chorus a" and "Chorus 2 a" all occur, so the name has to be cleaned up before matching.
