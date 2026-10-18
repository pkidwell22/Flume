import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm,readFile,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as database from '@flume/database';
import { createCommandService } from '../src/index.ts';
const actor={id:'11111111-1111-4111-8111-111111111111',kind:'operator' as const,projectIds:'*' as const};
test('normal local-store shutdown retains PostgreSQL data and restart reads the same project',async()=>{
 assert.equal(typeof (database as any).openLocalStore,'function','persistent local-store launcher exists');
 const root=await mkdtemp(path.join(tmpdir(),'fl-persist-'));let store:any;
 try{
  store=await (database as any).openLocalStore({root,pgBin:process.env.PG_BIN});
  const before=JSON.parse(await readFile(path.join(root,'owner.json'),'utf8'));
  const receipt=await createCommandService({pool:store.pool}).command(actor,{type:'project.create',commandId:randomUUID(),name:'Survives restart',brief:''});
  await assert.rejects((database as any).openLocalStore({root,pgBin:process.env.PG_BIN}),/STORE_IN_USE/);
  const lock=await readFile(path.join(root,'runtime.lock'),'utf8');assert.ok(lock);
  const pid=Number((await readFile(path.join(root,'postgres','postmaster.pid'),'utf8')).split('\n')[0]);
  await store.close();store=undefined;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.ok(await stat(path.join(root,'postgres','PG_VERSION')));
  store=await (database as any).openLocalStore({root,pgBin:process.env.PG_BIN});
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'owner.json'),'utf8')),before);
  const projects=await createCommandService({pool:store.pool}).listProjects(actor);assert.equal(projects[0].id,receipt.projectId);
 }finally{await store?.close();await rm(root,{recursive:true,force:true});}
});
