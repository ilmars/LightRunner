// Run by .github/workflows/release.yml when the workflow was started by a tag: the tag must be "v" plus the version
// in the root package.json, so a mistyped tag fails in seconds and not after the builds. It also hands the version to
// the later steps of the job (VERSION).

import { appendFileSync, readFileSync } from 'node:fs';

const tag = process.env.GITHUB_REF_NAME ?? '';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

if (tag !== `v${version}`) {
  console.error(`The tag is ${tag}, but the version in package.json is ${version}, so the tag should be v${version}.`);
  console.error('Change the version (or tag the right commit) and push the tag again. Nothing was published.');
  process.exit(1);
}
console.log(`The tag ${tag} matches the version ${version}.`);
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `VERSION=${version}\n`);
