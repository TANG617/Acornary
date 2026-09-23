import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, transaction } from './db.js';
export async function migrate(grants = false) {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('acornary-migrations',0))");
    await c.query(
      'CREATE TABLE IF NOT EXISTS migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
    );
    for (const name of (await readdir('migrations')).filter((n) => n.endsWith('.sql')).sort()) {
      if (!(await c.query('SELECT 1 FROM migrations WHERE name=$1', [name])).rowCount) {
        await c.query(await readFile(resolve('migrations', name), 'utf8'));
        await c.query('INSERT INTO migrations(name) VALUES($1)', [name]);
      }
    }
    if (grants) await c.query(await readFile('deploy/grants.sql', 'utf8'));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await migrate(process.argv.includes('--grants'));
  await pool.end();
  console.log('Migrations applied.');
}
