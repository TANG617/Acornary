import { canonical } from '../packages/domain/src/index.js';
// Independent expectation for 001 -> 002. Free-form strings are never traversed or replaced.
export const tables = [
  'households',
  'actors',
  'catalog_nodes',
  'items',
  'attribute_templates',
  'attribute_sets',
  'notes',
  'events',
  'operations',
  'barcode_index',
  'installations',
  'migrations',
];
export const prefixed = (kind: string, id: string | null) =>
  id === null ? null : `${kind}_${id.slice(-36).toLowerCase()}`;
export function migratedRow(table: string, original: any) {
  const row = structuredClone(original);
  const fields: Record<string, Record<string, string>> = {
    households: { id: 'household' },
    actors: { id: 'actor' },
    catalog_nodes: { id: 'catalog_node', parent_id: 'catalog_node' },
    items: { id: 'item', parent_id: 'item', catalog_node_id: 'catalog_node' },
    attribute_sets: { item_id: 'item', catalog_node_id: 'catalog_node' },
    notes: { id: 'note', item_id: 'item', created_by: 'actor' },
    events: { id: 'event', actor_id: 'actor', operation_id: 'operation' },
    operations: { actor_id: 'actor' },
    barcode_index: { catalog_node_id: 'catalog_node' },
    installations: { actor_id: 'actor', container_catalog_id: 'catalog_node' },
  };
  if (row.household_id) row.household_id = prefixed('household', row.household_id);
  for (const [field, kind] of Object.entries(fields[table] ?? {}))
    row[field] = prefixed(kind, row[field]);
  if (table === 'attribute_sets') delete row.id;
  if (table === 'events') {
    row.target_id = prefixed(row.target_kind.toLowerCase(), row.target_id);
    for (const change of row.changes) {
      const kind =
        change.path === 'parent_id'
          ? row.target_kind.toLowerCase()
          : change.path === 'catalog_node_id'
            ? 'catalog_node'
            : null;
      if (kind)
        for (const side of ['before', 'after'])
          if (typeof change[side] === 'string') change[side] = prefixed(kind, change[side]);
      if (change.path.startsWith('notes.')) {
        const parts = change.path.split('.');
        parts[1] = prefixed('note', parts[1])!;
        change.path = parts.join('.');
      }
    }
  }
  if (table === 'operations') {
    row.fingerprint_format = 'legacy_v1';
    row.result.operation_id = prefixed('operation', row.result.operation_id);
    if (row.result.note_id) row.result.note_id = prefixed('note', row.result.note_id);
    for (const o of row.result.affected_objects) o.id = prefixed(o.kind.toLowerCase(), o.id);
    row.result.event_ids = row.result.event_ids.map((id: string) => prefixed('event', id));
  }
  return row;
}
export const sorted = (rows: any[]) =>
  rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
