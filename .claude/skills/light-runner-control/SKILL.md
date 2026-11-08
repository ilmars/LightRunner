---
name: light-runner-control
description: Use when someone asks you (the agent) to change Light Runner's lights or show for them instead of telling them which buttons to press: "make it moody", "warm white everywhere", "dim the front lights", "make a song / quick look for the sermon", "patch two new lights", "add a group", "put these in the running order". Also when you need to drive a running Light Runner without changing its code or files.
---

# Controlling Light Runner through its API

Light Runner (a church lighting controller) is changed the way its own pages change it: HTTP and a WebSocket on the running server. You never edit code, `show.json`, `data/` or a show file by hand. Every request goes through the server's own checks, so a refused change says why in plain words and nothing breaks.

All of it goes through one helper, from the repository root (Node 24; on the church Mac `node` may be `/opt/homebrew/opt/node@24/bin/node`):

```bash
node .claude/skills/light-runner-control/scripts/lr.ts --url http://localhost:8080 get layout
```

`--url` is the address the iPads use without `/operator/`: `http://localhost:8080` on the church Mac itself, `http://192.168.0.195:8080` from another computer there, another port for a test copy. The examples below leave it out; always pass it.

Its header lists every command (`get`, `post`, `send`, `prepare`, `show-get`, `show-check`, `show-put`, `free`). Command shapes, show fields and routes are in [reference.md](reference.md): read it before your first change.

## The lights are real

People may be in the room. Before anything else, `get state`: `output` is `"ok"` when Light Runner is sending to the lights. `"off"` (Send DMX off) is no reason to skip these rules: the stage you leave is what the lights show once it is switched on.

- **Build in Prepare.** Make looks with `prepare`: the commands change a draft, Add song / Save / Save as quick look store the draft, and the stage never moves. This works the same with Send DMX on or off.
- **Going live is the person's call.** Use `send` for stage commands, or `prepare --go` to fade a draft on, only when they asked for the stage to change now, or said yes when you asked. Undo (`send '{"type":"undo"}'`) takes back the last change.
- **Ask first** before anything that overwrites or removes their work: `saveItem` over an existing song, `deleteItem`, `deleteColour`, `deleteQuickLook`, removing fixtures or groups, `loadService`.
- **Never** touch Send DMX or the output settings (Lightkey may be sending), the PIN, backups, or Open a show file; never stop or restart the server. Those are the person's, on the Settings page.
- **The PIN** is never typed in chat or on a command line. If a programmer route answers "needs the programmer PIN", ask them to set `LIGHT_RUNNER_PIN` in their own terminal before starting you, or to give you a file holding it (`--pin-file`). Operator work (looks, songs, quick looks, colours) needs no PIN.

## From a plain request to commands

1. **Look:** `get layout`. Its `groups` are what there is to light (leave `kind: "smoke"` out unless asked). Each group's `presets` are its colours, each with `light.hex` and `level`. Its `runningOrder` and `quickLooks` hold the existing looks.
2. **Plan, group by group,** with the words below. Use a group's own colour when one fits. Otherwise make one with `addColour`, then read the layout again for its id.
3. **Say the plan** in one short table (group, colour, level) and where you'll keep it, then build it.
4. **Build and keep it** in one `prepare` call. For example, "make it all moody and warm white lights, with dimmed down front lights" on the church rig:

```bash
node .claude/skills/light-runner-control/scripts/lr.ts prepare \
  '{"type":"groupPreset","group":"front-lights","preset":"front-lights-silti-3200k"}' '{"type":"groupLevel","group":"front-lights","value":0.2}' \
  '{"type":"groupPreset","group":"key-lights","preset":"key-lights-silti-balts"}'   '{"type":"groupLevel","group":"key-lights","value":0.35}' \
  '{"type":"groupPreset","group":"background","preset":"background-silti-balts"}'   '{"type":"groupLevel","group":"background","value":0.4}' \
  '{"type":"groupPreset","group":"drum-cage","preset":"drum-cage-silti-balts"}'     '{"type":"groupLevel","group":"drum-cage","value":0.25}' \
  '{"type":"groupPreset","group":"b8-side-bar","preset":"b8-side-bar-silti-balts"}' '{"type":"groupLevel","group":"b8-side-bar","value":0.25}' \
  '{"type":"addSong","after":"<id of the row it goes after>"}'
```

   `after` is a row id from `layout.runningOrder` (the last one, to put it at the end); quick looks are not rows. `addSong` gives no id back. Run `get layout`, find the new row ("Song N") next to where it went, and `send` a `renameItem` with a name from their words ("Moody warm"). Where to keep it:
   - They named an existing song: `saveItem` with its id (ask first, because it replaces it).
   - They named nothing: a new song after the last row.
   - They want it "on top of anything": a quick look (`saveQuickLook`, tab `plain`, listing the groups it sets).
5. **Check it:** `get layout`, and read the new row's `entries` and `levels` back against the plan. Tell them in a sentence or two where it is and how to start it. Then ask whether to put it on stage now; if yes, `send '{"type":"look","id":"<id>"}'`.

### What the words mean

| They say | Do |
| --- | --- |
| all, everything | every light group (not smoke) |
| warm white | the group's warmest white (effects have `light: null`: skip them): a name with Warm, Silti or 3200K, or `light.hex` near `#ffb46b` (red high, blue low). None: `addColour` `#ffb46b` named "Warm white" |
| cool / daylight white | a name with Cool, Vēsi or 5600K–6500K, or a hex like `#dcebff` or `#fffaf6` |
| moody, soft, calm | 25–40%; the background a little above the key lights; accents (drum cage, side bars) at 20–30% |
| dimmed (down), low, subtle | that group at 15–30% |
| bright, full | 100% |
| off, dark (one group) | that group's Off colour, or level 0 |
| blackout (everything) | ask: it is `blackout`, and only a look, Basic lights or Next brings the lights back |
| a colour ("blue wash") | the group's colour of that name or hue; otherwise `addColour` with the hex |

Use a level the person gave as it is. Show the levels you picked, so they can say "a bit brighter".

## Patch: lights and groups

Whole-show changes go through a file: `show-get` it into your scratchpad, change it with a short node script, `show-check` it, then `show-put` it.
- **Free channels:** `free <file> <universe> <channels>` finds a free address when they gave none. When the address they gave is taken (`show-check` names the light using it), save nothing. Tell them which light uses those channels, and offer the free address, because the real light's own address setting has to match. Use the taken one only if they say the two lights should do the same thing (`--overlap-ok`).
- **Where it stands:** `x` runs across the stage plan and `y` from the back wall (0) to the audience (1). Ask where the light stands; until they say, put it near the lights it is with, and tell them it can be moved in Patch.
- **Light types:** `get profiles` lists types by id (built-in `generic-*` ones need nothing more). A type from the Open Fixture Library comes from `get ofl/search?q=...` and `post ofl/profile`, and goes into `show.profiles`.
- **New groups:** a new group needs its id in `operator.groups` to show on the operator page (`show-check` says so). The order of `fixtures` is the order effects travel along. A new light group gets Warm white and Off by itself.
- **Afterwards:** `post identify '{"fixture":"<id>"}'` flashes one light white for 3 s so they can find it. Do this only with their yes, and only when it's sending.

## Common mistakes

- Sending the look straight to the stage instead of `prepare`: the room sees every step.
- Every group at one level. "Moody" has depth: front low, background a little higher.
- Guessing an address: always `free`, then `show-check`.
- Saving both a song and a quick look when they asked for one thing.
- Reading `server/src/app.ts` to find the API: it's all in [reference.md](reference.md).
