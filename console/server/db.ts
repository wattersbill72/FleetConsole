import pg from 'pg';

export interface Queryable {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  }
  return pool;
}

/** Pool-backed executor. Every statement is parameterised; never build `text` from request input. */
export const db: Queryable = {
  query: (text, params) => getPool().query(text, params as any[]),
};

/** Run `fn` in a transaction. Anything it writes, including audit events, commits or fails together. */
export async function tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
