import { readFile } from 'node:fs/promises';
import { initialize } from './initialize.js';
import { buildApp } from './app.js';
import { pool, query } from './db.js';
import { runtimeConfig } from './config.js';
const config = runtimeConfig();
let token = '';
let installed;
if (config.mode === 'local') {
  token = (await readFile(process.env.TOKEN_FILE ?? '.local/token', 'utf8')).trim();
  if (token.length < 32) throw new Error('Missing token: run node scripts/local.mjs init.');
  installed = await initialize();
} else {
  // The runtime role has no DDL permissions. Migration/provisioning is an
  // explicit administrative step, never an implicit empty-household fallback.
  const migrated = await query(pool, "SELECT 1 FROM migrations WHERE name='004_cloud_auth.sql'");
  installed = (await query(pool, "SELECT * FROM installations WHERE slot='local'")).rows[0];
  const owner = (await query(pool, 'SELECT 1 FROM auth_owners')).rowCount;
  if (!migrated.rowCount || !installed || !owner)
    throw new Error(
      'Cloud database must be migrated, initialized and bound to an owner before startup.',
    );
}
const app = await buildApp({ ...installed, source: 'MCP' }, token, true, config);
await app.listen({
  host: process.env.BIND_HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3210),
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    })();
  });
