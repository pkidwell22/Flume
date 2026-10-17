import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import pg from 'pg';
import { createOwnedCluster } from '../../01-approved-attempt/scripts/disposable-postgres.mjs';
import { openExperiment } from '../../01-approved-attempt/dist/src/database.js';
export async function setup(t: {after: (fn:()=>Promise<void>)=>void}) {
  const cleanup:(()=>Promise<void>)[]=[];
  t.after(async()=>{const errors=[]; for(const close of cleanup.reverse()) {try {await close();} catch(e){errors.push(e);}} assert.deepEqual(errors,[]);});
  const cluster = await createOwnedCluster();
  let pgPid:number|undefined;
  cleanup.push(async () => {
    await cluster.cleanup();
    if(pgPid) assert.throws(()=>process.kill(pgPid!,0),{code:'ESRCH'});
    await assert.rejects(lstat(cluster.root), {code:'ENOENT'});
  });
  pgPid=Number((await readFile(`${cluster.dataDirectory}/postmaster.pid`,'utf8')).split('\n')[0]);
  assert(Number.isSafeInteger(pgPid)&&pgPid>1);
  Object.assign(process.env, {SPIKE_DATABASE:cluster.database, SPIKE_DATA_DIRECTORY:cluster.dataDirectory, SPIKE_SOCKET:cluster.socketDirectory});
  const e = await openExperiment(); cleanup.push(()=>e.close());
  const catalog = JSON.parse(await readFile('output/catalog.json','utf8'));
  const imported = await import('../service.ts').catch(() => null);
  assert(imported?.createService, 'shared command service is missing');
  const service = await imported.createService(e, catalog, cluster.root);
  async function fresh(sql: string, args: any[] = []) {
    const c = new pg.Client(e.config);
    try {await c.connect(); return (await c.query(sql,args)).rows;} finally {await c.end();}
  }
  return {cluster,e,catalog,service,fresh,cleanup};
}
