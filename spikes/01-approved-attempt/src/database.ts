import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

export const queue = 'approved-generation-v1';
export async function openExperiment({ initialize = true }: { initialize?: boolean } = {}) {
  const database = process.env.SPIKE_DATABASE;
  const dataDirectory = process.env.SPIKE_DATA_DIRECTORY;
  const host = process.env.SPIKE_SOCKET;
  assert(database && /^attempt_[0-9a-f]{16}$/.test(database), 'use the disposable-DB runner');
  assert(dataDirectory && host && path.isAbsolute(host), 'use the disposable-DB runner');
  assert.equal(await realpath(dataDirectory), dataDirectory);
  const owner = JSON.parse(await readFile(path.join(dataDirectory, '../.owner'), 'utf8'));
  assert.equal(owner.dataDirectory, dataDirectory);
  assert(process.getuid, 'POSIX user identity is required');
  assert.equal(owner.uid, process.getuid());
  assert.equal(path.join(owner.root, 's'), host);
  const config: pg.PoolConfig = { database, host, port: 5432, user: 'spike_owner', ssl: false,
    max: 16, connectionTimeoutMillis: 5_000, options: '-c search_path=spike -c statement_timeout=10000 -c lock_timeout=5000' };
  const pool = new pg.Pool(config);
  const boss = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) },
    schema: 'pgboss', supervise: false, schedule: false, migrate: initialize, createSchema: initialize });
  const errors: Error[] = [];
  boss.on('error', error => errors.push(error));
  try {
    const { rows: [identity] } = await pool.query(`select current_database() as database,
      current_setting('data_directory') as directory, current_setting('listen_addresses') as listen,
      current_setting('unix_socket_directories') as socket`);
    assert.equal(identity.database, database);
    assert.equal(identity.directory, dataDirectory);
    assert.equal(identity.listen, '');
    assert.equal(identity.socket, host);
    // Both our DDL and pg-boss migrations follow the target identity check.
    if (initialize) {
      const schema = await readFile(new URL('../../schema.sql', import.meta.url), 'utf8');
      await drizzle(pool).transaction(async tx => { await tx.execute(sql.raw(schema)); });
    }
    await boss.start();
    if (initialize) await boss.createQueue(queue, { policy: 'standard', retryLimit: 0, expireInSeconds: 60,
      retentionSeconds: 3600, deleteAfterSeconds: 3600 });
    return { pool, boss, config, errors, async close() {
      try { await boss.stop({ graceful: true, timeout: 5000 }); }
      finally { await pool.end(); }
      assert.deepEqual(errors, [], 'pg-boss emitted an asynchronous error');
    } };
  } catch (error) {
    try { await boss.stop(); }
    finally { await pool.end(); }
    throw error;
  }
}
export type Experiment = Awaited<ReturnType<typeof openExperiment>>;
