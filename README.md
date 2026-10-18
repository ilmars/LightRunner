# Light Runner

A browser-based lighting app that lets volunteers run a church service by tapping a handful of pre-built looks. One small Node.js server drives the lights over Art-Net, sACN or an ENTTEC DMX USB Pro; tablets, laptops and (later) Companion or a MIDI controller all send it the same commands.

Start here:
- [docs/STATUS.md](docs/STATUS.md): what's built, what's next, known issues
- [docs/SPEC.md](docs/SPEC.md): the product spec
- [docs/DECISIONS.md](docs/DECISIONS.md): choices made and why
- [CONTRIBUTING.md](CONTRIBUTING.md): set up on your computer and send changes
- [docs/PLAN.md](docs/PLAN.md): the original implementation plan

## Run it

Needs Node.js 24 or newer.

```bash
npm install
npm start
```

Then open `http://<this computer>:8080/` on the tablet. Pages:

| Page | For | What it does |
| --- | --- | --- |
| `/operator/` | Volunteers | Looks, Next, Undo, group presets, Master and group dimmers, Safe, Blackout |
| `/patch/` | Programmer (PIN) | DMX map, fixtures, groups, stage plan, Identify, fixture types from the Open Fixture Library |
| `/settings/` | Programmer (PIN) | DMX output (Art-Net, sACN, ENTTEC), Art-Net node finder, Send DMX switch, PIN, backups, show export, compare with a show file or Lightkey project and pick what to take |

Environment variables: `PORT` (default 8080), `LIGHT_RUNNER_DATA` (folder for `show.json`, `runtime.json` and backups; default `./data`), `LIGHT_RUNNER_OUTPUT=none` (never send DMX).

## Fixture database

Fixture types come from the [Open Fixture Library](https://open-fixture-library.org), a free database of DMX definitions (about 650 fixtures from 135 manufacturers). In Settings > Fixture database, download it once (about 3 MB from GitHub, stored in `data/ofl/database.json`); Patch then browses it by manufacturer and searches it without internet. "Check for updates" compares the latest version with the downloaded one and lists new, changed (marking those your show uses) and removed fixtures before you install it. Without the download, Patch searches the library online. A fixture file saved from the OFL website can also be imported.

## Import a Lightkey project

```bash
python3 tools/import-lightkey.py PROJECT.lightkeyproj shows/my-show.json --artnet-host 192.168.0.114 --universe 1 --group "Front lights=p1,p2,p3,p4"
node tools/install-show.ts shows/my-show.json
```

`tools/import-dieva-majas.sh` re-imports the Dieva Mājas L1 rig with its agreed groups. Stop the server before installing a show.

## Check it

```bash
npm test             # unit and server tests
npm run typecheck
npm run jump-check   # hours of random look changes: no fixture may step more than 5% per frame
npm run timing-probe # DMX frame timing on this machine
```

## Layout

| Folder | What |
| --- | --- |
| `packages/shared` | Show schema (zod), commands, live state, built-in fixture profiles |
| `packages/engine` | The lighting engine: fades, groups, manual, undo, DMX channel mapping. Pure: no timers or I/O |
| `server` | HTTP API, WebSocket, engine worker thread (frame clock and DMX output), saving and backups |
| `web` | Operator, patch and settings pages (plain HTML and JavaScript, no build step) |
| `tools` | Lightkey importer, show installer, jump check, timing probe |
| `shows` | Show files |
