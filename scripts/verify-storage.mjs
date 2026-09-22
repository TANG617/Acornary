import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
process.chdir(resolve(import.meta.dirname, '..'));
const source = process.argv[2] ?? 'acornary';
if (source !== 'acornary' && !/^acornary_e2e_\d+$/.test(source))
  throw new Error('Only the local application or this test runner’s databases are supported.');
const restored = `acornary_restore_${Date.now()}`;
const directory = resolve(`.local/backups/verified-${Date.now()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const command = (args, options = {}) => {
  const r = spawnSync('docker', ['compose', ...args], { maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.status !== 0) throw new Error(`Storage command failed: ${r.stderr?.toString()}`);
  return r.stdout;
};
const sql = (db, text) =>
  command([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'acornary',
    '-d',
    db,
    '-X',
    '-q',
    '-t',
    '-A',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    text,
  ])
    .toString()
    .trim();
const snapshot = (db) => {
  const tables = sql(
    db,
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  ).split('\n');
  const result = {};
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected table identifier');
    const data = sql(
      db,
      `SELECT row_to_json(t)::text FROM "${table}" t ORDER BY row_to_json(t)::text`,
    );
    result[table] = {
      count: Number(sql(db, `SELECT count(*) FROM "${table}"`)),
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }
  return result;
};
let created = false;
try {
  command(['stop', 'app']);
  const before = snapshot(source);
  command(['stop', 'postgres']);
  command(['start', 'postgres']);
  // pg_isready retries without exposing connection secrets.
  command([
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'until pg_isready -U acornary -d acornary >/dev/null 2>&1; do sleep 1; done',
  ]);
  const after = snapshot(source);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Restart snapshot mismatch');
  const dump = command([
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '-U',
    'acornary',
    '--no-owner',
    '--no-privileges',
    source,
  ]);
  writeFileSync(`${directory}/database.sql`, dump, { mode: 0o600 });
  for (const [from, to] of [
    ['.env', 'app.env'],
    ['.local/token', 'token'],
  ]) {
    copyFileSync(from, `${directory}/${to}`);
    chmodSync(`${directory}/${to}`, 0o600);
  }
  command(['exec', '-T', 'postgres', 'createdb', '-U', 'acornary', restored]);
  created = true;
  command(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'acornary',
      '-d',
      restored,
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: dump },
  );
  const recovered = snapshot(restored);
  if (JSON.stringify(before) !== JSON.stringify(recovered))
    throw new Error('Restore snapshot mismatch');
  const report = {
    verified_at: new Date().toISOString(),
    source_database: source,
    restore_database: restored,
    restart_equal: true,
    restore_equal: true,
    tables: before,
  };
  writeFileSync(`${directory}/verification.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  mkdirSync('output', { recursive: true });
  writeFileSync(`output/storage-${source}.json`, JSON.stringify(report, null, 2));
  console.log(
    `Restart and isolated restore verified across ${Object.keys(before).length} tables. Backup: ${directory}`,
  );
} finally {
  if (created) command(['exec', '-T', 'postgres', 'dropdb', '-U', 'acornary', restored]);
  command(['start', 'app']);
}
