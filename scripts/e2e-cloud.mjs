import { readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const values = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split('=')),
);
const suffix = Date.now(),
  database = `acornary_e2e_${suffix}`,
  container = `acornary-cloud-e2e-${suffix}`;
const tls = resolve(`.local/e2e-tls-${suffix}`);
mkdirSync(tls, { mode: 0o700, recursive: true });
const childEnv = {
  ...process.env,
  DATABASE_URL: `postgres://acornary:${values.POSTGRES_PASSWORD}@postgres:5432/${database}`,
};
function docker(args, quiet = false) {
  const r = spawnSync('docker', args, { stdio: quiet ? 'ignore' : 'inherit', env: childEnv });
  if (r.status !== 0) throw new Error('Isolated browser command failed.');
}
if (
  spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${tls}/key.pem`,
      '-out',
      `${tls}/cert.pem`,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
    ],
    { stdio: 'ignore' },
  ).status !== 0
)
  throw new Error('Test TLS generation failed.');
const mount = ['-v', `${process.cwd()}:/work`, '-w', '/work'];
try {
  docker(['compose', 'exec', '-T', 'postgres', 'createdb', '-U', 'acornary', database]);
  docker([
    'run',
    '--rm',
    '--network',
    'acornary_default',
    ...mount,
    '-e',
    'DATABASE_URL',
    'acornary-browser-test',
    'sh',
    '-c',
    'pnpm build && pnpm exec tsx tests/seed-browser.ts',
  ]);
  docker([
    'run',
    '-d',
    '--name',
    container,
    '--network',
    'acornary_default',
    ...mount,
    '-v',
    `${tls}:/tls:ro`,
    '-e',
    'DATABASE_URL',
    'acornary-browser-test',
    'pnpm',
    'exec',
    'tsx',
    'tests/cloud-browser-server.ts',
  ]);
  docker([
    'exec',
    container,
    'node',
    '-e',
    `const https=require('node:https'); let attempts=0;
    function probe(){const r=https.get('https://127.0.0.1:3210/health',{rejectUnauthorized:false},s=>{s.resume();if(s.statusCode===200)process.exit(0);retry()});r.on('error',retry)}
    function retry(){if(++attempts>40)process.exit(1);setTimeout(probe,500)} probe();`,
  ]);
  docker([
    'run',
    '--rm',
    '--network',
    `container:${container}`,
    ...mount,
    '-e',
    'ACORNARY_E2E_CLOUD=1',
    '-e',
    'ACORNARY_E2E_ORIGIN=https://127.0.0.1:3210',
    'acornary-browser-test',
    'pnpm',
    'test:e2e',
  ]);
} finally {
  spawnSync('docker', ['logs', '--tail', '30', container], { stdio: 'inherit' });
  spawnSync('docker', ['stop', container], { stdio: 'ignore' });
  spawnSync('docker', ['rm', container], { stdio: 'ignore' });
  spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'dropdb', '-U', 'acornary', '--if-exists', database],
    { stdio: 'ignore' },
  );
}
