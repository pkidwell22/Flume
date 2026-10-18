import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
export * from './schema.ts';
export { openLocalStore } from './local-store.ts';
export type { LocalStoreOptions } from './local-store.ts';

/** One checked-out connection for Drizzle, guarded commands, and SQL queue insertion.
 * Promoted receipt/transaction discipline from spikes/01-approved-attempt, not its lifecycle hooks.
 */
export async function transaction<T>(pool:Pool, action:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try { return await drizzle(client).transaction(async()=>await action(client)); }
  finally {client.release();}
}
export async function migrate(pool:Pool):Promise<void> {
  const directory=new URL('../migrations/',import.meta.url);
  const names=(await readdir(directory)).filter(n=>/^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
  const migrations=await Promise.all(names.map(async name=>{
    const text=await readFile(new URL(name,directory),'utf8');
    return {name,text,sha256:createHash('sha256').update(text).digest('hex')};
  }));
  await transaction(pool,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('flume-migrations-v1',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS flume');
    await client.query('CREATE TABLE IF NOT EXISTS flume.migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const applied=(await client.query('SELECT name,sha256 FROM flume.migrations ORDER BY name')).rows;
    for (const [i,row] of applied.entries()) {
      if(migrations[i]?.name!==row.name || migrations[i]?.sha256!==row.sha256) throw new Error('MIGRATION_LEDGER_MISMATCH');
    }
    for(const m of migrations.slice(applied.length)) {
      await client.query(m.text);
      await client.query('INSERT INTO flume.migrations (name,sha256) VALUES ($1,$2)',[m.name,m.sha256]);
    }
  });
}
