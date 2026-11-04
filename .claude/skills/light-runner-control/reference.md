# Light Runner API reference (for light-runner-control)

The source of truth is `packages/shared/src/protocol.ts` (commands) and `packages/shared/src/schema.ts` (the show). This page is what you need from them. `lr.ts send` and `lr.ts prepare` check each command against the real list before sending, so a mistake comes back with the field that is wrong.

## Reading (`lr.ts get <path>`, no PIN)

| Path | What |
| --- | --- |
| `state` | the live stage: `look` (id, `"safe"` for Basic lights, `"blackout"`, or null), `groups[id].preset` and `.level`, `master`, `output` and `outputProblem`. `output` is `ok` (sending to the lights), `lost` (the node doesn't answer) or `off` (Send DMX is off: nothing reaches the lights now, but the stage still changes and shows the moment it is switched on) |
| `layout` | what the operator page draws: `groups` (id, name, kind, `presets` with id, name, `light` and `level`; `light` is null for an effect), `runningOrder` (the rows, Basic lights first) and `quickLooks` (not rows), each look with `entries` and `levels` per group in `groups` order, `basicLights`, `kept`, `fixtures` |
| `looks` | `{looks, presets}`: every look's and colour's id and name only |
| `show` | the whole show; a look's `groups[]` is what it sets. Needs the PIN when one is set |

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
| Master | `{"type":"master","value":0..1}` |
| tempo | `{"type":"tempo","bpm":40..240}` |
| take back the last change | `{"type":"undo"}` |

**Show edits** (inside `prepare`, the ones that store the stage store the draft):

| Command | Shape |
| --- | --- |
| new song holding the stage | `{"type":"addSong","after":"<row id>"}`: a row id from `layout.runningOrder` (quick looks are not rows). No id comes back: read the layout |
| store the stage in a song | `{"type":"saveItem","id":"<row id>"}` (replaces it) |
| rename, move, delete a row | `{"type":"renameItem","id","name"}`, `{"type":"moveItem","id","to":<n, 1 = after Basic lights>}`, `{"type":"deleteItem","id"}` |
| keep a row through a planned-service load | `{"type":"keepItem","id","kept":true}` |
| change one group of a song, stage untouched | `{"type":"itemGroup","item":"<row id>","group":"<g>","preset":"<id>","level":0..1}` (or `colour` instead of `preset`) |
| a song's tempo | `{"type":"itemTempo","item","bpm"}` |
| new quick look from the stage | `{"type":"saveQuickLook","name","tab":"plain\|colours\|effects","groups":["<g>",...]}` |
| change a quick look | `{"type":"editQuickLook","look","name"?,"tab"?,"groups"?,"fromStage"?:true}` |
| new colour in a group's list | `{"type":"addColour","group","colour":"#rrggbb","name","allGroups":false,"level"?:0.05..1}` (`allGroups: true` adds it to every light group) |
| change a colour | `{"type":"editColour","preset","name"?,"colour"?,"level"?,"sameName":false}` |
| new effect | `{"type":"addEffect","group","name","effect":{"kind":"effect","effect":"wave\|chase\|colourFade\|sparkle\|breathe\|meteor\|fill\|yoyo","colours":[{"hex":"#..."}],"speed":{"beats":4}}}` |

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
