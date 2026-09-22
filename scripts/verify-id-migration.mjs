import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dirname, '..'));
const backup = process.argv[2];
if (!backup)
  throw new Error(
    'Usage: node scripts/verify-id-migration.mjs <schema-001-or-002-or-003-backup-directory>',
  );
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split('=')),
);
const database = 'acornary_migration_check_' + Date.now();
const docker = (args, options = {}) => {
  const r = spawnSync('docker', args, { stdio: 'pipe', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.status !== 0) throw new Error(r.stderr?.toString() ?? 'Docker failed');
  return r.stdout;
};
try {
  docker(['compose', 'exec', '-T', 'postgres', 'createdb', '-U', 'acornary', database]);
  docker(
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'acornary',
      '-d',
      database,
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: readFileSync(resolve(backup, 'database.sql')) },
  );
  if (process.argv[3]) {
    const fixture = docker(
      [
        'run',
        '--rm',
        '--network',
        'acornary_default',
        '-e',
        'DATABASE_URL',
        '-v',
        `${process.cwd()}/scripts/seed-embedded-replay.mjs:/seed.mjs:ro`,
        process.argv[3],
        'node',
        '/seed.mjs',
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: `postgres://acornary:${env.POSTGRES_PASSWORD}@postgres:5432/${database}`,
        },
      },
    );
    writeFileSync('output/embedded-replay-fixture.json', fixture, { mode: 0o600 });
  }
  docker(
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
      'node:24-bookworm-slim',
      'sh',
      '-c',
      'corepack enable && pnpm exec tsx scripts/verify-id-migration.ts' +
        (process.argv[3] ? ' output/embedded-replay-fixture.json' : ''),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: `postgres://acornary:${env.POSTGRES_PASSWORD}@postgres:5432/${database}`,
      },
    },
  );
} finally {
  docker([
    'compose',
    'exec',
    '-T',
    'postgres',
    'dropdb',
    '-U',
    'acornary',
    '--if-exists',
    database,
  ]);
}
