# Light Runner API reference (for light-runner-control)

The source of truth is `packages/shared/src/protocol.ts` (commands) and `packages/shared/src/schema.ts` (the show). This page is what you need from them. `lr.ts send` and `lr.ts prepare` check each command against the real list before sending, so a mistake comes back with the field that is wrong.

## Reading (`lr.ts get <path>`, no PIN)

| Path | What |
| --- | --- |
| `state` | the live stage: `look` (id, `"safe"` for Basic lights, `"blackout"`, or null), `groups[id].preset` and `.level`, `master`, `section` (`{song, kind, changed}`: the song's section on stage, or null), `follow` (Auto-follow: `{on, live:{state, problem, presenter}, note}`; null while Planning is off; `on` is the person's switch: read it, never change it), `output` and `outputProblem`. `output` is `ok` (sending to the lights), `lost` (the node doesn't answer) or `off` (Send DMX is off: nothing reaches the lights now, but the stage still changes and shows the moment it is switched on) |
| `layout` | what the operator page draws: `groups` (id, name, kind, `presets` with id, name, `light` and `level`; `light` is null for an effect), `runningOrder` (the rows, Basic lights first) and `quickLooks` (not rows), each look with `entries` and `levels` per group in `groups` order, `basicLights`, `kept`, `fixtures`, and `songs` (below) |
| `looks` | `{looks, presets}`: every look's and colour's id and name only |
| `show` | the whole show; a look's `groups[]` is what it sets. Needs the PIN when one is set |

### `layout.songs`: the songs of the loaded service, with what is known about them

Only while Planning is on in Settings and a service is loaded (otherwise it is `{}`: ask the person to load the service, which they do on the operator page with **Load service**; `loadService` replaces the running order, so it is theirs to start). Keyed by the song's row id in `runningOrder` (the id `look`, `saveItem` and `section` take):

```json
"uz-krustu": { "sections": [ {"kind":"verse","name":"Verse","look":null}, {"kind":"chorus","name":"Chorus","look":"uz-krustu-chorus"} ],
               "key":"G", "tempo":72, "timeSignature":"6/8", "artist":"...", "notes":"slow start, full band from chorus 2", "chords":null }
```

- `sections`: in the order they first appear in the song. `kind` is one of verse, pre-chorus, chorus, bridge, tag, intro, outro, interlude. `look` is the id of the section's own look, or null while it plays the song's look. A song with no sections has `sections: []` and one look.
- `key`, `tempo` (bpm), `timeSignature`, `artist` and `notes` (the worship leader's note for this service) are null when unknown. `chords` is null: chords are not read yet, so plan without them and say so.
- No lyrics are kept anywhere.

## Commands (`lr.ts send` or `lr.ts prepare`)

Ids come from `get layout`. `fade` is seconds and optional everywhere.

**Stage** (in `prepare`, these change the draft only):

| Command | Shape |
| --- | --- |
| a group's colour | `{"type":"groupPreset","group":"<g>","preset":"<preset id>"}` |
| any colour, not kept | `{"type":"groupColour","group":"<g>","colour":"#rrggbb","white":0..1,"amber":0..1,"uv":0..1}` |
| a group's level | `{"type":"groupLevel","group":"<g>","value":0..1}` |
| start a look or song | `{"type":"look","id":"<look id>"}` |
| a quick look (only its groups) | `{"type":"quickLook","id":"<look id>"}` |
| Basic lights / Blackout | `{"type":"safe"}` / `{"type":"blackout"}` |
| a song's section | `{"type":"section","song":"<song row id>","kind":"chorus"}`: starts the section's look (its own, else the song's): colours and levels only, so the tempo and a running timeline carry on. When the song is not what is on stage (or in the draft) the song starts first. Live it is a tap by hand and **switches Auto-follow off**; in `prepare` it acts on the draft |
| Auto-follow on / off | `{"type":"autoFollow","on":true}`: the person's own switch (on, it starts what the presentation app has on screen, at once). Never send it without their yes. It is not an Undo step and works only while Planning is on |
| Master | `{"type":"master","value":0..1}` |
| tempo | `{"type":"tempo","bpm":40..240}` |
| take back the last change | `{"type":"undo"}` |

**Show edits** (inside `prepare`, the ones that store the stage store the draft):

| Command | Shape |
| --- | --- |
| new song holding the stage | `{"type":"addSong","after":"<row id>"}`: a row id from `layout.runningOrder` (quick looks are not rows). No id comes back: read the layout |
| store the stage in a song | `{"type":"saveItem","id":"<row id>"}` (replaces it). When that song is the one on stage (or in the draft) with a section, it saves the whole stage into the **section's** look, except the groups a running timeline drives |
| keep a change made while a section is on stage | `{"type":"saveSection","scope":"section"}` into the section's own look (made from the song's look first), or `"scope":"song"` into the song's look and every section of it that has its own. Only the groups changed since the section started are saved. One Undo step; no PIN. In `prepare` it acts on the draft |
| rename, move, delete a row | `{"type":"renameItem","id","name"}`, `{"type":"moveItem","id","to":<n, 1 = after Basic lights>}`, `{"type":"deleteItem","id"}` |
| take the planned service out of the running order | `{"type":"clearService"}`: Basic lights, the kept rows and rows added by hand stay; one Undo step; lights untouched. `deleteItem` on a plan row also removes it from the loaded service |
| keep a row through a planned-service load | `{"type":"keepItem","id","kept":true}` |
| change one group of a song, stage untouched | `{"type":"itemGroup","item":"<row id>","group":"<g>","preset":"<id>","level":0..1}` (or `colour` instead of `preset`) |
| a song's tempo | `{"type":"itemTempo","item","bpm"}` |
| a song starts a timeline | `{"type":"itemTimeline","item","timeline":"<timeline id>"}` (null: none); it runs lights only when the song starts, and loops when the timeline has Loop on (Timeline page) |
| new quick look from the stage | `{"type":"saveQuickLook","name","tab":"plain\|colours\|effects","groups":["<g>",...]}` |
| change a quick look | `{"type":"editQuickLook","look","name"?,"tab"?,"groups"?,"fromStage"?:true}` |
| new colour in a group's list | `{"type":"addColour","group","colour":"#rrggbb","name","allGroups":false,"sameType"?:true,"level"?:0.05..1}` (`sameType: true` adds it to every group of the same light type too, as the page does by default: RGB with RGB, RGBW with RGBW, `layout.groups[].lightType`; `allGroups: true` to every light group) |
| change a colour | `{"type":"editColour","preset","name"?,"colour"?,"level"?,"sameName":false}` |
| new effect | `{"type":"addEffect","group","name","effect":{"kind":"effect","effect":"wave\|chase\|colourFade\|sparkle\|breathe\|meteor\|fill\|yoyo\|stripes","colours":[{"hex":"#..."}],"speed":{"beats":4}}}` |
| still stripes (a flag) | the same with `"effect":"stripes"`, `"parts":[2,1,2]` (one whole-number width per colour; colours may repeat) and `"edge":"hard"`: the colours side by side along the line, holding still (Latvian flag: `#9e3039`, `#ffffff`, `#9e3039`, parts 2, 1, 2) |

Basic lights can't be renamed, moved, deleted or given an effect.

## The show file (`show-get`, `show-check`, `show-put`; programmer PIN when one is set)

- `fixtures[]`: `{id, name, profile, universe, address (1-512), x, y (0-1 on the stage plan: x across, y from the back wall at 0 to the audience at 1; the church's front lights are at y 0.89), w?, h?, shape?, hangs?}`. `profile` is a type id: built-in (`generic-dimmer`, `generic-rgb`, `generic-rgbw`, `generic-rgba`, `generic-drgb`, ...; `get profiles` lists all with their channel counts) or one in `profiles[]`.
- `profiles[]`: `{id, name, channels: [{role: dimmer|red|green|blue|white|amber|uv|cct|strobe|other, fine?, default?, kelvin?}]}`. A type from the Open Fixture Library: `get ofl/search?q=<words>`, `get ofl/fixture?key=<key>` (its modes), then `post ofl/profile '{"key":"<key>","mode":<n>}'` gives the type to put in `profiles[]`.
- `groups[]`: `{id, name, kind: light|smoke, fixtures: [ids]}`; effects travel along `fixtures` in order. Also add the id to `operator.groups` (the operator page shows only those).
- `presets[]`: a group's colours, `{id, name, group, layers: [{kind: "static", colour: {hex}, intensity}], fade}`. Add colours with `addColour` rather than by hand.
- `looks[]` and `operator.runningOrder`, `operator.quickLooks`: change these with the commands above, not in the file.
- Ids: lowercase letters, digits and dashes, unique in their list.
- `show-put` saves as the Patch page does: the live settings, controller keys, timelines, the loaded service and the kept rows stay as they are on the server. If someone changed the show since your `show-get`, it is refused: `show-get` again and redo the change.

## Other routes

- `post identify '{"fixture":"<id>"}'`: that light full white for 3 s (it changes the stage: ask first).
- `GET /api/settings`, `PUT /api/settings`, `POST /api/pin`, `POST /api/backups/restore`, `PUT /api/show` without `?source=patch`: the person's, on the Settings page. Don't use them.
- For a Stream Deck, OSC or a controller, see `docs/companion.md`: they reach the same stage by position (`POST /api/item/<n>`, `/api/next`, `/api/group/<n or id>/level/<0-100>`). These change the live stage at once.
