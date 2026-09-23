import { readFileSync } from 'node:fs';
import { pool, query } from './db.js';
type Release = { version: string; commit: string; migrations: Record<string, string> };
function load(): Release {
  try {
    const value = JSON.parse(readFileSync('release.json', 'utf8'));
    if (
      typeof value.version !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.commit) ||
      !value.migrations ||
      !Object.keys(value.migrations).length
    )
      throw new Error('Invalid release metadata');
    return value;
  } catch (e: any) {
    if (e.code === 'ENOENT') return { version: 'development', commit: 'unknown', migrations: {} };
    throw e;
  }
}
export const release = load();
export async function verifyReleaseMigrations() {
  if (!Object.keys(release.migrations).length) return;
  const applied = new Set(
    (await query(pool, 'SELECT name FROM migrations')).rows.map((r) => r.name),
  );
  if (Object.keys(release.migrations).some((name) => !applied.has(name)))
    throw new Error('Database does not contain all migrations required by this release');
}
