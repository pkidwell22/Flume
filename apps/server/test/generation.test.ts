import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '@flume/database';
import { createCommandService,sha256 } from '../src/index.ts';
import { ownedPostgres } from '../../../packages/database/test/owned-postgres.ts';
const operator={id:'11111111-1111-4111-8111-111111111111',kind:'operator' as const,projectIds:'*' as const};
const agent={...operator,id:'22222222-2222-4222-8222-222222222222',kind:'agent' as const};
const cmd=(type:string,rest:object={})=>({type,commandId:randomUUID(),...rest});
const provider={async capabilities(){return []},async prepare(input:any){const body=JSON.stringify({prompt:input.shot.prompt,controls:input.shot.controls,bindings:input.shot.bindings});return {envelope:{provider:'local-test-only',modelId:input.shot.controls.modelId,body,bodySha256:sha256(body)},estimatedCostUsd:null,blockers:[]};}};

test('review approval is separate, submission consumes once, and receipt replay precedes later edits',async()=>{
 const db=await ownedPostgres();
 try{
  await migrate(db.pool);const s=createCommandService({pool:db.pool,provider,workerAvailable:true});
  const projectId=(await s.command(operator,cmd('project.create',{name:'Generation',brief:''}))).projectId;
  const shotId=(await s.command(operator,cmd('shot.create',{projectId,title:'One',prompt:'Exact reviewed text'}))).resourceId!;
  const prepared=await s.command(operator,cmd('generation.prepare',{projectId,shotId,expectedRevision:1}));
  const reviewId=prepared.reviewId!;
  await assert.rejects(s.command(agent,cmd('generation.approve',{projectId,reviewId,maxAttempts:1,maxCostUsd:null})),{code:'APPROVAL_FORBIDDEN'});
  await assert.rejects(s.command(agent,cmd('generation.submit',{projectId,reviewId})),{code:'APPROVAL_REQUIRED'});
  await assert.rejects(s.command(operator,cmd('generation.approve',{projectId,reviewId,maxAttempts:1,maxCostUsd:'1.00'})),{code:'COST_UNKNOWN'});
  const approval=cmd('generation.approve',{projectId,reviewId,maxAttempts:1,maxCostUsd:null});
  await s.command(operator,approval);
  const pool2=new pg.Pool(db.config);
  try{
   const other=createCommandService({pool:pool2,provider,workerAvailable:true});
   const submission=cmd('generation.submit',{projectId,reviewId});
   const results=await Promise.all([s.command(agent,submission),other.command(agent,submission)]);
   assert.deepEqual(results[0],results[1]);
   assert.equal((await pool2.query('SELECT count(*)::int AS n FROM flume.attempts')).rows[0].n,1);
   assert.equal((await pool2.query('SELECT count(*)::int AS n FROM flume.outbox')).rows[0].n,1);
   assert.equal((await pool2.query('SELECT reserved_count FROM flume.approvals')).rows[0].reserved_count,1);
   await assert.rejects(other.command(agent,cmd('generation.submit',{projectId,reviewId})),{code:'REVIEW_CONSUMED'});
   await s.command(operator,cmd('shot.update',{projectId,shotId,expectedRevision:1,patch:{prompt:'Later'}}));
   assert.deepEqual(await other.command(agent,submission),results[0]);
   await assert.rejects(other.command(agent,{...submission,reviewId:randomUUID()}),{code:'COMMAND_CONFLICT'});
   const w=await s.getWorkspace(operator,projectId);
   assert.equal(w.reviews[0].approved,false);assert.equal(w.attempts[0].status,'queued');
   assert(!JSON.stringify(w).includes('local-test-only'),'private provider envelope not returned');
   assert.equal(w.takes.length,0);
  }finally{await pool2.end();}
 }finally{await db.close();}
});

test('queue suppression rolls back receipt, review consumption and approval reservation',async()=>{
 const db=await ownedPostgres();
 try{
  await migrate(db.pool);const s=createCommandService({pool:db.pool,provider,workerAvailable:true,queue:{async enqueue(){return null}}});
  const projectId=(await s.command(operator,cmd('project.create',{name:'Rollback',brief:''}))).projectId;
  const shotId=(await s.command(operator,cmd('shot.create',{projectId,title:'One',prompt:'Test'}))).resourceId!;
  const reviewId=(await s.command(operator,cmd('generation.prepare',{projectId,shotId,expectedRevision:1}))).reviewId!;
  await s.command(operator,cmd('generation.approve',{projectId,reviewId,maxAttempts:1,maxCostUsd:null}));
  const submission=cmd('generation.submit',{projectId,reviewId});
  await assert.rejects(s.command(agent,submission),{code:'ENQUEUE_FAILED'});
  const independent=new pg.Pool(db.config);
  try{
   assert.equal((await independent.query('SELECT count(*)::int n FROM flume.attempts')).rows[0].n,0);
   assert.equal((await independent.query('SELECT count(*)::int n FROM flume.command_receipts WHERE command_id=$1',[submission.commandId])).rows[0].n,0);
   assert.equal((await independent.query('SELECT reserved_count FROM flume.approvals')).rows[0].reserved_count,0);
   assert.equal((await independent.query('SELECT consumed_attempt_id FROM flume.reviews')).rows[0].consumed_attempt_id,null);
  }finally{await independent.end();}
 }finally{await db.close();}
});
