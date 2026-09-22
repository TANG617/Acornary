import { it, expect } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { snapshot as embeddedSnapshot, verifyEmbedded } from './embedded-preservation.js';
import { tables, migratedRow, sorted } from './migration-preservation.js';
it('migrates nonempty 001 records in one transaction, preserving identities, history, text and fingerprints', async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.pathname.includes('acornary_test')) throw new Error('Requires isolated test database');
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const database = 'acornary_test_migration_' + Date.now();
  let c: pg.Client | undefined;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    url.pathname = '/' + database;
    c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    await c.query(await readFile('migrations/001_initial.sql', 'utf8'));
    await c.query(
      'CREATE TABLE migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())',
    );
    await c.query("INSERT INTO migrations(name) VALUES('001_initial.sql')");
    const hh = 'hh_' + randomUUID(),
      actor = 'actor_' + randomUUID(),
      cat = 'cat_' + randomUUID(),
      group = 'cat_' + randomUUID(),
      item = randomUUID(),
      parent = randomUUID(),
      note = randomUUID(),
      event = randomUUID(),
      op = randomUUID();
    const body = `literal ${item} ${cat} ${note}`;
    await c.query('INSERT INTO households(id,name,timezone) VALUES($1,$2,$3)', [
      hh,
      body,
      'Asia/Shanghai',
    ]);
    await c.query('INSERT INTO actors(id,household_id,name) VALUES($1,$2,$3)', [actor, hh, body]);
    await c.query("INSERT INTO catalog_nodes(id,household_id,kind,name) VALUES($1,$2,'GROUP',$3)", [
      group,
      hh,
      body,
    ]);
    await c.query(
      "INSERT INTO catalog_nodes(id,household_id,parent_id,kind,name) VALUES($1,$2,$3,'SKU',$4)",
      [cat, hh, group, body],
    );
    await c.query(
      'INSERT INTO items(id,household_id,catalog_node_id,revision) VALUES($1,$2,$3,3)',
      [parent, hh, cat],
    );
    await c.query(
      'INSERT INTO items(id,household_id,catalog_node_id,parent_id,revision) VALUES($1,$2,$3,$4,7)',
      [item, hh, cat, parent],
    );
    await c.query(
      "INSERT INTO attribute_templates(household_id,id,version,target_kind,definition) VALUES($1,'lifecycle',1,'ITEM',$2)",
      [hh, { paths: ['state'] }],
    );
    await c.query(
      'INSERT INTO attribute_sets(id,household_id,item_id,template_id,template_version,"values") VALUES($1,$2,$3,\'lifecycle\',1,$4)',
      [randomUUID(), hh, item, { condition: 'GOOD' }],
    );
    await c.query(
      'INSERT INTO notes(id,household_id,item_id,body,created_by) VALUES($1,$2,$3,$4,$5)',
      [note, hh, item, body, actor],
    );
    const changes = [
      { path: 'parent_id', before: null, after: parent },
      { path: 'catalog_node_id', before: null, after: cat },
      { path: `notes.${note}.body`, before: null, after: body },
    ];
    await c.query(
      "INSERT INTO events(id,household_id,target_kind,target_id,operation_id,event_type,before_revision,after_revision,changes,actor_id,source,occurred_at,reason) VALUES($1,$2,'ITEM',$3,$4,'NOTE_ADD',6,7,$5,$6,'TEST',now(),$7)",
      [event, hh, item, op, JSON.stringify(changes), actor, body],
    );
    await c.query(
      'INSERT INTO operations(household_id,actor_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4,$5)',
      [
        hh,
        actor,
        'opaque-key',
        'opaque-fingerprint',
        {
          operation_id: op,
          note_id: note,
          affected_objects: [
            { kind: 'ITEM', id: item, revision: 7 },
            { kind: 'CATALOG_NODE', id: cat, revision: 1 },
          ],
          event_ids: [event],
          summary: body,
        },
      ],
    );
    await c.query('INSERT INTO barcode_index VALUES($1,$2,$3)', [hh, 'barcode-1', cat]);
    await c.query("INSERT INTO installations VALUES('local',$1,$2,$3)", [hh, actor, cat]);
    const snapshot = async () => {
      const result: Record<string, any[]> = {};
      for (const t of tables)
        result[t] = (await c!.query(`SELECT to_jsonb(t) AS row FROM ${t} t`)).rows.map(
          (r) => r.row,
        );
      return result;
    };
    const before = await snapshot();
    await c.query('BEGIN');
    await c.query(await readFile('migrations/002_unified_ids.sql', 'utf8'));
    await c.query('COMMIT');
    const after = await snapshot();
    for (const table of tables)
      expect(sorted(after[table]), table).toEqual(
        sorted(before[table].map((r: any) => migratedRow(table, r))),
      );
    expect(after.notes[0].body).toBe(body);
    expect(after.events[0].changes[2].after).toBe(body);
    await expect(c.query("UPDATE events SET source='changed'")).rejects.toThrow('append-only');
    await expect(c.query('DELETE FROM attribute_templates')).rejects.toThrow('append-only');
    expect(
      (
        await c.query(
          "SELECT count(*) FROM information_schema.columns WHERE table_name='attribute_sets' AND column_name='id'",
        )
      ).rows[0].count,
    ).toBe('0');
    await expect(c.query('UPDATE items SET parent_id=id')).rejects.toThrow();
    await c.query("INSERT INTO migrations(name) VALUES('002_unified_ids.sql')");
    const unified = await embeddedSnapshot(c);
    await c.query('BEGIN');
    await c.query(await readFile('migrations/003_embed_attributes.sql', 'utf8'));
    await c.query("INSERT INTO migrations(name) VALUES('003_embed_attributes.sql')");
    await c.query('COMMIT');
    const embedded = await embeddedSnapshot(c);
    expect(verifyEmbedded(unified, embedded).embedded_bindings).toBe(1);
    await expect(c.query("UPDATE events SET source='changed'")).rejects.toThrow('append-only');
    await expect(c.query("UPDATE items SET attributes='{}'::jsonb")).rejects.toThrow();
    await expect(c.query('UPDATE items SET attributes=NULL')).rejects.toThrow();
  } finally {
    await c?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
});
