import { join, resolve } from 'node:path';

/**
 * Which folder holds the show, its backups and the launcher's settings, or null for the app's usual one (Mac
 * ~/Library/Application Support/Light Runner, Windows %APPDATA%\Light Runner). `--data-dir=<folder>` always wins. The
 * installed app uses the usual folder otherwise. Running from the repository (`electron .`) uses the repository's
 * `data/` folder, as `npm start` does, or LIGHT_RUNNER_DATA, so developing never touches the installed show.
 * @param {{ argv: string[], env: Record<string, string | undefined>, packaged: boolean, repoDir: string }} context
 * @returns {{ dir: string | null, fromArg: boolean }}
 */
export function chooseDataDir({ argv, env, packaged, repoDir }) {
  const arg = argv.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length);
  if (arg) return { dir: resolve(arg), fromArg: true };
  if (packaged) return { dir: null, fromArg: false };
  return { dir: resolve(env.LIGHT_RUNNER_DATA || join(repoDir, 'data')), fromArg: false };
}
