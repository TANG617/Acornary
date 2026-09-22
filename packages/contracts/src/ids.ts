import { z } from 'zod';
export const idKinds = [
  'catalog_node',
  'item',
  'household',
  'actor',
  'note',
  'event',
  'operation',
] as const;
export type IdKind = (typeof idKinds)[number];
export const uuidPattern =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const entityId = (kind: IdKind) => z.string().regex(new RegExp(`^${kind}_${uuidPattern}$`));
