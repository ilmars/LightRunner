# Working on Light Runner

Light Runner runs the lights at a church. Changes reach a live church service, so the rules below are about not surprising the volunteers on Sunday. Start with [docs/STATUS.md](docs/STATUS.md) (what's built, what's next) and [docs/SPEC.md](docs/SPEC.md) (what we're building).

## Set up on your computer

Works on macOS, Windows and Linux.

1. Install [Node.js 24](https://nodejs.org) or newer, [Git](https://git-scm.com), and Python 3 (only needed for Lightkey imports).
2. Get the code and its packages:

   ```bash
   git clone https://github.com/ilmars/LightRunner.git
   cd LightRunner
   npm install
   ```

3. Start it **without sending DMX**, so you can't affect any real lights on your network:

   ```bash
   LIGHT_RUNNER_OUTPUT=none npm start
   ```

   On Windows PowerShell: `$env:LIGHT_RUNNER_OUTPUT="none"; npm start`

4. Open `http://localhost:8080/`. The first start loads a demo rig. To work with the church rig instead, stop the server and install its show:

   ```bash
   node tools/install-show.ts shows/stage-l1.json
   ```

The live show, state and backups live in `data/`, which is not in git. If you change the church show in the app and want to keep the change, export it (Settings > Export show file) into `shows/` and commit it.

## Before you commit

```bash
npm test             # must pass
npm run typecheck    # must pass
npm run jump-check   # must pass if you touched fades, the engine or groups
```

Add or update tests with your change: engine behaviour in `packages/engine/test`, server routes in `server/test`.

## Sending changes

- Make a branch, push it, and open a pull request against `main`. Describe what a volunteer or the lighting lead will notice.
- Small, focused pull requests are easier to review and safer to deploy.
- Update [docs/STATUS.md](docs/STATUS.md) when a feature lands, and add a line to [docs/DECISIONS.md](docs/DECISIONS.md) when you depart from the spec or make a choice that would surprise the next person.

## Using Claude Code

The repo's [CLAUDE.md](CLAUDE.md) briefs Claude Code automatically: layout, conventions, the rig and known gotchas. Open the repo folder in Claude Code and ask it to read docs/STATUS.md to pick up where the last person stopped.

## Testing with the real lights

Only at the church, and only when nobody else is driving the node: Lightkey and Light Runner must not send to the Art-Net node at the same time. Use Settings > Send DMX to hand over, and check the DMX status on the operator page.
