import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const env = Object.fromEntries(
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
const r = spawnSync(
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
    'node:24-bookworm-slim',
    'sh',
    '-c',
    'corepack enable && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: `postgres://acornary:${env.POSTGRES_PASSWORD}@postgres:5432/acornary_test`,
    },
  },
);
process.exit(r.status ?? 1);
