import { deepStrictEqual } from 'node:assert';
import { migratedRow, sorted } from './migration-preservation.js';
export async function snapshot(c: { query: (...args: any[]) => any }) {
  const names = (
    await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows.map((r: any) => r.tablename as string);
  const result: Record<string, any[]> = {};
  for (const name of names) {
    if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected table name');
    result[name] = (await c.query(`SELECT to_jsonb(t) AS row FROM ${name} t`)).rows.map(
      (r: any) => r.row,
    );
  }
  return result;
}
export function verifyEmbedded(before: Record<string, any[]>, after: Record<string, any[]>) {
  const unified = before.migrations.some((r) => r.name === '002_unified_ids.sql');
  const expected = Object.fromEntries(
    Object.entries(before).map(([table, rows]) => [
      table,
      rows.map((r) => (unified ? structuredClone(r) : migratedRow(table, r))),
    ]),
  );
  if (expected.attribute_sets) {
    for (const table of ['items', 'catalog_nodes'])
      for (const row of expected[table]) {
        const owner = table === 'items' ? 'item_id' : 'catalog_node_id';
        row.attributes = expected.attribute_sets
          .filter((a) => a.household_id === row.household_id && a[owner] === row.id)
          .map(({ template_id, template_version, values, created_at, updated_at }) => ({
            template_id,
            template_version,
            values,
            created_at,
            updated_at,
          }))
          .sort((a, b) => a.template_id.localeCompare(b.template_id));
      }
    delete expected.attribute_sets;
  }
  deepStrictEqual(Object.keys(after).sort(), Object.keys(expected).sort());
  deepStrictEqual(Object.keys(after).length, 11);
  for (const [table, rows] of Object.entries(expected)) {
    const actual =
      table === 'migrations'
        ? after[table].filter((r) => before.migrations.some((b) => b.name === r.name))
        : after[table];
    deepStrictEqual(sorted(actual), sorted(rows), `Preservation mismatch: ${table}`);
  }
  return {
    all_original_rows_preserved: true,
    table_count: 11,
    embedded_bindings: [...after.items, ...after.catalog_nodes].reduce(
      (n, r) => n + r.attributes.length,
      0,
    ),
    tables: Object.fromEntries(Object.entries(after).map(([t, rows]) => [t, rows.length])),
  };
}
