import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const sha = process.env.GITHUB_SHA;
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Invalid commit');
execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
const tag = process.env.GITHUB_REF_NAME ?? '';
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag);
const prerelease = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9A-Za-z.-]+$/.test(tag);
const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
if (!manual && !(stable || prerelease)) throw new Error('Invalid release tag');
const version = manual ? `build-${sha.slice(0, 12)}` : tag;
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `version=${version}\ncommit=${sha}\ndeploy=${!manual && stable}\n`,
);
