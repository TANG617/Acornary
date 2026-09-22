import { legacyInput } from './fingerprint.js';
import { randomUUID, createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import {
  schemas,
  reads,
  templates,
  templateDefinition,
  validateValues,
  type Operation,
  type Target,
  type TemplateId,
} from '../../../packages/contracts/src/index.js';
import {
  DomainError,
  requireFact,
  terminal,
  patch,
  prune,
  canonical,
  changes,
  subtract,
  getPath,
  reminderDate,
} from '../../../packages/domain/src/index.js';
import { query, transaction, type Client } from './db.js';
export type Context = { household_id: string; actor_id: string; source: string };
type ObjectState = { kind: 'ITEM' | 'CATALOG_NODE'; row: any; sets: Record<string, any> };
const table = (kind: string) => (kind === 'ITEM' ? 'items' : 'catalog_nodes');

const eventTypes: Record<string, string> = {
  create_catalog_node: 'CREATE',
  create_items: 'CREATE',
  update_catalog_node: 'UPDATE',
  update_item: 'UPDATE',
  move_catalog_node: 'MOVE',
  move_item: 'MOVE',
  open_item: 'OPEN',
  consume_items: 'CONSUME_ITEMS',
  consume_item_content: 'CONSUME_CONTENT',
  correct_item: 'CORRECT',
  bind_attributes: 'ATTRIBUTE_BIND',
  update_attributes: 'ATTRIBUTE_UPDATE',
  remove_attributes: 'ATTRIBUTE_REMOVE',
  add_note: 'NOTE_CREATE',
  update_note: 'NOTE_UPDATE',
};
export async function load(c: Client, ctx: Context, t: Target): Promise<ObjectState> {
  const row = (
    await query(c, `SELECT * FROM ${table(t.kind)} WHERE household_id=$1 AND id=$2`, [
      ctx.household_id,
      t.id,
    ])
  ).rows[0];
  requireFact(row, 'NOT_FOUND', 'Object not found in this household.');
  const obj = { kind: t.kind, row, sets: {} as Record<string, any> };
  await validateBindings(c, ctx, obj, row.attributes);
  obj.sets = Object.fromEntries(row.attributes.map((a: any) => [a.template_id, a.values]));
  return obj;
}
async function validateBindings(c: Client, ctx: Context, obj: ObjectState, bindings: any[]) {
  requireFact(
    Array.isArray(bindings),
    'ATTRIBUTE_VALIDATION_FAILED',
    'Attributes must be an array.',
  );
  const seen = new Set<string>();
  for (const a of bindings) {
    requireFact(
      a &&
        typeof a === 'object' &&
        !Array.isArray(a) &&
        Object.keys(a).sort().join(',') ===
          'created_at,template_id,template_version,updated_at,values' &&
        typeof a.created_at === 'string' &&
        Number.isFinite(Date.parse(a.created_at)) &&
        typeof a.updated_at === 'string' &&
        Number.isFinite(Date.parse(a.updated_at)) &&
        !seen.has(a.template_id) &&
        a.template_version === 1,
      'ATTRIBUTE_VALIDATION_FAILED',
      'Invalid or duplicate embedded binding.',
    );
    seen.add(a.template_id);
    const t = templates[a.template_id as TemplateId];
    requireFact(
      t && t.target_kind === obj.kind && (obj.kind === 'ITEM' || obj.row.kind === 'SKU'),
      'ATTRIBUTE_VALIDATION_FAILED',
      'Template not applicable to this object.',
    );
    const registered = (
      await query(
        c,
        'SELECT target_kind FROM attribute_templates WHERE household_id=$1 AND id=$2 AND version=$3',
        [ctx.household_id, a.template_id, a.template_version],
      )
    ).rows[0];
    requireFact(
      registered?.target_kind === obj.kind,
      'ATTRIBUTE_VALIDATION_FAILED',
      'Template version is not registered for this household and target.',
    );
    validateValues(a.template_id as TemplateId, a.values);
  }
}

function flatten(obj: ObjectState): Record<string, any> {
  const r: Record<string, any> = {};
  for (const field of obj.kind === 'ITEM'
    ? ['catalog_node_id', 'parent_id', 'display_name']
    : ['kind', 'name', 'parent_id'])
    if (Object.hasOwn(obj.row, field)) r[field] = obj.row[field];
  for (const [name, value] of Object.entries(obj.sets)) {
    r[`attributes.${name}.$binding`] = { template_id: name, template_version: 1 };
    for (const path of templates[name as TemplateId].paths) {
      const v = getPath(value, path);
      if (v !== undefined) r[`attributes.${name}.${path}`] = v;
    }
  }
  return r;
}
async function validate(
  c: Client,
  ctx: Context,
  obj: ObjectState,
  before?: ObjectState,
  correction = false,
) {
  for (const [name, value] of Object.entries(obj.sets)) {
    const t = templates[name as TemplateId];
    requireFact(
      t && t.target_kind === obj.kind && (obj.kind === 'ITEM' || obj.row.kind === 'SKU'),
      'ATTRIBUTE_VALIDATION_FAILED',
      'Template not applicable to this object.',
    );
    obj.sets[name] = prune(validateValues(name as TemplateId, value));
    if (!Object.keys(obj.sets[name]).length) delete obj.sets[name];
  }
  if (obj.kind === 'ITEM') {
    const catalog = await load(c, ctx, { kind: 'CATALOG_NODE', id: obj.row.catalog_node_id });
    requireFact(catalog.row.kind === 'SKU', 'ATTRIBUTE_VALIDATION_FAILED', 'Item requires a SKU.');
    if (obj.sets.container?.can_contain !== true) {
      const children = (
        await query(c, 'SELECT 1 FROM items WHERE household_id=$1 AND parent_id=$2 LIMIT 1', [
          ctx.household_id,
          obj.row.id,
        ])
      ).rows;
      requireFact(!children.length, 'TEMPLATE_IN_USE', 'Container still has children.');
    }
    const was = before?.sets.lifecycle?.state,
      now = obj.sets.lifecycle?.state;
    if (was && terminal.has(was) && !terminal.has(now) && !correction)
      throw new DomainError(
        'INVALID_TRANSITION',
        'Restoring a terminal item requires correct_item with a reason.',
      );
    if (obj.sets.contents?.remaining && new Decimal(obj.sets.contents.remaining.value).isZero())
      obj.sets.lifecycle = { ...obj.sets.lifecycle, state: 'CONSUMED' };
  }
  if (obj.row.parent_id) {
    const parent = await load(c, ctx, { kind: obj.kind, id: obj.row.parent_id } as Target);
    requireFact(
      obj.kind === 'ITEM'
        ? parent.sets.container?.can_contain === true
        : parent.row.kind === 'GROUP',
      'INVALID_PARENT',
      'Parent must be a GROUP or capable container.',
    );
    const ancestors = (
      await query(
        c,
        `WITH RECURSIVE a AS (SELECT id,parent_id FROM ${table(obj.kind)} WHERE household_id=$1 AND id=$2 UNION SELECT n.id,n.parent_id FROM ${table(obj.kind)} n JOIN a ON n.id=a.parent_id WHERE n.household_id=$1) SELECT id FROM a`,
        [ctx.household_id, obj.row.parent_id],
      )
    ).rows;
    requireFact(
      !ancestors.some((a) => a.id === obj.row.id),
      'CYCLE_DETECTED',
      'Cannot attach beneath itself.',
    );
  }
  if (obj.kind === 'CATALOG_NODE' && obj.sets.product?.barcodes) {
    for (const barcode of obj.sets.product.barcodes) {
      const existing = (
        await query(
          c,
          'SELECT catalog_node_id FROM barcode_index WHERE household_id=$1 AND barcode=$2',
          [ctx.household_id, barcode],
        )
      ).rows[0];
      requireFact(
        !existing || existing.catalog_node_id === obj.row.id,
        'BARCODE_CONFLICT',
        'Barcode already belongs to another SKU.',
      );
    }
  }
}
function initialSets(input: any[] | undefined) {
  const sets: Record<string, any> = {};
  for (const attr of input ?? []) {
    requireFact(
      !Object.hasOwn(sets, attr.template_id),
      'ATTRIBUTE_VALIDATION_FAILED',
      'Duplicate template binding.',
    );
    sets[attr.template_id] = attr.values;
  }
  return sets;
}
function mutateAttributes(obj: ObjectState, input: any, mode: string) {
  const name = input.template_id as TemplateId;
  if (mode === 'remove_attributes') {
    delete obj.sets[name];
    return;
  }
  if (mode === 'bind_attributes') {
    requireFact(!obj.sets[name], 'ATTRIBUTE_VALIDATION_FAILED', 'Template already bound.');
    obj.sets[name] = input.values;
    return;
  }
  obj.sets[name] = patch(obj.sets[name] ?? {}, input.set, input.unset, [...templates[name].paths]);
}
export async function execute(ctx: Context, name: Operation, raw: unknown): Promise<any> {
  const parsed = schemas[name].safeParse(raw);
  if (!parsed.success)
    throw new DomainError(
      'ATTRIBUTE_VALIDATION_FAILED',
      'Invalid command input.',
      parsed.error.issues,
    );
  const input: any = parsed.data;
  try {
    return await transaction(async (c) => {
      if (reads.has(name))
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
      if (reads.has(name)) return read(c, ctx, name, input);
      // Household writes are deliberately serialized for Stage1: one lock order also protects tree/capability races.
      await query(c, 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ctx.household_id]);
      const fingerprint = createHash('sha256').update(canonical({ name, input })).digest('hex');
      const old = (
        await query(
          c,
          'SELECT * FROM operations WHERE household_id=$1 AND actor_id=$2 AND idempotency_key=$3',
          [ctx.household_id, ctx.actor_id, input.idempotency_key],
        )
      ).rows[0];
      if (old) {
        requireFact(
          old.fingerprint ===
            (old.fingerprint_format === 'legacy_v1'
              ? createHash('sha256')
                  .update(canonical({ name, input: legacyInput(name, input) }))
                  .digest('hex')
              : fingerprint),
          'IDEMPOTENCY_CONFLICT',
          'Key was used with different parameters.',
        );
        return old.result;
      }
      const operation_id = 'operation_' + randomUUID();
      const result: any = {
        operation_id,
        changed: false,
        affected_objects: [],
        event_ids: [],
        summary: 'No changes.',
      };
      const checkRevision = (obj: ObjectState) =>
        requireFact(
          input.expected_revisions[obj.row.id] === obj.row.revision,
          'REVISION_CONFLICT',
          'Re-query and submit the current revision.',
          { id: obj.row.id, current_revision: obj.row.revision },
        );
      const save = async (
        obj: ObjectState,
        before?: ObjectState,
        extraBefore: Record<string, any> = {},
        extraAfter: Record<string, any> = {},
      ) => {
        await validate(c, ctx, obj, before, name === 'correct_item');
        const delta = changes(
          { ...(before ? flatten(before) : {}), ...extraBefore },
          { ...flatten(obj), ...extraAfter },
        );
        if (!delta.length && before) return;
        const rev = before?.row.revision ?? 0;
        const now = (await query(c, 'SELECT to_jsonb(now()) AS time')).rows[0].time;
        const attributes = Object.keys(obj.sets)
          .sort()
          .map((template_id) => {
            const prior = before?.row.attributes.find((a: any) => a.template_id === template_id);
            return {
              template_id,
              template_version: prior?.template_version ?? 1,
              values: obj.sets[template_id],
              created_at: prior?.created_at ?? now,
              updated_at:
                prior && canonical(prior.values) === canonical(obj.sets[template_id])
                  ? prior.updated_at
                  : now,
            };
          });
        await validateBindings(c, ctx, obj, attributes);
        const embedded = JSON.stringify(attributes);
        if (!before) {
          if (obj.kind === 'ITEM')
            await query(
              c,
              'INSERT INTO items(id,household_id,catalog_node_id,parent_id,display_name,attributes) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
              [
                obj.row.id,
                ctx.household_id,
                obj.row.catalog_node_id,
                obj.row.parent_id,
                obj.row.display_name ?? null,
                embedded,
              ],
            );
          else
            await query(
              c,
              'INSERT INTO catalog_nodes(id,household_id,parent_id,kind,name,attributes) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
              [
                obj.row.id,
                ctx.household_id,
                obj.row.parent_id,
                obj.row.kind,
                obj.row.name,
                embedded,
              ],
            );
        } else if (obj.kind === 'ITEM')
          await query(
            c,
            'UPDATE items SET catalog_node_id=$1,parent_id=$2,display_name=$3,attributes=$6::jsonb,revision=revision+1,updated_at=now() WHERE household_id=$4 AND id=$5',
            [
              obj.row.catalog_node_id,
              obj.row.parent_id,
              obj.row.display_name ?? null,
              ctx.household_id,
              obj.row.id,
              embedded,
            ],
          );
        else
          await query(
            c,
            'UPDATE catalog_nodes SET name=$1,parent_id=$2,attributes=$5::jsonb,revision=revision+1,updated_at=now() WHERE household_id=$3 AND id=$4',
            [obj.row.name, obj.row.parent_id, ctx.household_id, obj.row.id, embedded],
          );
        if (obj.kind === 'CATALOG_NODE') {
          await query(c, 'DELETE FROM barcode_index WHERE household_id=$1 AND catalog_node_id=$2', [
            ctx.household_id,
            obj.row.id,
          ]);
          for (const barcode of obj.sets.product?.barcodes ?? [])
            await query(
              c,
              'INSERT INTO barcode_index(household_id,barcode,catalog_node_id) VALUES($1,$2,$3)',
              [ctx.household_id, barcode, obj.row.id],
            );
        }
        const event_id = 'event_' + randomUUID();
        const enriched = delta.map((d) =>
          d.path.startsWith('attributes.')
            ? { ...d, template_id: d.path.split('.')[1], template_version: 1 }
            : d,
        );
        await query(
          c,
          'INSERT INTO events(id,household_id,target_kind,target_id,operation_id,event_type,before_revision,after_revision,changes,actor_id,source,occurred_at,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)',
          [
            event_id,
            ctx.household_id,
            obj.kind,
            obj.row.id,
            operation_id,
            eventTypes[name],
            rev,
            rev + 1,
            JSON.stringify(enriched),
            ctx.actor_id,
            ctx.source,
            input.occurred_at ?? new Date().toISOString(),
            input.reason ?? null,
          ],
        );
        result.affected_objects.push({
          kind: obj.kind,
          id: obj.row.id,
          before_revision: rev,
          after_revision: rev + 1,
        });
        result.event_ids.push(event_id);
      };
      if (name === 'create_catalog_node') {
        const obj: ObjectState = {
          kind: 'CATALOG_NODE',
          row: {
            id: 'catalog_node_' + randomUUID(),
            kind: input.kind,
            name: input.name,
            parent_id: input.parent_id,
          },
          sets: initialSets(input.initial_attributes),
        };
        await save(obj);
      } else if (name === 'create_items') {
        for (let i = 0; i < input.count; i++)
          await save({
            kind: 'ITEM',
            row: {
              id: 'item_' + randomUUID(),
              catalog_node_id: input.catalog_node_id,
              parent_id: input.parent_id,
              display_name: input.display_name ?? null,
            },
            sets: initialSets(input.initial_attributes),
          });
      } else {
        let targets: Target[];
        if (name === 'consume_items') {
          requireFact(
            new Set(input.item_ids).size === input.item_ids.length,
            'ATTRIBUTE_VALIDATION_FAILED',
            'Duplicate item IDs.',
          );
          targets = input.item_ids.map((id: string) => ({ kind: 'ITEM', id }));
        } else
          targets = [
            input.target ??
              (input.item_id
                ? { kind: 'ITEM', id: input.item_id }
                : { kind: 'CATALOG_NODE', id: input.catalog_node_id }),
          ];
        for (const t of targets.sort((a, b) => a.id.localeCompare(b.id))) {
          const before = await load(c, ctx, t);
          checkRevision(before);
          const obj = structuredClone(before);
          switch (name) {
            case 'update_catalog_node':
              obj.row.name = input.name;
              break;
            case 'update_item':
              obj.row.display_name = input.display_name;
              break;
            case 'move_catalog_node':
            case 'move_item':
              obj.row.parent_id = input.parent_id;
              break;
            case 'bind_attributes':
            case 'update_attributes':
            case 'remove_attributes':
              mutateAttributes(obj, input, name);
              break;
            case 'open_item': {
              requireFact(
                !terminal.has(obj.sets.lifecycle?.state),
                'INVALID_TRANSITION',
                'Terminal item cannot be opened.',
              );
              const opening = obj.sets.lifecycle?.opening;
              if (opening?.state !== 'OPENED' && !opening?.opened_at)
                obj.sets.lifecycle = {
                  ...obj.sets.lifecycle,
                  opening: {
                    state: 'OPENED',
                    ...(input.opened_at ? { opened_at: input.opened_at } : {}),
                  },
                };
              break;
            }
            case 'consume_items':
            case 'consume_item_content': {
              requireFact(
                !terminal.has(obj.sets.lifecycle?.state),
                'INVALID_TRANSITION',
                'Terminal item cannot be consumed.',
              );
              if (name === 'consume_items') {
                obj.sets.lifecycle = { ...obj.sets.lifecycle, state: 'CONSUMED' };
                if (obj.sets.contents?.remaining) obj.sets.contents.remaining.value = '0';
              } else {
                requireFact(
                  obj.sets.contents?.remaining,
                  'MISSING_FACTS',
                  'Known contents.remaining is required to subtract.',
                  { required_paths: ['contents.remaining'], purpose: 'subtract content' },
                );
                obj.sets.contents = subtract(
                  obj.sets.contents.remaining,
                  input.amount,
                  obj.sets.contents.accuracy,
                  input.accuracy,
                );
              }
              break;
            }
            case 'correct_item': {
              if (input.core) obj.row.catalog_node_id = input.core.catalog_node_id;
              const ids = (input.attributes ?? []).map((a: any) => a.template_id);
              requireFact(
                new Set(ids).size === ids.length,
                'ATTRIBUTE_VALIDATION_FAILED',
                'Duplicate template patches.',
              );
              for (const attr of input.attributes ?? [])
                mutateAttributes(obj, attr, 'update_attributes');
              break;
            }
            case 'add_note':
            case 'update_note': {
              const prior =
                name === 'update_note'
                  ? (
                      await query(
                        c,
                        'SELECT * FROM notes WHERE household_id=$1 AND item_id=$2 AND id=$3',
                        [ctx.household_id, obj.row.id, input.note_id],
                      )
                    ).rows[0]
                  : undefined;
              if (name === 'update_note')
                requireFact(prior, 'NOT_FOUND', 'Note not found on this item.');
              const note_id = prior?.id ?? 'note_' + randomUUID();
              const title = input.title === undefined ? (prior?.title ?? null) : input.title;
              const left = prior
                ? { [`notes.${note_id}.body`]: prior.body, [`notes.${note_id}.title`]: prior.title }
                : {};
              const right = {
                [`notes.${note_id}.body`]: input.body,
                [`notes.${note_id}.title`]: title,
              };
              if (changes(left, right).length) {
                if (prior)
                  await query(c, 'UPDATE notes SET title=$1,body=$2,updated_at=now() WHERE id=$3', [
                    title,
                    input.body,
                    note_id,
                  ]);
                else
                  await query(
                    c,
                    'INSERT INTO notes(id,household_id,item_id,title,body,created_by) VALUES($1,$2,$3,$4,$5,$6)',
                    [note_id, ctx.household_id, obj.row.id, title, input.body, ctx.actor_id],
                  );
              }
              await save(obj, before, left, right);
              result.note_id = note_id;
              continue;
            }
            default:
              throw new DomainError('ATTRIBUTE_VALIDATION_FAILED', 'Unsupported command.');
          }
          await save(obj, before);
        }
      }
      result.changed = result.affected_objects.length > 0;
      result.summary = result.changed
        ? `${result.affected_objects.length} object(s) changed; inspect affected_objects and get_history.`
        : 'No changes.';
      await query(
        c,
        'INSERT INTO operations(household_id,actor_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4,$5::jsonb)',
        [
          ctx.household_id,
          ctx.actor_id,
          input.idempotency_key,
          fingerprint,
          JSON.stringify(result),
        ],
      );
      return result;
    });
  } catch (e: any) {
    if (e instanceof DomainError) throw e;
    const code = e.code ?? e.cause?.code;
    if (code === '23505')
      throw new DomainError('ATTRIBUTE_VALIDATION_FAILED', 'Unique constraint conflict.');
    if (code === '23503') throw new DomainError('INVALID_PARENT', 'Invalid household reference.');
    throw e;
  }
}
async function subtree(c: Client, ctx: Context, kind: 'ITEM' | 'CATALOG_NODE', id: string) {
  await load(c, ctx, { kind, id } as Target);
  return new Set(
    (
      await query(
        c,
        `WITH RECURSIVE tree AS (SELECT id FROM ${table(kind)} WHERE household_id=$1 AND id=$2 UNION SELECT n.id FROM ${table(kind)} n JOIN tree t ON n.parent_id=t.id WHERE n.household_id=$1) SELECT id FROM tree`,
        [ctx.household_id, id],
      )
    ).rows.map((r) => r.id),
  );
}
async function bindingRecords(c: Client, ctx: Context, obj: ObjectState) {
  return obj.row.attributes.map(({ template_id, template_version, values }: any) => ({
    template_id,
    template_version,
    values,
  }));
}

async function view(c: Client, ctx: Context, obj: ObjectState, includePath = false) {
  const path = includePath
    ? (
        await query(
          c,
          `WITH RECURSIVE a AS (SELECT id,parent_id,0 AS depth FROM ${table(obj.kind)} WHERE household_id=$1 AND id=$2 UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM ${table(obj.kind)} n JOIN a ON n.id=a.parent_id WHERE n.household_id=$1) SELECT a.id FROM a ORDER BY depth DESC`,
          [ctx.household_id, obj.row.id],
        )
      ).rows.map((r) => r.id)
    : undefined;
  const row: any = {
    ...obj.row,
    ...(includePath ? { path_ids: path } : {}),
    attributes: await bindingRecords(c, ctx, obj),
  };
  if (obj.kind === 'ITEM') {
    row.catalog_name = (
      await query(c, 'SELECT name FROM catalog_nodes WHERE household_id=$1 AND id=$2', [
        ctx.household_id,
        obj.row.catalog_node_id,
      ])
    ).rows[0].name;
    row.notes = (
      await query(
        c,
        'SELECT * FROM notes WHERE household_id=$1 AND item_id=$2 ORDER BY created_at,id',
        [ctx.household_id, obj.row.id],
      )
    ).rows;
    const household = (
      await query(c, 'SELECT timezone FROM households WHERE id=$1', [ctx.household_id])
    ).rows[0];
    row.reminder = reminderDate(obj.sets.lifecycle, household.timezone);
  }
  return row;
}
function paged(rows: any[], input: any) {
  let offset = 0;
  if (input.cursor) {
    const parsed = Buffer.from(input.cursor, 'base64url').toString();
    requireFact(/^\d+$/.test(parsed), 'ATTRIBUTE_VALIDATION_FAILED', 'Invalid cursor.');
    offset = Number(parsed);
    requireFact(Number.isSafeInteger(offset), 'ATTRIBUTE_VALIDATION_FAILED', 'Invalid cursor.');
  }
  const data = rows.slice(offset, offset + input.limit);
  return {
    data,
    next_cursor:
      offset + input.limit < rows.length
        ? Buffer.from(String(offset + input.limit)).toString('base64url')
        : null,
  };
}
async function read(c: Client, ctx: Context, name: Operation, input: any): Promise<any> {
  if (name === 'list_attribute_templates')
    return {
      data: Object.keys(templates)
        .map((n) => templateDefinition(n as TemplateId))
        .filter((t) => !input.target_kind || t.target_kind === input.target_kind),
    };
  if (name === 'get_attribute_template') return templateDefinition(input.template_id);
  if (name === 'get_history') {
    if (input.target) await load(c, ctx, input.target);
    const rows = (
      await query(
        c,
        'SELECT * FROM events WHERE household_id=$1 ORDER BY recorded_at DESC,id DESC',
        [ctx.household_id],
      )
    ).rows.filter(
      (r) =>
        (!input.target ||
          (r.target_kind === input.target.kind && r.target_id === input.target.id)) &&
        (!input.operation_id || r.operation_id === input.operation_id),
    );
    return paged(rows, input);
  }
  if (name === 'get_attribute_sets') {
    const obj = await load(c, ctx, input.target);
    return {
      data: await bindingRecords(c, ctx, obj),
    };
  }
  if (name === 'get_item' || name === 'get_catalog_node')
    return view(
      c,
      ctx,
      await load(c, ctx, {
        kind: name === 'get_item' ? 'ITEM' : 'CATALOG_NODE',
        id: input.item_id ?? input.catalog_node_id,
      } as Target),
      input.include_path,
    );
  const kind = name === 'query_items' ? 'ITEM' : 'CATALOG_NODE';
  const catalogScope = input.catalog_subtree_id
    ? await subtree(c, ctx, 'CATALOG_NODE', input.catalog_subtree_id)
    : undefined;
  const itemScope = input.within_item_id
    ? await subtree(c, ctx, 'ITEM', input.within_item_id)
    : undefined;
  let barcodeIds: Set<string> | undefined;
  if (input.barcode)
    barcodeIds = new Set(
      (
        await query(
          c,
          'SELECT catalog_node_id FROM barcode_index WHERE household_id=$1 AND barcode=$2',
          [ctx.household_id, input.barcode],
        )
      ).rows.map((r) => r.catalog_node_id),
    );
  for (const f of input.attribute_filters ?? []) {
    const t = templates[f.template_id as TemplateId];
    requireFact(
      t.target_kind === kind && (t.paths as readonly string[]).includes(f.path),
      'ATTRIBUTE_VALIDATION_FAILED',
      'Unknown filter path.',
    );
    if (f.op !== 'eq')
      requireFact(
        ['expiry.date', 'acquisition.acquired_on'].includes(f.path),
        'ATTRIBUTE_VALIDATION_FAILED',
        'Range filters support date fields only.',
      );
    validateValues(f.template_id, patch({}, { [f.path]: f.value }, [], [...t.paths]));
  }
  const rows = (
    await query(c, `SELECT id FROM ${table(kind)} WHERE household_id=$1 ORDER BY id`, [
      ctx.household_id,
    ])
  ).rows;
  const matching: ObjectState[] = [];
  for (const row of rows) {
    const obj = await load(c, ctx, { kind, id: row.id } as Target);
    const catalogId = kind === 'ITEM' ? obj.row.catalog_node_id : obj.row.id;
    if (
      (catalogScope && !catalogScope.has(catalogId)) ||
      (itemScope && !itemScope.has(row.id)) ||
      (barcodeIds && !barcodeIds.has(catalogId)) ||
      (input.catalog_node_ids && !input.catalog_node_ids.includes(catalogId))
    )
      continue;
    if (
      kind === 'CATALOG_NODE' &&
      !input.include_hidden &&
      obj.sets.catalog?.visibility === 'HIDDEN'
    )
      continue;
    if (input.name) {
      const name =
        kind === 'ITEM'
          ? (obj.row.display_name ??
            (
              await query(c, 'SELECT name FROM catalog_nodes WHERE id=$1 AND household_id=$2', [
                catalogId,
                ctx.household_id,
              ])
            ).rows[0].name)
          : obj.row.name;
      if (!name.toLocaleLowerCase().includes(input.name.toLocaleLowerCase())) continue;
    }
    if (
      (input.attribute_filters ?? []).some((f: any) => {
        const value = getPath(obj.sets[f.template_id], f.path);
        return (
          value === undefined ||
          (f.op === 'eq'
            ? canonical(value) !== canonical(f.value)
            : f.op === 'gte'
              ? value < f.value
              : value > f.value)
        );
      })
    )
      continue;
    if (
      (input.attribute_filters ?? []).some(
        (f: any) =>
          f.template_id === 'lifecycle' && f.path === 'availability' && f.value === 'AVAILABLE',
      ) &&
      terminal.has(obj.sets.lifecycle?.state)
    )
      continue;
    matching.push(obj);
  }
  const selected = paged(matching, input);
  const data = [];
  for (const obj of selected.data) data.push(await view(c, ctx, obj, input.include_path));
  if (kind === 'CATALOG_NODE') return { ...selected, data, matching_count: matching.length };
  const current = matching.filter((o) => !terminal.has(o.sets.lifecycle?.state));
  const totals: Record<
    string,
    {
      value: string;
      estimated_count: number;
      unknown_accuracy_count: number;
      measured_count: number;
    }
  > = {};
  let unknown_quantity_count = 0,
    unconvertible_percentage_count = 0;
  for (const obj of current) {
    const contents = obj.sets.contents;
    if (!contents?.remaining) {
      unknown_quantity_count++;
      continue;
    }
    const m = contents.remaining;
    if (m.unit === 'percent') {
      unconvertible_percentage_count++;
      continue;
    }
    const group = (totals[m.unit] ??= {
      value: '0',
      estimated_count: 0,
      unknown_accuracy_count: 0,
      measured_count: 0,
    });
    group.value = new Decimal(group.value).plus(m.value).toFixed();
    if (contents.accuracy === 'MEASURED') group.measured_count++;
    else if (contents.accuracy === 'ESTIMATED') group.estimated_count++;
    else group.unknown_accuracy_count++;
  }
  return {
    ...selected,
    data,
    matching_count: matching.length,
    current_count: current.length,
    unknown_lifecycle_count: current.filter((o) => !o.sets.lifecycle?.state).length,
    unknown_availability_count: current.filter((o) => !o.sets.lifecycle?.availability).length,
    content_totals: { by_unit: totals, unknown_quantity_count, unconvertible_percentage_count },
  };
}
