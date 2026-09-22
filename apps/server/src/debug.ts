import { z } from 'zod';
import { target } from '../../../packages/contracts/src/index.js';
import { DomainError, requireFact } from '../../../packages/domain/src/index.js';
import { query, transaction } from './db.js';
import { type Context } from './service.js';
export const debugTables = [
  'households',
  'actors',
  'catalog_nodes',
  'items',
  'attribute_templates',
  'notes',
  'events',
  'operations',
  'barcode_index',
  'installations',
  'migrations',
] as const;
const schema = z.strictObject({
  view: z.enum(['object', 'system']),
  table: z.enum(debugTables),
  target: target.optional(),
  id: z.string().max(150).optional(),
  template_id: z.string().max(100).optional(),
  template_version: z.int().positive().optional(),
  limit: z.int().min(1).max(200).default(50),
  cursor: z.string().max(100).optional(),
});
export async function debugRead(ctx: Context, raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new DomainError(
      'ATTRIBUTE_VALIDATION_FAILED',
      'Invalid debug query.',
      parsed.error.issues,
    );
  const input = parsed.data;
  return transaction(async (c) => {
    await query(c, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    requireFact(
      (
        await query(c, 'SELECT 1 FROM actors WHERE household_id=$1 AND id=$2', [
          ctx.household_id,
          ctx.actor_id,
        ])
      ).rows.length,
      'FORBIDDEN',
      'Invalid household context.',
    );
    const table = input.table,
      params: any[] = [ctx.household_id];
    let where =
      table === 'migrations' ? 'TRUE' : table === 'households' ? 't.id=$1' : 't.household_id=$1';
    // Only migrations are installation-wide. Every business table is scoped to the authenticated household.
    if (table === 'migrations') params.length = 0;
    const bind = (value: any) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (input.view === 'object') {
      requireFact(input.target, 'ATTRIBUTE_VALIDATION_FAILED', 'Object target is required.');
      const ownTable = input.target.kind === 'ITEM' ? 'items' : 'catalog_nodes';
      requireFact(
        (
          await query(c, `SELECT 1 FROM ${ownTable} WHERE household_id=$1 AND id=$2`, [
            ctx.household_id,
            input.target.id,
          ])
        ).rows.length,
        'NOT_FOUND',
        'Object not found in this household.',
      );
      const id = bind(input.target.id),
        kind = bind(input.target.kind);
      const events = `SELECT e.operation_id FROM events e WHERE e.household_id=$1 AND e.target_id=${id} AND e.target_kind=${kind}`;
      switch (table) {
        case 'items':
        case 'catalog_nodes':
          requireFact(
            table === ownTable,
            'ATTRIBUTE_VALIDATION_FAILED',
            'Wrong core table for target.',
          );
          where += ` AND t.id=${id}`;
          break;
        case 'attribute_templates':
          where += ` AND EXISTS (SELECT 1 FROM ${ownTable} o CROSS JOIN LATERAL jsonb_array_elements(o.attributes) a WHERE o.household_id=t.household_id AND o.id=${id} AND a->>'template_id'=t.id AND a->>'template_version'=t.version::text)`;
          break;
        case 'notes':
          requireFact(
            input.target.kind === 'ITEM',
            'ATTRIBUTE_VALIDATION_FAILED',
            'Notes belong to items.',
          );
          where += ` AND t.item_id=${id}`;
          break;
        case 'events':
          where += ` AND t.target_id=${id} AND t.target_kind=${kind}`;
          break;
        case 'operations':
          where += ` AND t.result->>'operation_id' IN (${events})`;
          break;
        case 'barcode_index':
          requireFact(
            input.target.kind === 'CATALOG_NODE',
            'ATTRIBUTE_VALIDATION_FAILED',
            'Barcode index belongs to catalog nodes.',
          );
          where += ` AND t.catalog_node_id=${id}`;
          break;
        default:
          throw new DomainError('ATTRIBUTE_VALIDATION_FAILED', 'Table is not an object relation.');
      }
    } else
      requireFact(
        !input.target,
        'ATTRIBUTE_VALIDATION_FAILED',
        'System view has no object target.',
      );
    if (input.id) {
      requireFact(
        !['barcode_index', 'installations', 'migrations'].includes(table),
        'ATTRIBUTE_VALIDATION_FAILED',
        'This relation has no independent ID.',
      );
      where += ` AND ${table === 'operations' ? "t.result->>'operation_id'" : 't.id'}=${bind(input.id)}`;
    }
    if (input.template_id) {
      requireFact(
        table === 'attribute_templates',
        'ATTRIBUTE_VALIDATION_FAILED',
        'Template filter requires templates.',
      );
      where += ` AND t.id=${bind(input.template_id)}`;
    }
    if (input.template_version !== undefined) {
      requireFact(
        table === 'attribute_templates',
        'ATTRIBUTE_VALIDATION_FAILED',
        'Template version requires templates.',
      );
      where += ` AND t.version=${bind(input.template_version)}`;
    }
    const offset = input.cursor ? Number(Buffer.from(input.cursor, 'base64url').toString()) : 0;
    requireFact(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        (!input.cursor || /^\d+$/.test(Buffer.from(input.cursor, 'base64url').toString())),
      'ATTRIBUTE_VALIDATION_FAILED',
      'Invalid cursor.',
    );
    const count = Number(
      (await query(c, `SELECT count(*) AS count FROM ${table} t WHERE ${where}`, params)).rows[0]
        .count,
    );
    const rows = (
      await query(
        c,
        `SELECT to_jsonb(t) AS record FROM ${table} t WHERE ${where} ORDER BY to_jsonb(t)::text LIMIT ${bind(input.limit)} OFFSET ${bind(offset)}`,
        params,
      )
    ).rows.map((r) => r.record);
    const columns = (
      await query(
        c,
        "SELECT column_name AS name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [table],
      )
    ).rows;
    const constraints = (
      await query(
        c,
        'SELECT c.conname AS name,c.contype AS type,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.conrelid=to_regclass($1) ORDER BY c.conname',
        [`public.${table}`],
      )
    ).rows;
    return {
      table,
      columns,
      constraints,
      rows,
      total_count: count,
      next_cursor:
        offset + input.limit < count
          ? Buffer.from(String(offset + input.limit)).toString('base64url')
          : null,
    };
  });
}
