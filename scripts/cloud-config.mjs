// Run on the server. Creates private configuration, never writes credentials
// to stdout/arguments, and never replaces existing environment secrets.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
const environment = process.argv[2];
if (!['preacceptance', 'production'].includes(environment))
  throw new Error('Choose preacceptance or production.');
const directory = `/etc/acornary/${environment}`;
if (existsSync(`${directory}/app.env`))
  throw new Error('Configuration exists; refusing to rotate secrets implicitly.');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString('hex');
const migrationPassword = secret(),
  appPassword = secret();
const save = (name, text) =>
  writeFileSync(`${directory}/${name}`, text, { mode: 0o600, flag: 'wx' });
save(
  'postgres.env',
  `POSTGRES_USER=acornary_migrator\nPOSTGRES_DB=acornary\nPOSTGRES_PASSWORD=${migrationPassword}\n`,
);
save(
  'migration.env',
  `DATABASE_URL=postgres://acornary_migrator:${migrationPassword}@postgres:5432/acornary\n`,
);
save(
  'app.env',
  `DATABASE_URL=postgres://acornary_app:${appPassword}@postgres:5432/acornary\nBETTER_AUTH_SECRET=${secret()}\nACORNARY_ORIGIN=https://acornary.protium.top\nACORNARY_TRUSTED_PROXY=172.30.78.10\n`,
);
// A local, root-only input script, consumed on stdin by psql and then removed.
save('create-runtime-role.sql', `CREATE ROLE acornary_app LOGIN PASSWORD '${appPassword}';\n`);
console.log(`Private configuration created for ${environment}.`);
