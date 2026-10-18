import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '@flume/database';
import { createCommandService } from '../src/index.ts';
import { ownedPostgres } from '../../../packages/database/test/owned-postgres.ts';
const actor={id:'11111111-1111-4111-8111-111111111111',kind:'operator' as const,projectIds:'*' as const};
const cmd=(type:string,rest:object={})=>({type,commandId:randomUUID(),...rest});

test('shots preserve draft intent, null/absent bindings, and concurrent revision guards',async()=>{
 const db=await ownedPostgres();
 try {
  await migrate(db.pool); const s=createCommandService({pool:db.pool});
  const projectId=(await s.command(actor,cmd('project.create',{name:'Edit',brief:''}))).projectId;
  const created=await s.command(actor,cmd('shot.create',{projectId,title:'One',prompt:'Literal prompt  '}));
  const shotId=created.resourceId!;
  const id=randomUUID();
  const update={type:'shot.update',commandId:id,projectId,shotId,expectedRevision:1,patch:{controls:{seed:0,generateAudio:false,durationSeconds:99},bindings:{lastFrameAssetId:null}}};
  const r=await s.command(actor,update); assert.equal(r.revision,2);
  const pool2=new pg.Pool(db.config);
  try {
   const other=createCommandService({pool:pool2});
   const attempts=await Promise.allSettled([s,other].map((store,i)=>store.command(actor,cmd('shot.update',{projectId,shotId,expectedRevision:2,patch:{title:`Race ${i}`}}))));
   assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
   const failed=attempts.find(a=>a.status==='rejected') as PromiseRejectedResult;
   assert.equal(failed.reason.code,'REVISION_CONFLICT');
   assert.deepEqual(await other.command(actor,update),r,'receipt before current revision guard');
  }finally{await pool2.end();}
  const w=await s.getWorkspace(actor,projectId); const shot=w.shots[0];
  assert.equal(shot.revision,3); assert.equal(shot.prompt,'Literal prompt  ');
  assert.equal(shot.controls.seed,0); assert.equal(shot.controls.generateAudio,false); assert.equal(shot.controls.durationSeconds,99);
  assert.equal(shot.bindings.firstFrameAssetId,null); assert.equal(shot.bindings.lastFrameAssetId,null);
  await assert.rejects(s.command(actor,cmd('shot.update',{projectId,shotId,expectedRevision:3,patch:{bindings:{firstFrameAssetId:randomUUID()}}})),{code:'ASSET_SCOPE'});
  await assert.rejects(s.command(actor,cmd('shot.create',{projectId,title:'x',prompt:'',canApprove:true})));
  assert.equal((await s.getWorkspace(actor)).project,null);
 }finally{await db.close();}
});
