// Generate once against an empty, disposable database; never apply through the
// auth library at application startup. The resulting SQL is reviewed and versioned.
import { getMigrations } from 'better-auth/db/migration';
import { writeFile } from 'node:fs/promises';
import { createAuth } from '../apps/server/src/auth.js';
import { pool } from '../apps/server/src/db.js';
const database = new URL(process.env.DATABASE_URL!).pathname;
if (!database.endsWith('_test')) throw new Error('An isolated _test database is required.');
const auth = createAuth({
  mode: 'cloud',
  origin: 'https://auth.example.test',
  resource: 'https://auth.example.test/mcp',
  trustedProxy: '172.30.78.10',
  secret: 'migration-schema-only-not-a-deployment-secret',
});
const generated = await getMigrations(auth.options);
const sql = await generated.compileMigrations();
await writeFile(
  'migrations/004_cloud_auth.sql',
  `-- Better Auth 1.7.5 generated schema. Never exposed by the inspector.\n${sql}\n
CREATE TABLE auth_owners (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES households(id),
  actor_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  owner_slot text NOT NULL DEFAULT 'owner' UNIQUE CHECK(owner_slot='owner'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,actor_id),
  FOREIGN KEY(household_id,actor_id) REFERENCES actors(household_id,id)
);\n`,
  { flag: 'wx' },
);
await pool.end();
