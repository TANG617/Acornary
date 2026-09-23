import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dirname, '..'));
const action = process.argv[2] ?? 'help';
if (existsSync('.local/stage2-cutover/SOURCE_STOPPED') && ['init', 'start', 'codex', 'backup'].includes(action))
  throw new Error('This local inventory was frozen for cloud cutover. Use an independent development database, or the documented rollback procedure; do not restart the original inventory.');
function docker(args, options = {}) {
  const r = spawnSync('docker', ['compose', ...args], { stdio: 'inherit', ...options });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (action === 'init') {
  mkdirSync('.local', { recursive: true, mode: 0o700 });
  if (!existsSync('.env'))
    writeFileSync(
      '.env',
      `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nACORNARY_PORT=3210\nHOUSEHOLD_TIMEZONE=Asia/Shanghai\n`,
      { mode: 0o600 },
    );
  if (!existsSync('.local/token'))
    writeFileSync('.local/token', randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  chmodSync('.env', 0o600);
  chmodSync('.local/token', 0o600);
  docker(['up', '-d', '--build']);
  const port = readFileSync('.env', 'utf8').match(/^ACORNARY_PORT=(\d+)$/m)?.[1] ?? '3210';
  console.log(
    `Started. Web: http://127.0.0.1:${port} · token stored in .local/token (not printed).`,
  );
} else if (action === 'stop') docker(['stop']);
else if (action === 'start') docker(['up', '-d']);
else if (action === 'status') docker(['ps']);
else if (action === 'backup') {
  mkdirSync('.local/backups', { recursive: true, mode: 0o700 });
  const directory = `.local/backups/${new Date().toISOString().replaceAll(':', '-')}`;
  mkdirSync(directory, { mode: 0o700 });
  const file = `${directory}/database.sql`;
  // Stop application writes for a coherent snapshot. Always restart, including dump failure.
  docker(['stop', 'app']);
  try {
    const r = spawnSync(
      'docker',
      [
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
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    if (r.status !== 0) throw new Error('pg_dump failed');
    writeFileSync(file, r.stdout, { mode: 0o600 });
    for (const [from, to] of [
      ['.env', 'app.env'],
      ['.local/token', 'token'],
    ]) {
      copyFileSync(from, `${directory}/${to}`);
      chmodSync(`${directory}/${to}`, 0o600);
    }
    console.log(directory);
  } finally {
    docker(['start', 'app']);
  }
} else if (action === 'codex') {
  const token = readFileSync('.local/token', 'utf8').trim();
  const config = readFileSync('.env', 'utf8');
  const port = config.match(/^ACORNARY_PORT=(\d+)$/m)?.[1] ?? '3210';
  const args = [
    '-c',
    `mcp_servers.acornary.url="http://127.0.0.1:${port}/mcp"`,
    '-c',
    'mcp_servers.acornary.bearer_token_env_var="ACORNARY_TOKEN"',
    ...process.argv.slice(3),
  ];
  const r = spawnSync('codex', args, {
    stdio: 'inherit',
    env: { ...process.env, ACORNARY_TOKEN: token },
  });
  process.exit(r.status ?? 1);
} else
  console.log(
    'Usage: node scripts/local.mjs init|start|stop|status|backup|codex [Codex arguments]',
  );
