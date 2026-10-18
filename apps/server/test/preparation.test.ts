import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { migrate } from '@flume/database';
import { createCommandService,sha256 } from '../src/index.ts';
import { ownedPostgres } from '../../../packages/database/test/owned-postgres.ts';
const actor={id:'11111111-1111-4111-8111-111111111111',kind:'operator' as const,projectIds:'*' as const};
const cmd=(type:string,data:object={})=>({type,commandId:randomUUID(),...data});
test('review refuses a provider envelope for a different model',async()=>{
 const db=await ownedPostgres();
 try{
  await migrate(db.pool);const s=createCommandService({pool:db.pool,workerAvailable:true,provider:{async capabilities(){return []},async prepare(){return {envelope:{provider:'fixture',modelId:'silent-fallback',body:'{}',bodySha256:sha256('{}')},estimatedCostUsd:null,blockers:[]}}}});
  const projectId=(await s.command(actor,cmd('project.create',{name:'No fallback',brief:''}))).projectId;
  const shotId=(await s.command(actor,cmd('shot.create',{projectId,title:'Shot',prompt:'Original'}))).resourceId!;
  await assert.rejects(s.command(actor,cmd('generation.prepare',{projectId,shotId,expectedRevision:1})),{code:'PREPARATION_INTEGRITY'});
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.reviews')).rows[0].n,0);
 }finally{await db.close();}
});

test('catalog failure does not break editing; slow compilation holds no transaction and rejects a concurrent edit',async()=>{
 const db=await ownedPostgres();let release!:()=>void,pending:Promise<any>|undefined;
 try{
  await migrate(db.pool);let enter!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
  const provider={async capabilities():Promise<any[]>{throw Error('offline catalog')},async prepare(i:any){enter();await gate;const body=JSON.stringify(i.shot);return {envelope:{provider:'fixture',modelId:i.shot.controls.modelId,body,bodySha256:sha256(body)},estimatedCostUsd:null,blockers:[]};}};
  const s=createCommandService({pool:db.pool,provider,workerAvailable:true});
  const projectId=(await s.command(actor,cmd('project.create',{name:'Offline edit',brief:''}))).projectId;
  const shotId=(await s.command(actor,cmd('shot.create',{projectId,title:'Shot',prompt:'Original'}))).resourceId!;
  await assert.doesNotReject(s.getWorkspace(actor,projectId),'catalog outages must not disable project reads');
  pending=s.command(actor,cmd('generation.prepare',{projectId,shotId,expectedRevision:1}));
  await entered;
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
  await s.command(actor,cmd('shot.update',{projectId,shotId,expectedRevision:1,patch:{prompt:'New revision'}}));
  const rejected=assert.rejects(pending,{code:'REVISION_CONFLICT'});release();await rejected;
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.reviews')).rows[0].n,0);
 }finally{release?.();await pending?.catch(()=>{});await db.close();}
});
