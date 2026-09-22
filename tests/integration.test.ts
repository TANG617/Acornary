import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execute, type Context } from '../apps/server/src/service.js';
import { pool, query } from '../apps/server/src/db.js';
import { initialize } from '../apps/server/src/initialize.js';
import { debugRead } from '../apps/server/src/debug.js';
import { buildApp } from '../apps/server/src/app.js';
let ctx: Context, containerSku: string;
const key = () => randomUUID();
const run = (name: any, args: any) => execute(ctx, name, args);
const write = (name: any, args: any = {}) => run(name, { idempotency_key: key(), ...args });
const sku = async (name = '牛奶') =>
  (await write('create_catalog_node', { kind: 'SKU', name })).affected_objects[0].id;
const create = async (
  catalog: string,
  count = 1,
  attrs: any[] = [],
  parent_id: string | null = null,
) =>
  (
    await write('create_items', {
      catalog_node_id: catalog,
      count,
      parent_id,
      initial_attributes: attrs,
    })
  ).affected_objects.map((a: any) => a.id);
const attrs = (id: string, values: any) => ({ template_id: id, template_version: 1, values });
const rev = (id: string, n: number) => ({ [id]: n });
beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes('acornary_test'))
    throw new Error('Integration tests require isolated acornary_test database.');
  await initialize();
});
beforeEach(async () => {
  // Independent household per test; never truncate or modify the running application's database.
  const household_id = 'household_' + key(),
    actor_id = 'actor_' + key();
  const original = (await query(pool, "SELECT * FROM installations WHERE slot='local'")).rows[0];
  await query(pool, "INSERT INTO households(id,name,timezone) VALUES($1,'test','Asia/Shanghai')", [
    household_id,
  ]);
  await query(pool, "INSERT INTO actors(id,household_id,name) VALUES($1,$2,'test')", [
    actor_id,
    household_id,
  ]);
  await query(
    pool,
    'INSERT INTO attribute_templates(household_id,id,version,target_kind,definition) SELECT $1,id,version,target_kind,definition FROM attribute_templates WHERE household_id=$2',
    [household_id, original.household_id],
  );
  ctx = { household_id, actor_id, source: 'TEST' };
  containerSku = await sku('容器');
});
afterAll(() => pool.end());
describe('PostgreSQL domain transactions', () => {
  it('creates six identities, opens and consumes only one, preserves unknown inventory', async () => {
    const milk = await sku();
    const ids = await create(milk, 6, [
      attrs('contents', { remaining: { value: '1000', unit: 'mL' }, accuracy: 'MEASURED' }),
      attrs('lifecycle', { expiry: { date: '2026-09-25' } }),
    ]);
    expect(new Set(ids).size).toBe(6);
    await write('open_item', { item_id: ids[0], expected_revisions: rev(ids[0], 1) });
    await write('consume_item_content', {
      item_id: ids[0],
      expected_revisions: rev(ids[0], 2),
      amount: { value: '500', unit: 'mL' },
      accuracy: 'ESTIMATED',
    });
    const item = await run('get_item', { item_id: ids[0] });
    expect(item.revision).toBe(3);
    expect(
      item.attributes.find((a: any) => a.template_id === 'contents').values.remaining.value,
    ).toBe('500');
    expect(item.attributes.find((a: any) => a.template_id === 'lifecycle').values.expiry.date).toBe(
      '2026-09-25',
    );
    const result = await run('query_items', {});
    expect(result.current_count).toBe(6);
    expect(result.unknown_lifecycle_count).toBe(6);
    expect(result.content_totals.by_unit.mL.value).toBe('5500');
  });
  it('replays simultaneous idempotent creates and rejects changed arguments', async () => {
    const args = { idempotency_key: key(), catalog_node_id: await sku(), count: 6 };
    const [a, b] = await Promise.all([run('create_items', args), run('create_items', args)]);
    expect(a).toEqual(b);
    await expect(run('create_items', { ...args, count: 7 })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect((await run('query_items', {})).matching_count).toBe(6);
  });
  it('serializes concurrent consumption and rolls back a partial batch', async () => {
    // Ensure the valid object is mutated first, before the later batch member fails.
    const [b, a] = (await create(await sku(), 2)).sort();
    const outcomes = await Promise.allSettled([
      write('consume_items', { item_ids: [a], expected_revisions: rev(a, 1) }),
      write('consume_items', { item_ids: [a], expected_revisions: rev(a, 1) }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    await expect(
      write('consume_items', { item_ids: [b, a], expected_revisions: { [a]: 2, [b]: 1 } }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await run('get_item', { item_id: b })).revision).toBe(1);
    expect((await run('get_history', { target: { kind: 'ITEM', id: b } })).data).toHaveLength(1);
    const [partial] = await create(await sku(), 1, [
      attrs('contents', { remaining: { value: '1000', unit: 'mL' }, accuracy: 'MEASURED' }),
    ]);
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        write('consume_item_content', {
          item_id: partial,
          expected_revisions: rev(partial, 1),
          amount: { value: '700', unit: 'mL' },
          accuracy: 'MEASURED',
        }),
      ),
    );
    expect(attempts.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const remaining = (await run('get_item', { item_id: partial })).attributes.find(
      (a: any) => a.template_id === 'contents',
    ).values.remaining;
    expect(remaining.value).toBe('300');
  });
  it('rejects terminal restoration through unset and remove; permits reasoned correction', async () => {
    const [id] = await create(await sku());
    await write('consume_items', { item_ids: [id], expected_revisions: rev(id, 1) });
    await expect(
      write('update_attributes', {
        target: { kind: 'ITEM', id },
        template_id: 'lifecycle',
        template_version: 1,
        unset: ['state'],
        expected_revisions: rev(id, 2),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(
      write('remove_attributes', {
        target: { kind: 'ITEM', id },
        template_id: 'lifecycle',
        template_version: 1,
        expected_revisions: rev(id, 2),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await write('correct_item', {
      item_id: id,
      reason: '盘点纠错',
      expected_revisions: rev(id, 2),
      attributes: [{ template_id: 'lifecycle', template_version: 1, unset: ['state'] }],
    });
    expect((await run('query_items', {})).unknown_lifecycle_count).toBe(1);
  });
  it('prevents concurrent cycles and capability removal, with no descendant move events', async () => {
    const [a, b] = await create(containerSku, 2, [attrs('container', { can_contain: true })]);
    const outcomes = await Promise.allSettled([
      write('move_item', { item_id: a, parent_id: b, expected_revisions: rev(a, 1) }),
      write('move_item', { item_id: b, parent_id: a, expected_revisions: rev(b, 1) }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(
      (outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason.code,
    ).toBe('CYCLE_DETECTED');
    const child = (await run('get_item', { item_id: a })).parent_id ? a : b,
      parent = child === a ? b : a;
    await expect(
      write('remove_attributes', {
        target: { kind: 'ITEM', id: parent },
        template_id: 'container',
        template_version: 1,
        expected_revisions: rev(parent, 1),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_IN_USE' });
    const before = (await run('get_history', { target: { kind: 'ITEM', id: child } })).data.length;
    const childBefore = (
      await query(pool, 'SELECT to_jsonb(i) AS row FROM items i WHERE id=$1', [child])
    ).rows[0].row;
    const [outside] = await create(containerSku, 1, [attrs('container', { can_contain: true })]);
    await write('move_item', {
      item_id: parent,
      parent_id: outside,
      expected_revisions: rev(parent, 1),
    });
    expect((await run('get_item', { item_id: child, include_path: true })).path_ids).toEqual([
      outside,
      parent,
      child,
    ]);
    expect(
      (await query(pool, 'SELECT to_jsonb(i) AS row FROM items i WHERE id=$1', [child])).rows[0]
        .row,
    ).toEqual(childBefore);
    expect((await run('get_history', { target: { kind: 'ITEM', id: child } })).data).toHaveLength(
      before,
    );
  });
  it('protects household references, barcode uniqueness, and GROUP/SKU invariants', async () => {
    const installed = await initialize();
    await expect(create(installed.container_catalog_id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const group = (await write('create_catalog_node', { kind: 'GROUP', name: '食品' }))
      .affected_objects[0].id;
    await expect(create(group)).rejects.toMatchObject({ code: 'ATTRIBUTE_VALIDATION_FAILED' });
    const a = await sku(),
      b = await sku();
    const bind = (id: string) =>
      write('bind_attributes', {
        target: { kind: 'CATALOG_NODE', id },
        template_id: 'product',
        template_version: 1,
        values: { barcodes: ['6921234567890'] },
        expected_revisions: rev(id, 1),
      });
    await bind(a);
    await expect(bind(b)).rejects.toMatchObject({ code: 'BARCODE_CONFLICT' });
    await expect(
      write('create_catalog_node', { kind: 'SKU', name: '非法', parent_id: a }),
    ).rejects.toMatchObject({ code: 'INVALID_PARENT' });
  });
  it('records note changes and no-op history accurately', async () => {
    const [id] = await create(await sku());
    const added = await write('add_note', {
      item_id: id,
      body: 'first',
      expected_revisions: rev(id, 1),
    });
    const updated = await write('update_note', {
      item_id: id,
      note_id: added.note_id,
      body: 'second',
      expected_revisions: rev(id, 2),
    });
    expect(updated.changed).toBe(true);
    const noChange = await write('update_note', {
      item_id: id,
      note_id: added.note_id,
      body: 'second',
      expected_revisions: rev(id, 3),
    });
    expect(noChange.changed).toBe(false);
    expect((await run('get_item', { item_id: id })).notes[0].body).toBe('second');
    const absent = await write('update_attributes', {
      target: { kind: 'ITEM', id },
      template_id: 'lifecycle',
      template_version: 1,
      unset: ['condition'],
      expected_revisions: rev(id, 3),
    });
    expect(absent.changed).toBe(false);
  });
  it('rejects invalid values atomically and enforces zero content through generic updates', async () => {
    const [id] = await create(await sku());
    const base = {
      target: { kind: 'ITEM', id },
      template_id: 'contents',
      template_version: 1,
      expected_revisions: rev(id, 1),
    };
    await expect(
      write('update_attributes', { ...base, set: { remaining: { value: '20' } } }),
    ).rejects.toMatchObject({ code: 'ATTRIBUTE_VALIDATION_FAILED' });
    await write('update_attributes', { ...base, set: { remaining: { value: '0', unit: 'mL' } } });
    expect((await run('query_items', {})).current_count).toBe(0);
  });
  it('exposes only read HTTP and rejects unauthorized MCP and foreign origins', async () => {
    const app = await buildApp(ctx, 'a'.repeat(64), false);
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/api/read/create_items', payload: {} }))
          .statusCode,
      ).toBe(404);
      expect((await app.inject('/api/read/create_items')).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: '/api/read/query_items',
            headers: { origin: 'https://evil.example' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: '/api/read/query_items', headers: { host: 'evil.example' } }))
          .statusCode,
      ).toBe(403);
      const r = await app.inject('/api/read/query_items');
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('a'.repeat(64));
    } finally {
      await app.close();
    }
  });
  it('reinitializes without new identities and disallows rewriting events', async () => {
    expect(await initialize()).toEqual(await initialize());
    const [id] = await create(await sku());
    await expect(
      query(pool, 'UPDATE events SET event_type=$1 WHERE target_id=$2', ['BAD', id]),
    ).rejects.toThrow();
  });
  it('serves authenticated SDK v2 tools over real Streamable HTTP with idempotent writes', async () => {
    const app = await buildApp(ctx, 'b'.repeat(64), false);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new McpClient({ name: 'acornary-test', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } },
        }),
      );
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain('consume_item_content');
      expect(
        JSON.stringify(list.tools.find((t) => t.name === 'consume_items')?.inputSchema),
      ).not.toContain('selection');
      const args = { kind: 'SKU', name: 'MCP transport fixture', idempotency_key: key() };
      const result: any = await client.callTool({ name: 'create_catalog_node', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(
        (await client.callTool({ name: 'create_catalog_node', arguments: args })).structuredContent,
      ).toEqual(result.structuredContent);
      const invalid = await client.callTool({
        name: 'create_catalog_node',
        arguments: { ...args, selection: 'FEFO' },
      });
      expect(invalid.isError).toBe(true);
      expect(
        (await run('query_catalog_nodes', { name: 'MCP transport fixture' })).matching_count,
      ).toBe(1);
    } finally {
      await client.close();
      await app.close();
    }
  });
  it('filters typed attributes, dates and subtrees without changing aggregate scope', async () => {
    const [box] = await create(containerSku, 1, [attrs('container', { can_contain: true })]);
    const catalog = await sku();
    await create(
      catalog,
      3,
      [attrs('lifecycle', { expiry: { date: '2026-10-01', after_opening_days: 3 } })],
      box,
    );
    const result = await run('query_items', {
      within_item_id: box,
      catalog_node_ids: [catalog],
      limit: 1,
      attribute_filters: [
        { template_id: 'lifecycle', path: 'expiry.date', op: 'gte', value: '2026-09-30' },
        { template_id: 'lifecycle', path: 'expiry.after_opening_days', op: 'eq', value: 3 },
      ],
    });
    expect(result.data).toHaveLength(1);
    expect(result.matching_count).toBe(3);
    expect(result.current_count).toBe(3);
    expect(result.next_cursor).toBeTruthy();
    await expect(
      run('query_items', {
        attribute_filters: [
          { template_id: 'lifecycle', path: 'expiry.date', op: 'gte', value: 'nonsense' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ATTRIBUTE_VALIDATION_FAILED' });
    expect(
      (
        await run('query_items', {
          attribute_filters: [
            { template_id: 'lifecycle', path: 'state', op: 'eq', value: 'ACTIVE' },
          ],
        })
      ).matching_count,
    ).toBe(0);
  });
});

it('keeps SKU references and physical UUIDs stable through correction and catalog edits', async () => {
  const catalog = await sku('洗衣液');
  const [id] = await create(catalog, 1, [
    attrs('contents', { remaining: { value: '40', unit: 'percent' }, accuracy: 'ESTIMATED' }),
  ]);
  const before = (await run('get_attribute_sets', { target: { kind: 'ITEM', id } })).data[0];
  await write('correct_item', {
    item_id: id,
    reason: '称量核对',
    expected_revisions: rev(id, 1),
    attributes: [
      {
        template_id: 'contents',
        template_version: 1,
        set: { remaining: { value: '800', unit: 'mL' }, accuracy: 'MEASURED' },
      },
    ],
  });
  const after = (await run('get_attribute_sets', { target: { kind: 'ITEM', id } })).data[0];
  expect(after).not.toHaveProperty('id');
  expect(after.template_id).toBe(before.template_id);
  expect(after.values.remaining).toEqual({ value: '800', unit: 'mL' });
  const group = (await write('create_catalog_node', { kind: 'GROUP', name: '清洁用品' }))
    .affected_objects[0].id;
  await write('update_catalog_node', {
    catalog_node_id: catalog,
    name: '实测洗衣液',
    expected_revisions: rev(catalog, 1),
  });
  await write('move_catalog_node', {
    catalog_node_id: catalog,
    parent_id: group,
    expected_revisions: rev(catalog, 2),
  });
  await write('update_attributes', {
    target: { kind: 'CATALOG_NODE', id: catalog },
    template_id: 'product',
    template_version: 1,
    set: { barcodes: ['DETERGENT-1'] },
    expected_revisions: rev(catalog, 3),
  });
  const item = await run('get_item', { item_id: id });
  expect(item.id).toBe(id);
  expect(item.catalog_node_id).toBe(catalog);
  expect(item.revision).toBe(2);
  expect(item.catalog_name).toBe('实测洗衣液');
  expect((await run('query_items', { barcode: 'DETERGENT-1' })).data[0].id).toBe(id);
});

it('compares all debug records to PostgreSQL row JSON with scoped pagination and no derived fields', async () => {
  const { debugRead, debugTables } = await import('../apps/server/src/debug.js');
  const [id] = await create(await sku(), 1, [
    attrs('contents', { remaining: { value: '500', unit: 'mL' } }),
    attrs('lifecycle', { condition: 'GOOD' }),
  ]);
  const long = '完整正文'.repeat(3000) + ' <script>bad()</script>';
  await write('add_note', { item_id: id, body: long, expected_revisions: rev(id, 1) });
  const noop = await write('update_item', {
    item_id: id,
    display_name: null,
    expected_revisions: rev(id, 2),
  });
  expect(noop.changed).toBe(false);
  for (const table of debugTables) {
    const result = await debugRead(ctx, { view: 'system', table, limit: 1 });
    const rows = [...result.rows];
    let cursor = result.next_cursor;
    while (cursor) {
      const page = await debugRead(ctx, { view: 'system', table, limit: 1, cursor });
      rows.push(...page.rows);
      cursor = page.next_cursor;
    }
    const where =
      table === 'migrations' ? 'TRUE' : table === 'households' ? 't.id=$1' : 't.household_id=$1';
    const direct = (
      await query(
        pool,
        `SELECT to_jsonb(t) AS record FROM ${table} t WHERE ${where} ORDER BY to_jsonb(t)::text`,
        [ctx.household_id],
      )
    ).rows.map((r) => r.record);
    expect(rows).toEqual(direct);
    expect(result.total_count).toBe(direct.length);
  }
  const core = await debugRead(ctx, {
    view: 'object',
    table: 'items',
    target: { kind: 'ITEM', id },
  });
  expect(core.rows[0]).not.toHaveProperty('path_ids');
  expect(core.rows[0].attributes).toHaveLength(2);
  expect(core.rows[0].display_name).toBeNull();
  for (const binding of core.rows[0].attributes) {
    expect(Object.keys(binding).sort()).toEqual([
      'created_at',
      'template_id',
      'template_version',
      'updated_at',
      'values',
    ]);
  }
  await expect(debugRead(ctx, { view: 'system', table: 'attribute_sets' })).rejects.toMatchObject({
    code: 'ATTRIBUTE_VALIDATION_FAILED',
  });
  expect(await run('get_item', { item_id: id })).not.toHaveProperty('object_kind');
  expect(await run('get_item', { item_id: id })).not.toHaveProperty('path_ids');
  expect((await run('get_item', { item_id: id, include_path: true })).path_ids).toEqual([id]);
  expect(Object.keys((await run('get_item', { item_id: id })).attributes[0]).sort()).toEqual([
    'template_id',
    'template_version',
    'values',
  ]);
  const notes = await debugRead(ctx, {
    view: 'object',
    table: 'notes',
    target: { kind: 'ITEM', id },
  });
  expect(notes.rows[0].body).toBe(long);
  const ops = await debugRead(ctx, { view: 'system', table: 'operations', id: noop.operation_id });
  expect(ops.rows[0].result.event_ids).toEqual([]);
  await expect(debugRead(ctx, { view: 'system', table: 'pg_authid' })).rejects.toMatchObject({
    code: 'ATTRIBUTE_VALIDATION_FAILED',
  });
  await expect(
    debugRead(ctx, { view: 'system', table: 'items', sql: 'DELETE FROM items' }),
  ).rejects.toMatchObject({ code: 'ATTRIBUTE_VALIDATION_FAILED' });
  const foreign = await initialize();
  await expect(
    debugRead(ctx, {
      view: 'object',
      table: 'catalog_nodes',
      target: { kind: 'CATALOG_NODE', id: foreign.container_catalog_id },
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const app = await buildApp(ctx, 'c'.repeat(64), false);
  try {
    for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }])
      expect(
        (
          await app.inject({
            url:
              '/api/debug?input=' +
              encodeURIComponent(JSON.stringify({ view: 'system', table: 'items' })),
            headers,
          })
        ).statusCode,
      ).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/debug', payload: {} })).statusCode).toBe(
      404,
    );
  } finally {
    await app.close();
  }
});
it('replays legacy fingerprints with new IDs without mutating revisions, quantities or free text', async () => {
  const { schemas } = await import('../packages/contracts/src/index.js');
  const { canonical } = await import('../packages/domain/src/index.js');
  const { legacyInput } = await import('../apps/server/src/fingerprint.js');
  const { createHash } = await import('node:crypto');
  const batch = schemas.create_items.parse({
    catalog_node_id: await sku(),
    count: 6,
    idempotency_key: key(),
  });
  const received = await run('create_items', batch);
  const legacyBatch = legacyInput('create_items', batch);
  expect(legacyBatch.catalog_node_id).toBe(
    'cat_' + batch.catalog_node_id.slice('catalog_node_'.length),
  );
  await query(
    pool,
    "UPDATE operations SET fingerprint_format='legacy_v1',fingerprint=$1 WHERE household_id=$2 AND idempotency_key=$3",
    [
      createHash('sha256')
        .update(canonical({ name: 'create_items', input: legacyBatch }))
        .digest('hex'),
      ctx.household_id,
      batch.idempotency_key,
    ],
  );
  expect(await run('create_items', batch)).toEqual(received);
  expect(
    (await run('query_items', { catalog_node_ids: [batch.catalog_node_id] })).matching_count,
  ).toBe(6);
  const [id] = await create(await sku(), 1, [
    attrs('contents', { remaining: { value: '1000', unit: 'mL' } }),
  ]);
  const input = schemas.consume_item_content.parse({
    item_id: id,
    amount: { value: '200', unit: 'mL' },
    expected_revisions: rev(id, 1),
    idempotency_key: key(),
  });
  const result = await run('consume_item_content', input);
  const old = legacyInput('consume_item_content', input);
  expect(old.item_id).toBe(id.slice(5));
  expect(old.expected_revisions).toEqual({ [id.slice(5)]: 1 });
  await query(
    pool,
    "UPDATE operations SET fingerprint_format='legacy_v1',fingerprint=$1 WHERE household_id=$2 AND idempotency_key=$3",
    [
      createHash('sha256')
        .update(canonical({ name: 'consume_item_content', input: old }))
        .digest('hex'),
      ctx.household_id,
      input.idempotency_key,
    ],
  );
  expect(await run('consume_item_content', input)).toEqual(result);
  const item = await run('get_item', { item_id: id });
  expect(item.revision).toBe(2);
  expect(item.attributes[0].values.remaining.value).toBe('800');
  await expect(
    run('consume_item_content', { ...input, amount: { value: '201', unit: 'mL' } }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const text = `literal ${id} catalog_node_${key()}`;
  expect(
    legacyInput('correct_item', {
      item_id: id,
      reason: text,
      attributes: [{ values: { brand: text } }],
    }),
  ).toMatchObject({ reason: text, attributes: [{ values: { brand: text } }] });
  await expect(run('get_item', { item_id: id.slice(5) })).rejects.toMatchObject({
    code: 'ATTRIBUTE_VALIDATION_FAILED',
  });
  await expect(
    query(pool, 'UPDATE items SET id=$1 WHERE id=$2', ['item_BAD', id]),
  ).rejects.toThrow();
  await expect(
    write('bind_attributes', {
      target: { kind: 'ITEM', id },
      template_id: 'contents',
      template_version: 1,
      values: { remaining: { value: '400', unit: 'mL' } },
      expected_revisions: rev(id, 2),
    }),
  ).rejects.toMatchObject({ code: 'ATTRIBUTE_VALIDATION_FAILED' });
});

it('preserves embedded binding times, no-op rows and other bindings across patches and rebinding', async () => {
  const [id] = await create(await sku(), 1, [
    attrs('lifecycle', { condition: 'GOOD' }),
    attrs('contents', { remaining: { value: '1000', unit: 'mL' } }),
  ]);
  const raw = async () =>
    (await query(pool, 'SELECT to_jsonb(i) AS row FROM items i WHERE id=$1', [id])).rows[0].row;
  const first = await raw();
  expect(first.attributes.map((a: any) => a.template_id)).toEqual(['contents', 'lifecycle']);
  const patchInput = {
    target: { kind: 'ITEM', id },
    template_id: 'lifecycle',
    template_version: 1,
  };
  const noop = await write('update_attributes', {
    ...patchInput,
    expected_revisions: rev(id, 1),
    set: { condition: 'GOOD' },
  });
  expect(noop.changed).toBe(false);
  expect(noop.event_ids).toEqual([]);
  expect(await raw()).toEqual(first);
  await write('update_attributes', {
    ...patchInput,
    expected_revisions: rev(id, 1),
    set: { 'expiry.date': '2026-09-25' },
  });
  const next = await raw();
  expect(next.attributes[0]).toEqual(first.attributes[0]);
  expect(next.attributes[1].created_at).toBe(first.attributes[1].created_at);
  expect(next.attributes[1].updated_at).not.toBe(first.attributes[1].updated_at);
  expect(next.attributes[1].values).toEqual({ condition: 'GOOD', expiry: { date: '2026-09-25' } });
  await write('update_attributes', {
    ...patchInput,
    expected_revisions: rev(id, 2),
    unset: ['condition', 'expiry.date'],
  });
  expect((await raw()).attributes).toEqual([first.attributes[0]]);
  await write('open_item', { item_id: id, expected_revisions: rev(id, 3) });
  const rebound = await raw();
  expect(rebound.attributes[1].created_at).not.toBe(first.attributes[1].created_at);
  expect(rebound.attributes[1].created_at).toBe(rebound.attributes[1].updated_at);
  const paths = (
    await query(pool, 'SELECT changes FROM events WHERE target_id=$1', [id])
  ).rows.flatMap((r) => r.changes.map((c: any) => c.path));
  expect(paths).toContain('attributes.lifecycle.expiry.date');
  expect(paths.some((p: string) => /^attributes\.\d/.test(p))).toBe(false);
  const concurrent = await Promise.allSettled([
    write('update_attributes', {
      ...patchInput,
      expected_revisions: rev(id, 4),
      set: { condition: 'WORN' },
    }),
    write('update_attributes', {
      ...patchInput,
      expected_revisions: rev(id, 4),
      set: { availability: 'IN_USE' },
    }),
  ]);
  expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(concurrent.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'REVISION_CONFLICT' },
  });
  expect((await raw()).attributes[0]).toEqual(first.attributes[0]);
});

it('keeps JSON array checks in SQL and enforces binding semantics in the shared service', async () => {
  const [id] = await create(await sku());
  await expect(
    query(pool, "UPDATE items SET attributes='{}'::jsonb WHERE id=$1", [id]),
  ).rejects.toThrow();
  await expect(query(pool, 'UPDATE items SET attributes=NULL WHERE id=$1', [id])).rejects.toThrow();
  const binding = {
    ...attrs('lifecycle', { condition: 'GOOD' }),
    created_at: '2026-09-22T00:00:00Z',
    updated_at: '2026-09-22T00:00:00Z',
  };
  for (const invalid of [
    [binding, binding],
    [{ ...binding, template_version: 2 }],
    [{ ...binding, values: { condition: 'INVALID' } }],
    [{ ...binding, extra: 'unknown' }],
    [{ ...binding, template_id: 'product', values: { brand: 'x' } }],
  ]) {
    // SQL intentionally permits these arrays: no template FK/uniqueness trigger remains.
    await query(pool, 'UPDATE items SET attributes=$1::jsonb WHERE id=$2', [
      JSON.stringify(invalid),
      id,
    ]);
    await expect(
      write('update_item', { item_id: id, display_name: 'rename', expected_revisions: rev(id, 1) }),
    ).rejects.toMatchObject({ code: 'ATTRIBUTE_VALIDATION_FAILED' });
    expect(
      (await debugRead(ctx, { view: 'object', table: 'items', target: { kind: 'ITEM', id } }))
        .rows[0].attributes,
    ).toEqual(invalid);
  }
  await query(pool, "UPDATE items SET attributes='[]'::jsonb WHERE id=$1", [id]);
  expect((await run('get_attribute_sets', { target: { kind: 'ITEM', id } })).data).toEqual([]);
  // Another household has lifecycle v1, but this one does not: no implicit global registry fallback.
  const hh = 'household_' + key(),
    actor = 'actor_' + key();
  await query(pool, "INSERT INTO households(id,name,timezone) VALUES($1,'empty','Asia/Shanghai')", [
    hh,
  ]);
  await query(pool, "INSERT INTO actors(id,household_id,name) VALUES($1,$2,'empty')", [actor, hh]);
  const emptyCtx = { household_id: hh, actor_id: actor, source: 'TEST' };
  const cat = (
    await execute(emptyCtx, 'create_catalog_node', {
      kind: 'SKU',
      name: 'empty',
      idempotency_key: key(),
    })
  ).affected_objects[0].id;
  await expect(
    execute(emptyCtx, 'create_items', {
      catalog_node_id: cat,
      count: 1,
      initial_attributes: [attrs('lifecycle', { condition: 'GOOD' })],
      idempotency_key: key(),
    }),
  ).rejects.toMatchObject({ code: 'ATTRIBUTE_VALIDATION_FAILED' });
  expect(
    (await query(pool, 'SELECT count(*) FROM items WHERE household_id=$1', [hh])).rows[0].count,
  ).toBe('0');
});
