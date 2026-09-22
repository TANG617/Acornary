import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dirname, '..'));
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split('=')),
);
const suffix = Date.now(),
  database = `acornary_e2e_${suffix}`,
  container = `acornary-e2e-${suffix}`;
const tokenFile = resolve(`.local/e2e-token-${suffix}`);
writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
mkdirSync('output/playwright', { recursive: true });
const childEnv = {
  ...process.env,
  DATABASE_URL: `postgres://acornary:${env.POSTGRES_PASSWORD}@postgres:5432/${database}`,
};
const docker = (args, options = {}) => {
  const r = spawnSync('docker', args, { stdio: 'inherit', env: childEnv, ...options });
  if (r.status !== 0) throw new Error(`Docker command failed (${r.status})`);
  return r;
};
try {
  docker(['compose', 'build', 'app']);
  docker(['build', '--target', 'browser-test', '-t', 'acornary-browser-test', '.']);
  docker(['compose', 'exec', '-T', 'postgres', 'createdb', '-U', 'acornary', database]);
  docker([
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
    'corepack enable && pnpm install --frozen-lockfile && pnpm exec tsx tests/seed-browser.ts',
  ]);
  docker([
    'run',
    '--detach',
    '--name',
    container,
    '--network',
    'acornary_default',
    '-e',
    'DATABASE_URL',
    '-v',
    `${tokenFile}:/run/acornary/token:ro`,
    'acornary-app',
  ]);
  // Browser shares only the test application's loopback network namespace, not the production server.
  docker([
    'run',
    '--rm',
    '--network',
    `container:${container}`,
    '-v',
    `${resolve('output/playwright')}:/app/output/playwright`,
    'acornary-browser-test',
  ]);
  const storage = spawnSync(process.execPath, ['scripts/verify-storage.mjs', database], {
    stdio: 'inherit',
  });
  if (storage.status !== 0) throw new Error('Storage verification failed');
} finally {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'dropdb', '-U', 'acornary', '--if-exists', database],
    { stdio: 'ignore' },
  );
  rmSync(tokenFile, { force: true });
}
