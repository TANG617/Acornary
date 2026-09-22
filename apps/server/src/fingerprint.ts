// Compatibility is confined to hashing already-existing operations, never public ID aliases.
export function legacyInput(operation: string, input: any) {
  const result = structuredClone(input);
  const old = (id: string | null | undefined): any =>
    id == null
      ? id
      : id.startsWith('catalog_node_')
        ? 'cat_' + id.slice('catalog_node_'.length)
        : id.startsWith('item_')
          ? id.slice(5)
          : id.startsWith('note_')
            ? id.slice(5)
            : id;
  for (const field of ['item_id', 'catalog_node_id', 'note_id'])
    if (result[field]) result[field] = old(result[field]);
  if (Object.hasOwn(result, 'parent_id')) result.parent_id = old(result.parent_id);
  if (result.item_ids) result.item_ids = result.item_ids.map(old);
  if (result.target) result.target.id = old(result.target.id);
  if (result.core?.catalog_node_id) result.core.catalog_node_id = old(result.core.catalog_node_id);
  if (result.expected_revisions)
    result.expected_revisions = Object.fromEntries(
      Object.entries(result.expected_revisions).map(([key, value]) => [old(key), value]),
    );
  return result;
}
