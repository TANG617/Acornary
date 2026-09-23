// Entirely disposable containers: never uses local .env, volumes or production data.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const network = `acornary-ci-${suffix}`,
  postgres = `${network}-pg`,
  worker = `${network}-worker`;
const tls = resolve(`.local/ci/${suffix}`);
mkdirSync(tls, { recursive: true, mode: 0o700 });
const env = { ...process.env, POSTGRES_PASSWORD: randomBytes(24).toString('hex') };
const run = (command, args, quiet = false) => {
  const r = spawnSync(command, args, { env, stdio: quiet ? 'pipe' : 'inherit' });
  if (r.status !== 0) throw new Error(`${command} ${args[0]} failed`);
};
const docker = (args, quiet) => run('docker', args, quiet);
const url = (db) => `postgres://acornary:${env.POSTGRES_PASSWORD}@${postgres}:5432/${db}`;
try {
  docker(['network', 'create', network], true);
  docker(
    [
      'run',
      '-d',
      '--name',
      postgres,
      '--network',
      network,
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_USER=acornary',
      '-e',
      'POSTGRES_DB=acornary_test',
      'postgres:18-bookworm',
    ],
    true,
  );
  let ready = false;
  for (let n = 0; n < 60; n++) {
    if (
      spawnSync('docker', ['exec', postgres, 'pg_isready', '-U', 'acornary'], { stdio: 'ignore' })
        .status === 0
    ) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('CI PostgreSQL did not start');
  env.DATABASE_URL = url('acornary_test');
  docker(
    [
      'run',
      '-d',
      '--name',
      worker,
      '--network',
      network,
      '-e',
      'DATABASE_URL',
      process.env.ACORNARY_CI_IMAGE ?? 'acornary-ci',
      'node',
      '-e',
      'setInterval(()=>{},10000)',
    ],
    true,
  );
  for (const task of ['typecheck', 'test', 'build']) docker(['exec', worker, 'pnpm', task]);
  const db = `acornary_e2e_${Date.now()}`;
  docker(['exec', postgres, 'createdb', '-U', 'acornary', db]);
  env.DATABASE_URL = url(db);
  run(
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
    true,
  );
  docker(['cp', `${tls}/.`, `${worker}:/tmp/`]);
  docker(['exec', '-e', 'DATABASE_URL', worker, 'pnpm', 'exec', 'tsx', 'tests/seed-browser.ts']);
  docker([
    'exec',
    '-d',
    '-e',
    'DATABASE_URL',
    '-e',
    'ACORNARY_TEST_TLS_DIR=/tmp',
    worker,
    'pnpm',
    'exec',
    'tsx',
    'tests/cloud-browser-server.ts',
  ]);
  docker([
    'exec',
    worker,
    'node',
    '-e',
    `const https=require('node:https');let n=0;function probe(){
    const r=https.get('https://127.0.0.1:3210/health',{rejectUnauthorized:false},s=>{s.resume();if(s.statusCode===200)process.exit(0);retry()});r.on('error',retry)}
    function retry(){if(++n>60)process.exit(1);setTimeout(probe,500)}probe()`,
  ]);
  docker([
    'exec',
    '-e',
    'ACORNARY_E2E_CLOUD=1',
    '-e',
    'ACORNARY_E2E_ORIGIN=https://127.0.0.1:3210',
    worker,
    'pnpm',
    'test:e2e',
  ]);
} finally {
  mkdirSync('output/ci', { recursive: true });
  spawnSync('docker', ['cp', `${worker}:/app/output/playwright`, 'output/ci/'], {
    stdio: 'ignore',
  });
  for (const name of [worker, postgres])
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  rmSync(tls, { recursive: true, force: true });
}
