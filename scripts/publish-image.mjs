// A version is immutable. Reruns reuse its original digest after checking labels.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const { VERSION: version, COMMIT: commit, GITHUB_OUTPUT: output } = process.env;
if (
  !/^(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|build-[0-9a-f]{12})$/.test(version ?? '') ||
  !/^[0-9a-f]{40}$/.test(commit ?? '')
)
  throw new Error('Invalid image identity');
const image = `ghcr.io/tang617/acornary:${version}`;
const run = (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const prior = run(['buildx', 'imagetools', 'inspect', image]);
let digest;
if (prior.status === 0) {
  digest = prior.stdout.match(/^Digest:\s+(sha256:[0-9a-f]{64})$/m)?.[1];
  if (!digest) throw new Error('No existing image digest');
  const pull = run(['pull', '--platform', 'linux/amd64', `ghcr.io/tang617/acornary@${digest}`]);
  if (pull.status !== 0) throw new Error('Could not inspect existing release');
  const inspect = run(['image', 'inspect', `ghcr.io/tang617/acornary@${digest}`]);
  const labels = JSON.parse(inspect.stdout)[0].Config.Labels;
  if (
    labels['org.opencontainers.image.revision'] !== commit ||
    labels['org.opencontainers.image.version'] !== version
  )
    throw new Error('Existing version points to another commit; never replace release tags');
} else {
  if (!/not found|manifest unknown|name unknown/i.test(prior.stderr)) {
    process.stderr.write(prior.stderr);
    throw new Error('Registry lookup failed; refusing to assume version is absent');
  }
  const args = [
    'buildx',
    'build',
    '--platform',
    'linux/amd64',
    '--target',
    'runtime',
    '--push',
    '--build-arg',
    `VERSION=${version}`,
    '--build-arg',
    `COMMIT=${commit}`,
    '--label',
    `org.opencontainers.image.version=${version}`,
    '--label',
    `org.opencontainers.image.revision=${commit}`,
    '--label',
    'org.opencontainers.image.source=https://github.com/TANG617/Acornary',
    '--metadata-file',
    '/tmp/acornary-image-metadata.json',
    '-t',
    image,
    '.',
  ];
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  digest = JSON.parse(readFileSync('/tmp/acornary-image-metadata.json', 'utf8'))[
    'containerimage.digest'
  ];
}
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid published digest');
appendFileSync(output, `digest=${digest}\n`);
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  `Published **${version}**\n\nCommit: \`${commit}\`\n\nImage: \`ghcr.io/tang617/acornary@${digest}\`\n`,
);
