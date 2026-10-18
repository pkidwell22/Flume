// Actual killable worker process; synthetic provider/media adapters only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { PgBossPhaseQueue, runDelivery } from '../dist/src/index.js';
import { makeStore } from './fixture-store.mjs';
const { origin, root, pause } = JSON.parse(process.argv[2]);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const config = JSON.parse(process.env.FLUME_WORKER_TEST_CONFIG);
const directory = process.env.FLUME_WORKER_TEST_DIRECTORY;
const marker = JSON.parse(await readFile(path.join(directory, '../.owner'), 'utf8'));
assert.equal(await realpath(directory), directory); assert.equal(marker.dataDirectory, directory); assert.equal(marker.uid, process.getuid());
assert.equal(await realpath(root), root); assert.equal(path.dirname(root), path.dirname(directory));
assert.equal(config.host, path.join(marker.root, 's')); assert.match(config.database, /^flume_worker_[a-f0-9]{16}$/);
const pool = new pg.Pool({ ...config, max: 4 });
const boss = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) }, schema: 'flume_queue', migrate: false, createSchema: false, supervise: false, schedule: false });
const checkpoint = async point => { if (point === pause) { process.send({ point }); await once(process, 'message'); } };
const json = async (url, signal, data) => (await fetch(origin + url, { signal, redirect: 'error', method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}) })).json();
try {
  const row = (await pool.query("SELECT current_database() AS db, current_setting('data_directory') AS dir")).rows[0];
  assert.equal(row.db, config.database); assert.equal(row.dir, directory);
  await boss.start();
  const provider = {
    async submit(intent, signal) { await checkpoint('intent'); const result = await json('/submit', signal, intent); await checkpoint('reply'); return result; },
    status: (receipt, signal) => json('/status/' + receipt.providerJobId, signal),
    outputs: (receipt, signal) => json('/outputs/' + receipt.providerJobId, signal),
  };
  const media = { async ownOutput(input, signal) {
    assert.equal(new URL(input.output.url).origin, origin); assert.match(input.importKey, /^[a-f0-9]{64}$/);
    const target = path.join(root, input.importKey + '.ppm'); let bytes;
    try { bytes = await readFile(target); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      bytes = Buffer.from(await (await fetch(input.output.url, { signal, redirect: 'error' })).arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), input.output.sha256);
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex'); assert.equal(sha256, input.output.sha256);
    await checkpoint('bytes');
    return { assetId: input.importKey, storageKey: path.basename(target), filename: 'synthetic-fixture.ppm', kind: 'image', sha256, byteLength: bytes.length, width: 2, height: 2 };
  } };
  const result = await runDelivery({ store: makeStore(pool), queue: new PgBossPhaseQueue(boss), provider, media }, { pollDelaySeconds: 0 });
  process.send?.({ result });
} finally { try { await boss.stop(); } finally { await pool.end(); process.disconnect?.(); } }
