import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const values = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split('=')),
);
spawnSync(
  'docker',
  ['compose', 'exec', '-T', 'postgres', 'createdb', '-U', 'acornary', 'acornary_test'],
  { stdio: 'ignore' },
);
const command = process.argv.slice(2);
const result = spawnSync(
  'docker',
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
    ...(command.length ? command : ['test']),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: `postgres://acornary:${values.POSTGRES_PASSWORD}@postgres:5432/acornary_test`,
    },
  },
);
process.exit(result.status ?? 1);
