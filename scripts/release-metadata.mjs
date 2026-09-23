import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const [version, commit] = process.argv.slice(2);
if (
  !/^(?:v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|build-[0-9a-f]{12})$/.test(version ?? '') ||
  !/^[0-9a-f]{40}$/.test(commit ?? '')
)
  throw new Error('Invalid release identity');
const migrations = Object.fromEntries(
  readdirSync('migrations')
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => [
      n,
      createHash('sha256')
        .update(readFileSync(`migrations/${n}`))
        .digest('hex'),
    ]),
);
writeFileSync('release.json', JSON.stringify({ version, commit, migrations }, null, 2) + '\n');
