CREATE TABLE households (id text PRIMARY KEY, name text NOT NULL, timezone text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE actors (id text PRIMARY KEY, household_id text NOT NULL REFERENCES households(id), name text NOT NULL, UNIQUE(household_id,id));
CREATE TABLE catalog_nodes (
 id text PRIMARY KEY, household_id text NOT NULL REFERENCES households(id), parent_id text, kind text NOT NULL CHECK(kind IN ('GROUP','SKU')), name text NOT NULL CHECK(length(trim(name))>0), revision integer NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(household_id,id), FOREIGN KEY(household_id,parent_id) REFERENCES catalog_nodes(household_id,id), CHECK(parent_id IS DISTINCT FROM id)
);
CREATE INDEX catalog_parent ON catalog_nodes(household_id,parent_id);
CREATE TABLE items (
 id uuid PRIMARY KEY, household_id text NOT NULL REFERENCES households(id), catalog_node_id text NOT NULL, parent_id uuid, display_name text, revision integer NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(household_id,id), FOREIGN KEY(household_id,catalog_node_id) REFERENCES catalog_nodes(household_id,id), FOREIGN KEY(household_id,parent_id) REFERENCES items(household_id,id), CHECK(parent_id IS DISTINCT FROM id)
);
CREATE INDEX item_parent ON items(household_id,parent_id);
CREATE INDEX item_catalog ON items(household_id,catalog_node_id);
CREATE TABLE attribute_templates (household_id text NOT NULL REFERENCES households(id), id text NOT NULL, version integer NOT NULL CHECK(version>0), target_kind text NOT NULL CHECK(target_kind IN ('ITEM','CATALOG_NODE')), definition jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(household_id,id,version));
CREATE TABLE attribute_sets (
 id uuid PRIMARY KEY, household_id text NOT NULL REFERENCES households(id), catalog_node_id text, item_id uuid, template_id text NOT NULL, template_version integer NOT NULL,
 "values" jsonb NOT NULL CHECK(jsonb_typeof("values")='object' AND "values" <> '{}'::jsonb), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(catalog_node_id,item_id)=1), FOREIGN KEY(household_id,catalog_node_id) REFERENCES catalog_nodes(household_id,id), FOREIGN KEY(household_id,item_id) REFERENCES items(household_id,id), FOREIGN KEY(household_id,template_id,template_version) REFERENCES attribute_templates(household_id,id,version)
);
CREATE UNIQUE INDEX attribute_catalog_unique ON attribute_sets(household_id,catalog_node_id,template_id) WHERE catalog_node_id IS NOT NULL;
CREATE UNIQUE INDEX attribute_item_unique ON attribute_sets(household_id,item_id,template_id) WHERE item_id IS NOT NULL;
CREATE TABLE barcode_index (household_id text NOT NULL, barcode text NOT NULL, catalog_node_id text NOT NULL, PRIMARY KEY(household_id,barcode), FOREIGN KEY(household_id,catalog_node_id) REFERENCES catalog_nodes(household_id,id));
CREATE TABLE notes (id uuid PRIMARY KEY, household_id text NOT NULL, item_id uuid NOT NULL, title text, body text NOT NULL, body_format text NOT NULL DEFAULT 'Markdown' CHECK(body_format='Markdown'), created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(household_id,item_id) REFERENCES items(household_id,id), FOREIGN KEY(household_id,created_by) REFERENCES actors(household_id,id));
CREATE INDEX note_item ON notes(household_id,item_id);
CREATE TABLE events (id uuid PRIMARY KEY, household_id text NOT NULL REFERENCES households(id), target_kind text NOT NULL CHECK(target_kind IN ('ITEM','CATALOG_NODE')), target_id text NOT NULL, operation_id uuid NOT NULL, event_type text NOT NULL, reason text, before_revision integer NOT NULL, after_revision integer NOT NULL, changes jsonb NOT NULL, actor_id text NOT NULL, source text NOT NULL, occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(household_id,actor_id) REFERENCES actors(household_id,id));
CREATE INDEX event_target ON events(household_id,target_kind,target_id,recorded_at,id);
CREATE INDEX event_operation ON events(household_id,operation_id);
CREATE TABLE operations (household_id text NOT NULL, actor_id text NOT NULL, idempotency_key text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(household_id,actor_id,idempotency_key), FOREIGN KEY(household_id,actor_id) REFERENCES actors(household_id,id));
CREATE TABLE installations (slot text PRIMARY KEY, household_id text NOT NULL REFERENCES households(id), actor_id text NOT NULL, container_catalog_id text NOT NULL, FOREIGN KEY(household_id,actor_id) REFERENCES actors(household_id,id), FOREIGN KEY(household_id,container_catalog_id) REFERENCES catalog_nodes(household_id,id));
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only relation'; END $$;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_templates BEFORE UPDATE OR DELETE ON attribute_templates FOR EACH ROW EXECUTE FUNCTION reject_mutation();
