-- The migration runner supplies one transaction and its migration lock.
ALTER TABLE items ADD COLUMN attributes jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(attributes) = 'array');
ALTER TABLE catalog_nodes ADD COLUMN attributes jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(attributes) = 'array');

UPDATE items o SET attributes = (
  SELECT jsonb_agg(jsonb_build_object('template_id',a.template_id,
    'template_version',a.template_version,'values',a."values",
    'created_at',a.created_at,'updated_at',a.updated_at) ORDER BY a.template_id)
  FROM attribute_sets a WHERE a.household_id=o.household_id AND a.item_id=o.id
) WHERE EXISTS (SELECT 1 FROM attribute_sets a WHERE a.household_id=o.household_id AND a.item_id=o.id);
UPDATE catalog_nodes o SET attributes = (
  SELECT jsonb_agg(jsonb_build_object('template_id',a.template_id,
    'template_version',a.template_version,'values',a."values",
    'created_at',a.created_at,'updated_at',a.updated_at) ORDER BY a.template_id)
  FROM attribute_sets a WHERE a.household_id=o.household_id AND a.catalog_node_id=o.id
) WHERE EXISTS (SELECT 1 FROM attribute_sets a WHERE a.household_id=o.household_id AND a.catalog_node_id=o.id);

DO $$
BEGIN
  IF (SELECT count(*) FROM attribute_sets) <>
     (SELECT coalesce(sum(jsonb_array_length(attributes)),0) FROM
       (SELECT attributes FROM items UNION ALL SELECT attributes FROM catalog_nodes) o)
  THEN RAISE EXCEPTION 'Embedded binding count mismatch'; END IF;
  IF EXISTS (
    SELECT 1 FROM attribute_sets a LEFT JOIN (
      SELECT household_id,id,'ITEM' AS kind,attributes FROM items UNION ALL
      SELECT household_id,id,'CATALOG_NODE',attributes FROM catalog_nodes
    ) o ON o.household_id=a.household_id AND o.id=coalesce(a.item_id,a.catalog_node_id)
      AND o.kind=CASE WHEN a.item_id IS NOT NULL THEN 'ITEM' ELSE 'CATALOG_NODE' END
    WHERE o.id IS NULL OR NOT o.attributes @> jsonb_build_array(jsonb_build_object(
      'template_id',a.template_id,'template_version',a.template_version,'values',a."values",
      'created_at',a.created_at,'updated_at',a.updated_at))
  ) THEN RAISE EXCEPTION 'Embedded binding content mismatch'; END IF;
END $$;
DROP TABLE attribute_sets;
