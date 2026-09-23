import { inventoryManifest } from '../apps/server/src/manifest.js';
import { pool } from '../apps/server/src/db.js';
try {
  process.stdout.write(JSON.stringify(await inventoryManifest(), null, 2) + '\n');
} finally {
  await pool.end();
}
