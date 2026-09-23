import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
// Auth material is deliberately excluded from the migration manifest.
export async function inventoryManifest() {
  const tables = [
    'households',
    'actors',
    'catalog_nodes',
    'items',
    'attribute_templates',
    'notes',
    'events',
    'operations',
    'barcode_index',
    'installations',
    'migrations',
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result: Record<string, unknown> = {};
    for (const table of tables) {
      const where =
        table === 'migrations'
          ? " WHERE name IN ('001_initial.sql','002_unified_ids.sql','003_embed_attributes.sql')"
          : '';
      const rows = (
        await client.query(`SELECT to_jsonb(t)::text AS row FROM "${table}" t${where}`)
      ).rows
        .map((r) => r.row)
        .sort();
      result[table] = {
        count: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      };
    }
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(await inventoryManifest(), null, 2) + '\n');
  } finally {
    await pool.end();
  }
}
