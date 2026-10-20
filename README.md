# Light Runner

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Light Runner lets volunteers run the lights for a church service from a tablet, after a five-minute briefing. They tap a look (Walk-in, Worship, Sermon…) and the whole room fades smoothly to it. One small server on a computer at the church drives the lights; every tablet, laptop, Stream Deck and APC mini shows the same live state.

It was built for one church's stage and is shared under the MIT license so other churches and small venues can use it too.

## What it does

- **Looks and presets.** A look sets every group of lights at once; a group preset changes just one group (say, the back wall to blue during a song) and leaves the rest running.
- **Fades that never jump.** Every change fades with an ease-in-out curve, including a new tap in the middle of a fade. An automated check runs hours of random changes and fails if any light ever steps more than 5% between frames.
- **Made for volunteers.** Big look tiles in service order, a **Next** button, **Undo**, a green **Safe** button that always brings back a warm stage wash, and a **Blackout** that needs a one-second hold. Dark interface, so the tablet doesn't light the operator's face.
- **Dimmers.** A Master fader is always on screen; group faders open from a small Groups button that also shows which groups are dimmed.
- **Fade time.** Use each look's own fade, or set one for everything (instant, 1, 3, 5 or 10 s).
- **Patch like Lightkey.** A graphical DMX map per universe: drag fixtures to re-address them, drag fixture types onto free channels, see overlaps at once. Groups, a stage plan, and Identify to flash a fixture so you can find it.
- **Fixture database.** Fixture definitions from the [Open Fixture Library](https://open-fixture-library.org) (about 650 fixtures). Download it once to use it without internet, and check for updates later.
- **Lightkey import.** Bring a Lightkey project in, and see exactly what is new or changed before you take it.
- **Outputs.** Art-Net, sACN (E1.31) or an ENTTEC DMX USB Pro. A node finder, a Send DMX switch to hand the lights over to another desk, and a warning if the node stops answering or another desk is also sending.
- **Keeps going.** DMX runs on its own thread with a steady 40 fps clock. Every save is atomic with 20 backups, and after a restart the stage comes back exactly as it was.

## Pages

| Page | Who | What's on it |
| --- | --- | --- |
| `/operator/` | Volunteers (no login) | Live stage view, look tiles with a colour strip per group, Next, Undo, group presets, Master and group dimmers, Fade, Safe, Blackout |
| `/patch/` | Programmer (PIN) | DMX map, fixture library and Open Fixture Library, fixture table, groups, stage plan |
| `/settings/` | Programmer (PIN) | DMX output and node finder, Send DMX, operator options, fixture database, PIN, backups, export, compare with a file |

The programmer pages ask for a PIN once one is set (Settings > Programmer PIN).

## Try it

You need [Node.js](https://nodejs.org) 24 or newer.

```bash
git clone https://github.com/ilmars/LightRunner.git
cd LightRunner
npm install
LIGHT_RUNNER_OUTPUT=none npm start
```

Open http://localhost:8080/. `LIGHT_RUNNER_OUTPUT=none` makes sure nothing is sent to any real lights; the first start loads a small demo rig.

## Set it up at your venue

1. **A computer that stays on** next to the lighting network: a Mac mini, a small PC or a Raspberry Pi 4/5. Turn sleep off.
2. **A DMX interface:** an Art-Net or sACN node on the network, or an ENTTEC DMX USB Pro on the computer.
3. **Start Light Runner** (`npm start`) and open `http://<computer's address>:8080/settings/`:
   - Set a programmer PIN.
   - Under DMX output, pick Art-Net, sACN or ENTTEC. For Art-Net, **Find nodes** lists the nodes on your network with the universe they listen on; tap **Use**.
   - Download the fixture database.
4. **Patch your rig** at `/patch/`: drag fixture types from the library (or the Open Fixture Library) onto the DMX map, make groups, place fixtures on the stage plan, and save. Already using Lightkey? Use Settings > **Compare with a file** with your `.lightkeyproj`, or the command-line importer below.
5. **Switch on Send DMX** when no other desk is driving the lights.
6. **On the tablet**, open `/operator/`, add it to the home screen, and set Auto-Lock to Never so the screen stays on during the service.

Light Runner doesn't start itself on boot yet; see [docs/STATUS.md](docs/STATUS.md).

## Bringing in a Lightkey project

In the app: Settings > **Compare with a file**, choose the `.lightkeyproj`. You get a list of new and changed fixture types and fixtures to tick, and only what you tick is taken.

From the command line, to build a whole show from a project:

```bash
python3 tools/import-lightkey.py "My Stage.lightkeyproj" shows/my-show.json \
  --artnet-host 192.168.0.114 --universe 1 \
  --group "Front lights=p1,p2,p3,p4" --group "Background=b3,b4,b5,b6"
node tools/install-show.ts shows/my-show.json   # stop the server first
```

Groups are named by fixture short names as they appear in Lightkey; fixtures you don't list get a group per model. Needs Python 3.

## Remote control (Stream Deck, OSC, APC mini)

Light Runner answers simple HTTP requests from the local network, so Bitfocus Companion's Generic HTTP module can trigger it:

| Request | Does |
| --- | --- |
| `POST /api/look/{id}` (optional `?fade=5`) | Fade to a look |
| `POST /api/group/{group}/preset/{id}` | Fade one group to a preset |
| `POST /api/group/{group}/level/{0-100}` | Set a group's dimmer |
| `POST /api/master/{0-100}` | Set the Master |
| `POST /api/fade/{seconds}` or `/api/fade/auto` | Set the fade time |
| `POST /api/item/{n}`, `/api/next` | Start item n of the running order (counting from 1), or the next one |
| `POST /api/group/{n}/colour/{k}` | Group n (counting from 1) to its colour k |
| `POST /api/flash/{n}/on` and `/off`, `/api/flash/all/on` and `/off` | Flash while held (put out by itself after 15 s) |
| `POST /api/master/up`, `/api/master/down` | Master up or down one step |
| `POST /api/back-to-look`, `/api/undo`, `/api/safe`, `/api/blackout` | What the buttons do |
| `POST /api/group/{group}/manual`, `/api/group/{group}/release` | Manual colour (JSON body `{ "colour": "#ff0000", "intensity": 80 }`) and release |
| `GET /api/state` | Live state: current look, each group's preset and level, fades, DMX status |
| `GET /api/looks` | Looks and presets with names and colours, for building buttons |
| `GET /api/companion` | What is on stage, what is next, Master and each group's colour and level, flat, for Companion to poll |

The same actions are also available as OSC messages (Settings > OSC, port 8000) and from an Akai APC mini plugged into the computer. [docs/companion.md](docs/companion.md) has the exact addresses, how to set up a Stream Deck in Companion, and what the APC mini's pads, buttons and faders do.

## Configuration

| Variable | Default | What |
| --- | --- | --- |
| `PORT` | `8080` | Web port |
| `LIGHT_RUNNER_DATA` | `./data` | Where the live show, the last state, backups and the fixture database are kept |
| `LIGHT_RUNNER_OUTPUT` | — | `none` never sends DMX, whatever the show says |

`data/` is not in git. To keep a show in the repository, export it (Settings > Export show file) into `shows/`.

## Development

```bash
npm test             # unit and server tests
npm run typecheck
npm run jump-check   # hours of random look changes; no light may step more than 5% per frame
npm run timing-probe # DMX frame timing on this computer
```

TypeScript runs directly in Node (no build step); the pages are plain HTML and JavaScript.

| Folder | What |
| --- | --- |
| `packages/shared` | Show format, commands and live state, fixture types, Open Fixture Library converter, show compare and merge |
| `packages/engine` | The lighting engine: fades, groups, manual, undo, channel mapping. No timers or I/O, so tests and tools run it directly |
| `server` | Web server and API, WebSocket, DMX worker thread and outputs, saving, fixture database |
| `web` | Operator, patch and settings pages |
| `tools` | Lightkey importer, show installer, jump check, timing probe |
| `shows` | Show files |

More detail:
- [docs/STATUS.md](docs/STATUS.md): what's built, what's next, known issues
- [docs/SPEC.md](docs/SPEC.md): the product spec
- [docs/DECISIONS.md](docs/DECISIONS.md): choices made and why
- [CLAUDE.md](CLAUDE.md): project briefing (also read by Claude Code)

## Contributing

Ideas, bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to set up, what to check before sending a change, and how to test safely: Light Runner drives real lights, so changes should never surprise a volunteer on Sunday.

## License

MIT; see [LICENSE](LICENSE). Copyright (c) 2026 Light Runner contributors.

Fixture definitions come from the [Open Fixture Library](https://github.com/OpenLightingProject/open-fixture-library), which is also MIT-licensed; two of its fixture files are included as test data in `packages/shared/test/ofl/`, with OFL's license alongside them.
