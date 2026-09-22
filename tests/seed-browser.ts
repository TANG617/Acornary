// Synthetic fixtures in an isolated test database, never the user's inventory.
import { initialize } from '../apps/server/src/initialize.js';
import { execute } from '../apps/server/src/service.js';
import { pool } from '../apps/server/src/db.js';
if (!process.env.DATABASE_URL?.match(/\/acornary_e2e_\d+$/))
  throw new Error('Requires a fresh isolated E2E database.');
const installation = await initialize();
const ctx = { ...installation, source: 'E2E_FIXTURE' };
let sequence = 0;
const call = (name: any, input: any) =>
  execute(ctx, name, { idempotency_key: `fixture-${++sequence}`, ...input });
const a = (template_id: string, values: any) => ({ template_id, template_version: 1, values });
try {
  const group = (await call('create_catalog_node', { kind: 'GROUP', name: '验收目录' }))
    .affected_objects[0].id;
  const sku = (
    await call('create_catalog_node', {
      kind: 'SKU',
      name: '验收牛奶 1L',
      parent_id: group,
      initial_attributes: [a('product', { brand: '示例', barcodes: ['TEST-MILK-1L'] })],
    })
  ).affected_objects[0].id;
  const container = async (display_name: string, parent_id?: string) =>
    (
      await call('create_items', {
        catalog_node_id: installation.container_catalog_id,
        count: 1,
        display_name,
        parent_id: parent_id ?? null,
        initial_attributes: [a('container', { can_contain: true })],
      })
    ).affected_objects[0].id;
  const kitchen = await container('验收厨房'),
    room = await container('验收储藏室'),
    bag = await container('验收行李箱', kitchen);
  const milk = (
    await call('create_items', {
      catalog_node_id: sku,
      parent_id: bag,
      count: 6,
      initial_attributes: [
        a('contents', { remaining: { value: '1000', unit: 'mL' }, accuracy: 'MEASURED' }),
        a('lifecycle', { expiry: { date: '2026-10-01' } }),
      ],
    })
  ).affected_objects;
  const id = milk.map((o: any) => o.id).sort()[0];
  await call('open_item', { item_id: id, expected_revisions: { [id]: 1 } });
  await call('consume_item_content', {
    item_id: id,
    expected_revisions: { [id]: 2 },
    amount: { value: '200', unit: 'mL' },
    accuracy: 'MEASURED',
  });
  await call('move_item', { item_id: bag, parent_id: room, expected_revisions: { [bag]: 1 } });
  const note = await call('add_note', {
    item_id: id,
    expected_revisions: { [id]: 3 },
    title: '验收笔记',
    body: '初始笔记',
  });
  await call('update_note', {
    item_id: id,
    note_id: note.note_id,
    expected_revisions: { [id]: 4 },
    body: '已核对：剩余 **800 mL**，位于行李箱。<script>alert(1)</script>',
  });
  console.log(
    'Isolated browser fixtures ready: six milk UUIDs, one changed item, moved container, updated note.',
  );
} finally {
  await pool.end();
}
