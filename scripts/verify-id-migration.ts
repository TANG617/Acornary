// Version-aware verification: accepts populated 001, 002 or 003 backups.
import { deepStrictEqual } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../apps/server/src/db.js';
import { initialize } from '../apps/server/src/initialize.js';
import { execute } from '../apps/server/src/service.js';
import { snapshot, verifyEmbedded } from '../tests/embedded-preservation.js';
if (!/\/acornary_migration_check_\d+$/.test(process.env.DATABASE_URL ?? ''))
  throw new Error('Requires isolated database clone.');
try {
  const before = await snapshot(pool);
  const installation = await initialize();
  const after = await snapshot(pool);
  deepStrictEqual(await initialize(), installation);
  if (process.argv[2]) {
    const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
    for (const test of fixture.cases)
      deepStrictEqual(await execute(fixture.ctx, test.name, test.input), test.result);
    deepStrictEqual(await snapshot(pool), after, 'Replay must not modify any row');
  }
  const report = {
    verified_at: new Date().toISOString(),
    source_migrations: before.migrations.map((r) => r.name),
    ...verifyEmbedded(before, after),
    repeated_initialize_equal: true,
    pre_migration_replay_equal: Boolean(process.argv[2]),
  };
  await writeFile(
    process.argv[2]
      ? 'output/embedded-migration-replay.json'
      : 'output/embedded-migration-clone.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await pool.end();
}
