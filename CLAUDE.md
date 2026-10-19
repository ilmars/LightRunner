# Light Runner: project briefing

Light Runner is a browser-based lighting controller for a church. Volunteers tap pre-built looks on an iPad; one Node.js server on a Mac mini at the church drives the lights over Art-Net. The product spec is [docs/SPEC.md](docs/SPEC.md). Read [docs/STATUS.md](docs/STATUS.md) for what is built and what is next, and [docs/DECISIONS.md](docs/DECISIONS.md) before changing behaviour the spec describes.

Owner: Ilmārs (@ilmars). The app's interface text is English; the show's preset names are Latvian (from Lightkey) and stay that way.

## Run, test, check

Needs Node.js 24+ (`.ts` files run directly through Node's type stripping; there is no build step).

```bash
npm install
LIGHT_RUNNER_OUTPUT=none npm start   # away from the rig: never sends DMX
npm test                              # unit + server tests (node:test), must pass before every commit
npm run typecheck                     # tsc --noEmit
npm run jump-check                    # hours of random look changes; no fixture may step >5% per frame
npm run timing-probe                  # frame timing on this machine (target ±3 ms of 25 ms)
```

Pages: `/operator/` (volunteers, no login), `/patch/` and `/settings/` (programmer, PIN when one is set). The live show, state and backups are in `data/` (git-ignored); `shows/` holds show files kept in git.

## Layout

| Path | What |
| --- | --- |
| `packages/shared/src` | Show schema (zod), commands and live state (`protocol.ts`), built-in profiles, OFL converter (`ofl.ts`), show compare/merge (`merge.ts`) |
| `packages/engine/src` | The engine. Pure: takes `now` in seconds, returns DMX buffers; no timers or I/O. `fade.ts` (Crossfade, Ramp, ease), `light.ts` (colour + intensity mixing), `layers.ts`, `output.ts` (channel mapping, gamma, CCT), `engine.ts` |
| `server/src` | `app.ts` (HTTP API, WebSocket, command bus, programmer routes), `worker.ts` (frame clock + engine + DMX output on a worker thread), `output/` (Art-Net, sACN, ENTTEC), `store.ts` (atomic saves, 20 backups), `nodewatch.ts`, `discovery.ts`, `ofl.ts` + `ofldb.ts` (fixture database), `auth.ts` |
| `web/` | Plain HTML + JS pages, no framework or build: `operator/`, `patch/`, `settings/` |
| `tools/` | `import-lightkey.py` (Lightkey project → show), `import-stage-l1.sh`, `install-show.ts`, `jump-check.ts`, `timing-probe.ts` |

## Conventions

- TypeScript with erasable syntax only (no enums, namespaces or parameter properties) and `.ts` import extensions; `import type` for types.
- The engine stays pure. Anything with timers, sockets or files lives in `server/`.
- Every input (tablet, HTTP, OSC/MIDI later) becomes the same `Command` (`packages/shared/src/protocol.ts`) and goes through `App.command()`; the server is the single source of truth and pages only display state.
- New engine behaviour gets a test in `packages/engine/test`, and anything touching fades must keep `npm run jump-check` passing.
- Web pages: dark theme, nothing bright enough to light the operator's face, thumb-sized targets on the iPad (1080 × 810 landscape). Match the existing quiet style; the user dislikes controls that stand out.
- Writing (UI text, docs, commits): plain words, sentence case, no jargon a volunteer wouldn't know.
- Commits: small, descriptive messages; push to `main` only when tests pass. For changes by collaborators, use a branch and a pull request.

## The rig (stage L1)

- Art-Net node "NetWork Node 2" at **192.168.0.114**, both ports on **Art-Net universe 1**. The server Mac is 192.168.0.195.
- Groups: **Front lights** P1–P4 (Neewer AS600B, CCT 2 ch), **Key lights** B1–B2 (Elation SixBar 500, 18 ch RGBWAUV × 3), **Background** B3–B6 (Stairville SonicPulse LED Bar 10, 39 ch), **Drum cage** L1 (LED strip RGB), **B8 side bar** (SonicPulse Bar 05, 23 ch). **P5 (Wild Wash) is not used** and is left out.
- The show (`shows/stage-l1.json`) came from the church's Lightkey project via `tools/import-stage-l1.sh <project>` (or set `LIGHTKEY_PROJECT`). Lightkey import is a feature to keep (owner's request): the CLI importer and Settings > "Compare with a file" both accept `.lightkeyproj`. Lightkey and Light Runner must not send to the node at the same time: use Settings > Send DMX to hand over.
- SixBar 500 and AS600B are not in the Open Fixture Library; their types come from Lightkey.

## Gotchas

- On the church Mac, Node 24 is Homebrew's keg-only `node@24`: use `/opt/homebrew/opt/node@24/bin/node` (or add it to PATH).
- Claude Code's sandbox can't read the macOS keychain: `git push` and Homebrew need the sandbox disabled for that one command.
- Frame timing: the worker yields with `setTimeout` until 6 ms before a frame, then sleeps precisely with `Atomics.wait` (macOS coalesces timers). An occasional frame is still ~3.4 ms late; see STATUS.
- Lightkey projects are NSKeyedArchiver binary plists; only Python's `plistlib` reads them here, so the importer is Python and the server calls it for "Compare with a file".
