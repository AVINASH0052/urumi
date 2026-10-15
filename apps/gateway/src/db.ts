import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { config } from './config.ts';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
// Idle clients get an 'error' event when Postgres restarts; unhandled, that kills the process.
// The pool discards the broken client and /readyz reports the outage until it's back.
pool.on('error', (e) => console.error(JSON.stringify({ msg: 'postgres connection lost', error: e.message })));

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

// Plain SQL files, applied once each, under an advisory lock so replicas can start together.
export async function migrate() {
  const dir = new URL('../migrations/', import.meta.url);
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(4201)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      await c.query(await readFile(new URL(f, dir), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log(JSON.stringify({ msg: 'migrated', file: f }));
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.query('SELECT pg_advisory_unlock(4201)').catch(() => {});
    c.release();
  }
}
