// Runs with the preserved schema-002 application image against an isolated clone only.
import { execute } from '/app/dist/apps/server/src/service.js';
import { pool } from '/app/dist/apps/server/src/db.js';
import { legacyInput } from '/app/dist/apps/server/src/fingerprint.js';
import { canonical } from '/app/dist/packages/domain/src/index.js';
import { schemas } from '/app/dist/packages/contracts/src/index.js';
import { createHash, randomUUID } from 'node:crypto';
if (!/\/acornary_migration_check_\d+$/.test(process.env.DATABASE_URL ?? ''))
  throw new Error('Isolated clone required');
try {
  const install = (await pool.query("SELECT * FROM installations WHERE slot='local'")).rows[0];
  const ctx = {
    household_id: install.household_id,
    actor_id: install.actor_id,
    source: 'MIGRATION_TEST',
  };
  const catalog = await execute(ctx, 'create_catalog_node', {
    kind: 'SKU',
    name: '迁移验证物品',
    idempotency_key: randomUUID(),
  });
  const input = {
    catalog_node_id: catalog.affected_objects[0].id,
    count: 6,
    initial_attributes: [
      {
        template_id: 'contents',
        template_version: 1,
        values: { remaining: { value: '1000', unit: 'mL' } },
      },
    ],
    idempotency_key: randomUUID(),
  };
  const created = await execute(ctx, 'create_items', input);
  const id = created.affected_objects[0].id;
  const consumeInput = {
    item_id: id,
    amount: { value: '200', unit: 'mL' },
    expected_revisions: { [id]: 1 },
    idempotency_key: randomUUID(),
  };
  const consumed = await execute(ctx, 'consume_item_content', consumeInput);
  // Preserve both fingerprint formats across the actual 002 -> 003 transition.
  const fingerprint = createHash('sha256')
    .update(
      canonical({
        name: 'create_items',
        input: legacyInput('create_items', schemas.create_items.parse(input)),
      }),
    )
    .digest('hex');
  await pool.query(
    "UPDATE operations SET fingerprint=$1,fingerprint_format='legacy_v1' WHERE household_id=$2 AND actor_id=$3 AND idempotency_key=$4",
    [fingerprint, ctx.household_id, ctx.actor_id, input.idempotency_key],
  );
  console.log(
    JSON.stringify({
      ctx,
      cases: [
        { name: 'create_items', input, result: created },
        { name: 'consume_item_content', input: consumeInput, result: consumed },
      ],
    }),
  );
} finally {
  await pool.end();
}
