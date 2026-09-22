import { readFile } from 'node:fs/promises';
import { initialize } from './initialize.js';
import { buildApp } from './app.js';
import { pool } from './db.js';
const token = (await readFile(process.env.TOKEN_FILE ?? '.local/token', 'utf8')).trim();
if (token.length < 32) throw new Error('Missing token: run node scripts/local.mjs init.');
const installed = await initialize();
const app = await buildApp({ ...installed, source: 'MCP' }, token);
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
