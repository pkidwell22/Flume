import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { migrate,transaction } from '../src/index.ts';
import { ownedPostgres } from './owned-postgres.ts';
test('additive migrations retain populated project data and fail closed on altered or unknown ledger entries',async()=>{
 const db=await ownedPostgres();
 try{
  const first=await readFile(new URL('../migrations/001_projects.sql',import.meta.url),'utf8'),sum=createHash('sha256').update(first).digest('hex'),id=randomUUID();
  await transaction(db.pool,async c=>{
   await c.query('CREATE SCHEMA flume; CREATE TABLE flume.migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
   await c.query(first);await c.query('INSERT INTO flume.migrations (name,sha256) VALUES ($1,$2)',['001_projects.sql',sum]);
   await c.query('INSERT INTO flume.projects (id,name,brief) VALUES ($1,$2,$3)',[id,'Before upgrade','Original']);
  });
  await migrate(db.pool);await migrate(db.pool);
  assert.equal((await db.pool.query('SELECT name FROM flume.projects WHERE id=$1',[id])).rows[0].name,'Before upgrade');
  assert.equal((await db.pool.query('SELECT sha256 FROM flume.migrations WHERE name=$1',['001_projects.sql'])).rows[0].sha256,sum);
  await db.pool.query("UPDATE flume.migrations SET sha256='tampered' WHERE name='001_projects.sql'");await assert.rejects(migrate(db.pool),/MIGRATION_LEDGER_MISMATCH/);
  await db.pool.query('UPDATE flume.migrations SET sha256=$1 WHERE name=$2',[sum,'001_projects.sql']);
  await db.pool.query("INSERT INTO flume.migrations (name,sha256) VALUES ('999_unknown.sql','unknown')");await assert.rejects(migrate(db.pool),/MIGRATION_LEDGER_MISMATCH/);
 }finally{await db.close();}
});
