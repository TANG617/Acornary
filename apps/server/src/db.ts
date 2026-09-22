import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export type Client = pg.PoolClient;
// SQL remains explicit; every $n value becomes a bound Drizzle parameter.
export async function query<T = any>(
  client: pg.Pool | Client,
  text: string,
  values: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const chunks = text.split(/\$(\d+)/);
  const statement = sql.empty();
  chunks.forEach((chunk, i) =>
    statement.append(i % 2 ? sql`${values[Number(chunk) - 1]}` : sql.raw(chunk)),
  );
  return (await drizzle(client).execute(statement)) as any;
}
export async function transaction<T>(fn: (client: Client) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
