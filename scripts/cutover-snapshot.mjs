// This is the one-time formal cutover snapshot, NOT the routine backup command.
// It deliberately leaves the source application stopped, on success or failure.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if (process.argv[2] !== '--preacceptance-verified')
  throw new Error(
    'Run only after real Codex and ChatGPT preacceptance, with --preacceptance-verified.',
  );
const directory = '.local/stage2-cutover';
if (existsSync(directory))
  throw new Error(
    'Cutover directory already exists. Inspect it; never silently replace the migration snapshot.',
  );
mkdirSync(directory, { recursive: true, mode: 0o700 });
function run(args, options = {}) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (r.status !== 0) throw new Error('Cutover command failed; local app remains stopped.');
  return r.stdout;
}
run(['compose', 'stop', 'app']);
writeFileSync(`${directory}/SOURCE_STOPPED`, new Date().toISOString(), { mode: 0o600 });
const sql = run([
  'compose',
  'exec',
  '-T',
  'postgres',
  'pg_dump',
  '-U',
  'acornary',
  '--no-owner',
  '--no-privileges',
  'acornary',
]);
writeFileSync(`${directory}/database.sql`, sql, { mode: 0o600, flag: 'wx' });
const values = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split('=')),
);
const manifest = run(
  [
    'run',
    '--rm',
    '--network',
    'acornary_default',
    '-v',
    `${process.cwd()}:/work`,
    '-w',
    '/work',
    '-e',
    'DATABASE_URL',
    process.env.ACORNARY_TEST_IMAGE ?? 'acornary-browser-test',
    'pnpm',
    'exec',
    'tsx',
    'scripts/inventory-manifest.ts',
  ],
  {
    env: {
      ...process.env,
      DATABASE_URL: `postgres://acornary:${values.POSTGRES_PASSWORD}@postgres:5432/acornary`,
    },
  },
);
JSON.parse(manifest);
writeFileSync(`${directory}/business-manifest.json`, manifest, { mode: 0o600 });
writeFileSync(
  `${directory}/snapshot.sha256`,
  createHash('sha256').update(sql).digest('hex') + '\n',
  { mode: 0o600 },
);
run(['compose', 'stop', 'postgres']);
console.log(
  'One-time snapshot complete. Original local application and PostgreSQL remain STOPPED.',
);
