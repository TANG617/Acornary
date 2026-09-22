// Supports snapshots from schema 001, 002 and 003 without assuming a binding table exists.
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../apps/server/src/db.js';
import { snapshot, verifyEmbedded } from '../tests/embedded-preservation.js';
if (!process.argv[2]) throw new Error('Requires pre-migration snapshot JSON');
try {
  const before = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = {
      verified_at: new Date().toISOString(),
      ...verifyEmbedded(before, await snapshot(c)),
    };
    await c.query('COMMIT');
    await writeFile('output/embedded-migration-live.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    c.release();
  }
} finally {
  await pool.end();
}
