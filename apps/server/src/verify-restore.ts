import pg from 'pg';
import { createHash } from 'node:crypto';
import { pool } from './db.js';
const name = process.argv[2];
if (!/^acornary_restore_[0-9]+$/.test(name ?? ''))
  throw new Error('Verification requires an independent acornary_restore_<timestamp> database.');
const url = new URL(process.env.DATABASE_URL!);
if (url.pathname === `/${name}`) throw new Error('Source and restored database must differ.');
url.pathname = `/${name}`;
const restored = new pg.Pool({ connectionString: url.toString(), max: 1 });
async function snapshot(database: pg.Pool) {
  const c = await database.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const result: Record<string, { count: number; sha256: string }> = {};
    for (const { tablename } of tables) {
      const quoted = '"' + tablename.replaceAll('"', '""') + '"';
      const rows = (await c.query(`SELECT to_jsonb(t)::text AS row FROM ${quoted} t`)).rows.map(r => r.row).sort();
      result[tablename] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    }
    await c.query('COMMIT');
    return result;
  } finally { c.release(); }
}
try {
  const [source, target] = await Promise.all([snapshot(pool), snapshot(restored)]);
  const changed = [...new Set([...Object.keys(source), ...Object.keys(target)])]
    .filter(table => JSON.stringify(source[table]) !== JSON.stringify(target[table]));
  if (changed.length) throw new Error(`Restore differs in: ${changed.join(', ')}. Keep both databases; check whether the source changed after the backup.`);
  console.log(JSON.stringify({ restored_database: name, tables_compared: Object.keys(source).length, identical: true }));
} finally { await pool.end(); await restored.end(); }
