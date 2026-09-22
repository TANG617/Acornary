import { entityId } from './ids.js';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { DomainError } from '../../domain/src/index.js';
const text = z.string().min(1).max(500),
  id = entityId('catalog_node'),
  uuid = entityId('item');
const decimal = z
  .string()
  .max(80)
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/);
export const measurement = z.strictObject({
  value: decimal,
  unit: z.enum(['mL', 'g', 'count', 'percent']),
});
const positive = z
  .string()
  .max(80)
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const lifeState = z.enum(['ACTIVE', 'CONSUMED', 'DISPOSED', 'LOST', 'ARCHIVED']);
export const templates = {
  product: {
    target_kind: 'CATALOG_NODE',
    paths: ['brand', 'model', 'specification', 'barcodes', 'net_content', 'storage.requirement'],
    schema: z.strictObject({
      brand: text.optional(),
      model: text.optional(),
      specification: text.optional(),
      barcodes: z
        .array(
          z
            .string()
            .min(1)
            .max(128)
            .regex(/^[\x21-\x7e]+$/),
        )
        .min(1)
        .max(32)
        .optional(),
      net_content: z
        .strictObject({ value: positive, unit: z.enum(['mL', 'g', 'count']) })
        .optional(),
      storage: z
        .strictObject({ requirement: z.enum(['AMBIENT', 'REFRIGERATED', 'FROZEN']).optional() })
        .optional(),
    }),
  },
  lifecycle: {
    target_kind: 'ITEM',
    paths: [
      'state',
      'condition',
      'availability',
      'opening.state',
      'opening.opened_at',
      'expiry.date',
      'expiry.date_kind',
      'expiry.after_opening_days',
      'acquisition.acquired_on',
      'acquisition.batch_label',
    ],
    schema: z.strictObject({
      state: lifeState.optional(),
      condition: z.enum(['NEW', 'GOOD', 'WORN', 'DAMAGED', 'BROKEN']).optional(),
      availability: z
        .enum(['AVAILABLE', 'IN_USE', 'LOANED', 'CLEANING', 'MAINTENANCE', 'IN_TRANSIT'])
        .optional(),
      opening: z
        .strictObject({
          state: z.enum(['SEALED', 'OPENED']).optional(),
          opened_at: z.iso.datetime({ offset: true }).optional(),
        })
        .optional(),
      expiry: z
        .strictObject({
          date: z.iso.date().optional(),
          date_kind: z.enum(['BEST_BEFORE', 'USE_BY', 'ESTIMATED']).optional(),
          after_opening_days: z.int().positive().max(36500).optional(),
        })
        .optional(),
      acquisition: z
        .strictObject({ acquired_on: z.iso.date().optional(), batch_label: text.optional() })
        .optional(),
    }),
  },
  contents: {
    target_kind: 'ITEM',
    paths: ['remaining', 'accuracy'],
    schema: z.strictObject({
      remaining: measurement.optional(),
      accuracy: z.enum(['ESTIMATED', 'MEASURED']).optional(),
    }),
  },
  container: {
    target_kind: 'ITEM',
    paths: ['can_contain'],
    schema: z.strictObject({ can_contain: z.boolean().optional() }),
  },
  catalog: {
    target_kind: 'CATALOG_NODE',
    paths: ['visibility'],
    schema: z.strictObject({ visibility: z.enum(['VISIBLE', 'HIDDEN']).optional() }),
  },
  clothing: {
    target_kind: 'CATALOG_NODE',
    paths: ['material', 'color', 'size'],
    schema: z.strictObject({
      material: text.optional(),
      color: text.optional(),
      size: text.optional(),
    }),
  },
  device: {
    target_kind: 'CATALOG_NODE',
    paths: ['connector', 'rated_power_w'],
    schema: z.strictObject({ connector: text.optional(), rated_power_w: positive.optional() }),
  },
} as const;
export type TemplateId = keyof typeof templates;
export const templateId = z.enum([
  'product',
  'lifecycle',
  'contents',
  'container',
  'catalog',
  'clothing',
  'device',
]);
export function templateDefinition(name: TemplateId) {
  const t = templates[name];
  return {
    id: name,
    version: 1,
    name,
    target_kind: t.target_kind,
    allowed_catalog_node_kinds: t.target_kind === 'CATALOG_NODE' ? ['SKU'] : [],
    paths: t.paths,
    schema: z.toJSONSchema(t.schema),
    fields_optional: true,
  };
}
export function validateValues(name: TemplateId, values: unknown): any {
  const result = templates[name].schema.safeParse(values);
  if (!result.success)
    throw new DomainError(
      'ATTRIBUTE_VALIDATION_FAILED',
      'Invalid template values.',
      result.error.issues,
    );
  const v: any = result.data;
  const fail = (message: string) => {
    throw new DomainError('ATTRIBUTE_VALIDATION_FAILED', message);
  };
  if (name === 'lifecycle' && v.opening?.state === 'SEALED' && v.opening.opened_at)
    fail('SEALED cannot have opened_at.');
  const m = v.net_content ?? v.remaining;
  if (m) {
    const d = new Decimal(m.value);
    if (name === 'product' && !d.gt(0)) fail('Net content must be positive.');
    if (m.unit === 'count' && !d.isInteger()) fail('count must be an integer.');
    if (m.unit === 'percent' && d.gt(100)) fail('percent must be at most 100.');
  }
  if (v.rated_power_w && !new Decimal(v.rated_power_w).gt(0)) fail('Power must be positive.');
  if (v.barcodes && new Set(v.barcodes).size !== v.barcodes.length) fail('Duplicate barcodes.');
  return v;
}
export const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ITEM'), id: uuid }),
  z.strictObject({ kind: z.literal('CATALOG_NODE'), id }),
]);
export type Target = z.infer<typeof target>;
const revisions = z.record(z.union([id, uuid]), z.int().positive());
const write = {
  idempotency_key: z.string().min(1).max(200),
  expected_revisions: revisions.default({}),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
};
const attr = { template_id: templateId, template_version: z.literal(1) };
const values = z.record(z.string(), z.unknown());
const patchShape = {
  ...attr,
  set: z.record(z.string(), z.unknown()).default({}),
  unset: z.array(z.string()).max(50).default([]),
};
const initial = z
  .array(z.strictObject({ ...attr, values }))
  .max(7)
  .optional();
const page = {
  limit: z.int().min(1).max(200).default(100),
  cursor: z.string().max(200).optional(),
};
const filters = z
  .array(
    z.strictObject({
      template_id: templateId,
      path: z.string().max(100),
      op: z.enum(['eq', 'gte', 'lte']),
      value: z.unknown(),
    }),
  )
  .max(20)
  .optional();
export const schemas = {
  query_catalog_nodes: z.strictObject({
    ...page,
    include_path: z.boolean().default(false),
    name: z.string().max(500).optional(),
    barcode: z.string().max(128).optional(),
    catalog_subtree_id: id.optional(),
    include_hidden: z.boolean().default(false),
    attribute_filters: filters,
  }),
  get_catalog_node: z.strictObject({
    catalog_node_id: id,
    include_path: z.boolean().default(false),
  }),
  create_catalog_node: z.strictObject({
    ...write,
    kind: z.enum(['GROUP', 'SKU']),
    name: text.regex(/\S/),
    parent_id: id.nullable().default(null),
    initial_attributes: initial,
  }),
  update_catalog_node: z.strictObject({ ...write, catalog_node_id: id, name: text.regex(/\S/) }),
  move_catalog_node: z.strictObject({ ...write, catalog_node_id: id, parent_id: id.nullable() }),
  query_items: z.strictObject({
    ...page,
    include_path: z.boolean().default(false),
    name: z.string().max(500).optional(),
    barcode: z.string().max(128).optional(),
    catalog_node_ids: z.array(id).max(100).optional(),
    catalog_subtree_id: id.optional(),
    within_item_id: uuid.optional(),
    attribute_filters: filters,
  }),
  get_item: z.strictObject({ item_id: uuid, include_path: z.boolean().default(false) }),
  create_items: z.strictObject({
    ...write,
    catalog_node_id: id,
    parent_id: uuid.nullable().default(null),
    count: z.int().min(1).max(100),
    display_name: text.optional(),
    initial_attributes: initial,
  }),
  update_item: z.strictObject({ ...write, item_id: uuid, display_name: text.nullable() }),
  move_item: z.strictObject({ ...write, item_id: uuid, parent_id: uuid.nullable() }),
  open_item: z.strictObject({
    ...write,
    item_id: uuid,
    opened_at: z.iso.datetime({ offset: true }).optional(),
  }),
  consume_items: z.strictObject({ ...write, item_ids: z.array(uuid).min(1).max(100) }),
  consume_item_content: z.strictObject({
    ...write,
    item_id: uuid,
    amount: measurement,
    accuracy: z.enum(['ESTIMATED', 'MEASURED']).optional(),
  }),
  correct_item: z.strictObject({
    ...write,
    item_id: uuid,
    reason: text,
    core: z.strictObject({ catalog_node_id: id }).optional(),
    attributes: z.array(z.strictObject(patchShape)).max(7).optional(),
  }),
  list_attribute_templates: z.strictObject({
    target_kind: z.enum(['ITEM', 'CATALOG_NODE']).optional(),
  }),
  get_attribute_template: z.strictObject(attr),
  get_attribute_sets: z.strictObject({ target }),
  bind_attributes: z.strictObject({ ...write, target, ...attr, values }),
  update_attributes: z.strictObject({ ...write, target, ...patchShape }),
  remove_attributes: z.strictObject({ ...write, target, ...attr }),
  add_note: z.strictObject({
    ...write,
    item_id: uuid,
    title: text.optional(),
    body: z.string().max(100000),
  }),
  update_note: z.strictObject({
    ...write,
    item_id: uuid,
    note_id: entityId('note'),
    title: text.nullable().optional(),
    body: z.string().max(100000),
  }),
  get_history: z.strictObject({
    ...page,
    target: target.optional(),
    operation_id: entityId('operation').optional(),
  }),
};
export type Operation = keyof typeof schemas;
export const reads = new Set<Operation>([
  'query_catalog_nodes',
  'get_catalog_node',
  'query_items',
  'get_item',
  'list_attribute_templates',
  'get_attribute_template',
  'get_attribute_sets',
  'get_history',
]);
export const descriptions: Record<Operation, string> = {
  query_catalog_nodes: '查询目录树、SKU、名称和商品条码，返回稳定 ID 和版本。',
  get_catalog_node: '读取一个目录节点及其模板属性。',
  create_catalog_node: '创建分类 GROUP 或商品 SKU，分类父节点必须是 GROUP。',
  update_catalog_node: '修改目录名称，稳定 ID 不变。',
  move_catalog_node: '移动目录分类，禁止环和跨家庭引用。',
  query_items:
    '查询具体实例、位置路径、版本和库存统计；未知不等于 ACTIVE 或 AVAILABLE。多个候选必须请用户确认，不自动选取。',
  get_item: '读取明确 UUID 的物品、模板值、位置、文字笔记和版本。',
  create_items: '创建 count 个不同 UUID 的实例；批量共享明确的初始属性，不合并身份。',
  update_item: '修改明确 UUID 的显示名。',
  move_item: '移动明确 UUID 的物品或容器，后代相对位置不变。',
  open_item:
    '开封用户明确指定的 UUID。多个候选必须先询问用户。opened_at 仅填写用户提供的已知时间。',
  consume_items: '整件消耗用户明确指定的 item_ids，不接受自动选取或 FEFO。',
  consume_item_content:
    '从明确 UUID 扣减正数内容量。需要已知剩余量，不从 SKU 猜测。percent 是初始内容的百分点。',
  correct_item: '带原因纠正明确 UUID 的属性或商品关联，可修复终结状态。',
  list_attribute_templates: '发现内置的七个可选属性模板。',
  get_attribute_template: '读取指定模板版本和允许字段。',
  get_attribute_sets: '读取目标已绑定的模板和值。',
  bind_attributes: '绑定尚未存在的模板，不覆盖已有值。',
  update_attributes: '按模板内路径 set/unset 更新，未涉及字段保留；Measurement 整体更新。',
  remove_attributes: '移除目标模板，不能绕过容纳或生命周期约束。',
  add_note: '为明确 UUID 添加文字笔记；不隐式修改库存。',
  update_note: '修改属于明确 UUID 的文字笔记。',
  get_history: '查询对象或操作的追加式历史。',
};
