-- One-time representation migration. UUID payloads, business revisions and user text stay intact.
CREATE TEMP TABLE saved_constraints ON COMMIT DROP AS
 SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition
 FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('f','c');
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM saved_constraints LOOP
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.relation,r.conname);
 END LOOP;
END $$;
ALTER TABLE events DISABLE TRIGGER immutable_events;
ALTER TABLE attribute_templates DISABLE TRIGGER immutable_templates;

CREATE FUNCTION pg_temp.prefixed(kind text, value text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE suffix text; BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 suffix := lower(right(value,36));
 IF suffix !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'Cannot migrate invalid % identifier',kind;
 END IF;
 RETURN kind || '_' || suffix;
END $$;

ALTER TABLE items ALTER COLUMN id TYPE text USING id::text, ALTER COLUMN parent_id TYPE text USING parent_id::text;
ALTER TABLE attribute_sets ALTER COLUMN item_id TYPE text USING item_id::text;
ALTER TABLE notes ALTER COLUMN id TYPE text USING id::text, ALTER COLUMN item_id TYPE text USING item_id::text;
ALTER TABLE events ALTER COLUMN id TYPE text USING id::text, ALTER COLUMN operation_id TYPE text USING operation_id::text;
ALTER TABLE attribute_sets DROP COLUMN id;
ALTER TABLE operations ADD COLUMN fingerprint_format text NOT NULL DEFAULT 'legacy_v1';
ALTER TABLE operations ALTER COLUMN fingerprint_format SET DEFAULT 'unified_v1';
ALTER TABLE operations ADD CONSTRAINT operations_fingerprint_format CHECK(fingerprint_format IN ('legacy_v1','unified_v1'));

UPDATE households SET id=pg_temp.prefixed('household',id);
UPDATE actors SET id=pg_temp.prefixed('actor',id),household_id=pg_temp.prefixed('household',household_id);
UPDATE catalog_nodes SET id=pg_temp.prefixed('catalog_node',id),parent_id=pg_temp.prefixed('catalog_node',parent_id),household_id=pg_temp.prefixed('household',household_id);
UPDATE items SET id=pg_temp.prefixed('item',id),parent_id=pg_temp.prefixed('item',parent_id),catalog_node_id=pg_temp.prefixed('catalog_node',catalog_node_id),household_id=pg_temp.prefixed('household',household_id);
UPDATE attribute_templates SET household_id=pg_temp.prefixed('household',household_id);
UPDATE attribute_sets SET household_id=pg_temp.prefixed('household',household_id),catalog_node_id=pg_temp.prefixed('catalog_node',catalog_node_id),item_id=pg_temp.prefixed('item',item_id);
UPDATE barcode_index SET household_id=pg_temp.prefixed('household',household_id),catalog_node_id=pg_temp.prefixed('catalog_node',catalog_node_id);
UPDATE notes SET id=pg_temp.prefixed('note',id),household_id=pg_temp.prefixed('household',household_id),item_id=pg_temp.prefixed('item',item_id),created_by=pg_temp.prefixed('actor',created_by);
UPDATE installations SET household_id=pg_temp.prefixed('household',household_id),actor_id=pg_temp.prefixed('actor',actor_id),container_catalog_id=pg_temp.prefixed('catalog_node',container_catalog_id);

CREATE FUNCTION pg_temp.event_changes(entries jsonb, target text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb := '[]'; e jsonb; p text; side text; kind text; BEGIN
 FOR e IN SELECT value FROM jsonb_array_elements(entries) LOOP
  p := e->>'path'; kind := NULL;
  IF p='parent_id' THEN kind:=lower(target); END IF;
  IF p='catalog_node_id' THEN kind:='catalog_node'; END IF;
  IF kind IS NOT NULL THEN
   FOREACH side IN ARRAY ARRAY['before','after'] LOOP
    IF jsonb_typeof(e->side)='string' THEN e:=jsonb_set(e,ARRAY[side],to_jsonb(pg_temp.prefixed(kind,e->>side))); END IF;
   END LOOP;
  END IF;
  IF p ~ '^notes\.[^.]+\.' THEN
   e:=jsonb_set(e,'{path}',to_jsonb('notes.' || pg_temp.prefixed('note',split_part(p,'.',2)) || substring(p from '^notes\.[^.]+(\..*)$')));
  END IF;
  result:=result || jsonb_build_array(e);
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION pg_temp.operation_result(r jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE objects jsonb:='[]'; events jsonb:='[]'; e jsonb; BEGIN
 r:=jsonb_set(r,'{operation_id}',to_jsonb(pg_temp.prefixed('operation',r->>'operation_id')));
 IF r ? 'note_id' THEN r:=jsonb_set(r,'{note_id}',to_jsonb(pg_temp.prefixed('note',r->>'note_id'))); END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(r->'affected_objects') LOOP
  objects:=objects || jsonb_build_array(jsonb_set(e,'{id}',to_jsonb(pg_temp.prefixed(lower(e->>'kind'),e->>'id'))));
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(r->'event_ids') LOOP
  events:=events || jsonb_build_array(pg_temp.prefixed('event',e#>>'{}'));
 END LOOP;
 RETURN jsonb_set(jsonb_set(r,'{affected_objects}',objects),'{event_ids}',events);
END $$;
UPDATE events SET id=pg_temp.prefixed('event',id),household_id=pg_temp.prefixed('household',household_id),target_id=pg_temp.prefixed(lower(target_kind),target_id),operation_id=pg_temp.prefixed('operation',operation_id),actor_id=pg_temp.prefixed('actor',actor_id),changes=pg_temp.event_changes(changes,target_kind);
UPDATE operations SET household_id=pg_temp.prefixed('household',household_id),actor_id=pg_temp.prefixed('actor',actor_id),result=pg_temp.operation_result(result);

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM saved_constraints LOOP
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.relation,r.conname,r.definition);
 END LOOP;
 -- Check every typed identifier, including nullable references, at the database boundary.
 FOR r IN SELECT * FROM (VALUES
 ('households','id','household'),('actors','id','actor'),('actors','household_id','household'),
 ('catalog_nodes','id','catalog_node'),('catalog_nodes','household_id','household'),('catalog_nodes','parent_id','catalog_node'),
 ('items','id','item'),('items','parent_id','item'),('items','catalog_node_id','catalog_node'),('items','household_id','household'),
 ('attribute_templates','household_id','household'),('attribute_sets','household_id','household'),('attribute_sets','catalog_node_id','catalog_node'),('attribute_sets','item_id','item'),
 ('barcode_index','household_id','household'),('barcode_index','catalog_node_id','catalog_node'),
 ('notes','id','note'),('notes','household_id','household'),('notes','item_id','item'),('notes','created_by','actor'),
 ('events','id','event'),('events','household_id','household'),('events','operation_id','operation'),('events','actor_id','actor'),
 ('operations','household_id','household'),('operations','actor_id','actor'),
 ('installations','household_id','household'),('installations','actor_id','actor'),('installations','container_catalog_id','catalog_node')
 ) AS fields(tab,col,kind) LOOP
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I ~ %L)',r.tab,r.tab || '_' || r.col || '_format',r.col,'^' || r.kind || '_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
 END LOOP;
END $$;
ALTER TABLE events ADD CONSTRAINT events_target_format CHECK(target_id ~ ('^' || lower(target_kind) || '_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'));
ALTER TABLE operations ADD CONSTRAINT operations_result_id_format CHECK(result->>'operation_id' ~ '^operation_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
ALTER TABLE events ENABLE TRIGGER immutable_events;
ALTER TABLE attribute_templates ENABLE TRIGGER immutable_templates;
