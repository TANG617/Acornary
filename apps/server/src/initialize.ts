import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  templates,
  templateDefinition,
  type TemplateId,
} from '../../../packages/contracts/src/index.js';
import { pool, transaction, query } from './db.js';
import { migrate } from './migrate.js';
export async function initialize() {
  await migrate();
  return transaction(async (c) => {
    await query(c, "SELECT pg_advisory_xact_lock(hashtextextended('acornary-initialize',0))");
    const prior = (await query(c, "SELECT * FROM installations WHERE slot='local'")).rows[0];
    if (prior) return prior;
    const timezone = process.env.HOUSEHOLD_TIMEZONE ?? 'Asia/Shanghai';
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    const household_id = 'household_' + randomUUID(),
      actor_id = 'actor_' + randomUUID(),
      container_catalog_id = 'catalog_node_' + randomUUID();
    await query(c, 'INSERT INTO households(id,name,timezone) VALUES($1,$2,$3)', [
      household_id,
      '我的家庭',
      timezone,
    ]);
    await query(c, 'INSERT INTO actors(id,household_id,name) VALUES($1,$2,$3)', [
      actor_id,
      household_id,
      '本地操作者',
    ]);
    for (const name of Object.keys(templates) as TemplateId[])
      await query(
        c,
        'INSERT INTO attribute_templates(household_id,id,version,target_kind,definition) VALUES($1,$2,1,$3,$4::jsonb)',
        [household_id, name, templates[name].target_kind, JSON.stringify(templateDefinition(name))],
      );
    await query(
      c,
      `INSERT INTO catalog_nodes(id,household_id,kind,name,attributes)
       VALUES($1,$2,'SKU','通用容器',jsonb_build_array(jsonb_build_object(
       'template_id','catalog','template_version',1,'values',jsonb_build_object('visibility','HIDDEN'),
       'created_at',now(),'updated_at',now())))`,
      [container_catalog_id, household_id],
    );
    await query(
      c,
      "INSERT INTO installations(slot,household_id,actor_id,container_catalog_id) VALUES('local',$1,$2,$3)",
      [household_id, actor_id, container_catalog_id],
    );
    return { slot: 'local', household_id, actor_id, container_catalog_id };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ctx = await initialize();
  console.log(JSON.stringify(ctx));
  await pool.end();
}
