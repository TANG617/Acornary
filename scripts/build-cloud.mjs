import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const run = (cmd, args, capture = false) => {
  const r = spawnSync(cmd, args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed`);
  return r.stdout?.trim();
};
const paths = run(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'apps',
    'packages',
    'migrations',
    'Dockerfile',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsconfig.build.json',
  ],
  true,
)
  .split('\n')
  .sort();
const files = Object.fromEntries(
  [...new Set(paths)].map((path) => [
    path,
    createHash('sha256').update(readFileSync(path)).digest('hex'),
  ]),
);
const source = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const tag = `acornary:stage2-${source.slice(0, 16)}`;
const directory = `.local/releases/${source.slice(0, 16)}`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
const args = [
  'buildx',
  'build',
  '--platform',
  'linux/amd64',
  '--target',
  'runtime',
  '--load',
  '--label',
  `io.acornary.source.sha256=${source}`,
  '-t',
  tag,
];
// Optional DNS override for a locally verified registry address; never baked into the image.
if (process.env.ACORNARY_BUILD_REGISTRY_IP)
  args.push('--add-host', `registry.npmjs.org:${process.env.ACORNARY_BUILD_REGISTRY_IP}`);
run('docker', [...args, '.']);
const image = JSON.parse(run('docker', ['image', 'inspect', tag], true))[0];
if (image.Architecture !== 'amd64') throw new Error('Expected amd64 image');
const manifest = {
  source_sha256: source,
  git_head: run('git', ['rev-parse', 'HEAD'], true),
  image_id: image.Id,
  image: tag,
  platform: `${image.Os}/${image.Architecture}`,
  files,
};
writeFileSync(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', {
  mode: 0o600,
});
run('docker', ['save', '-o', `${directory}/image.tar`, tag]);
console.log(`Built ${tag}; manifest and image saved in ${directory}.`);
