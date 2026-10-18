import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '@flume/database';
import { createCommandService,createWorkerStore,durableOutboxQueue,sha256 } from '../src/index.ts';
import { ownedPostgres } from '../../../packages/database/test/owned-postgres.ts';
const actor={id:'11111111-1111-4111-8111-111111111111',kind:'operator' as const,projectIds:'*' as const};
const cmd=(type:string,data:object={})=>({type,commandId:randomUUID(),...data});
const provider={async capabilities(){return []},async prepare(i:any){const body=JSON.stringify(i.shot);return {envelope:{provider:'fixture',modelId:i.shot.controls.modelId,body,bodySha256:sha256(body)},estimatedCostUsd:null,blockers:[]};}};
async function ready(s:ReturnType<typeof createCommandService>){
 const projectId=(await s.command(actor,cmd('project.create',{name:'Guards',brief:''}))).projectId;
 const shotId=(await s.command(actor,cmd('shot.create',{projectId,title:'Shot',prompt:'Original'}))).resourceId!;
 const reviewId=(await s.command(actor,cmd('generation.prepare',{projectId,shotId,expectedRevision:1}))).reviewId!;
 await s.command(actor,cmd('generation.approve',{projectId,reviewId,maxAttempts:1,maxCostUsd:null}));
 return {projectId,shotId,reviewId};
}
function deferred<T=void>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}

test('independent connections see no partial receipt/reservation/outbox before acceptance commit',async()=>{
 const db=await ownedPostgres();let pool2:pg.Pool|undefined;const release=deferred();let pending:Promise<any>|undefined;
 try{
  await migrate(db.pool);const reached=deferred<{pid:number;txid:string}>();
  const queue={async enqueue(c:pg.PoolClient,job:any){const id=await durableOutboxQueue.enqueue(c,job);const row=(await c.query('SELECT pg_backend_pid() AS pid,txid_current()::text AS txid')).rows[0];reached.resolve(row);await release.promise;return id;}};
  const s=createCommandService({pool:db.pool,provider,workerAvailable:true,queue}),r=await ready(s);
  pool2=new pg.Pool({...db.config,application_name:'flume-independent-test'});
  const other=createCommandService({pool:pool2,provider,workerAvailable:true});
  const submission=cmd('generation.submit',{projectId:r.projectId,reviewId:r.reviewId});
  pending=s.command(actor,submission);const identity=await reached.promise;
  const outside=(await pool2.query('SELECT pg_backend_pid() AS pid,txid_current()::text AS txid')).rows[0];assert.notEqual(outside.pid,identity.pid);assert.notEqual(outside.txid,identity.txid);
  for(const table of ['attempts','reservations','outbox'])assert.equal((await pool2.query(`SELECT count(*)::int n FROM flume.${table}`)).rows[0].n,0,table);
  assert.equal((await pool2.query('SELECT count(*)::int n FROM flume.command_receipts WHERE command_id=$1',[submission.commandId])).rows[0].n,0);
  const retry=other.command(actor,submission);
  let blocked=false;
  for(let i=0;i<100;i++){
   const rows=(await db.pool.query("SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name='flume-independent-test' AND state='active'")).rows;
   if(rows.some(r=>r.blockers.includes(identity.pid))){blocked=true;break;}await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(blocked,true,'exact replay actually waits on acceptance transaction');
  release.resolve();assert.deepEqual(await retry,await pending);
  for(const table of ['attempts','reservations','outbox'])assert.equal((await pool2.query(`SELECT count(*)::int n FROM flume.${table}`)).rows[0].n,1,table);
  const next=await ready(s);
  const races=await Promise.allSettled([s,other].map(store=>store.command(actor,cmd('generation.submit',{projectId:next.projectId,reviewId:next.reviewId}))));
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal((races.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'REVIEW_CONSUMED');
 }finally{release.resolve();await pending?.catch(()=>{});await pool2?.end();await db.close();}
});

test('actual queue insertion suppression and thrown enqueue both roll back all acceptance rows',async()=>{
 const db=await ownedPostgres();
 try{
  await migrate(db.pool);const s=createCommandService({pool:db.pool,provider,workerAvailable:true}),r=await ready(s);
  await db.pool.query("CREATE FUNCTION flume.suppress_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress BEFORE INSERT ON flume.outbox FOR EACH ROW EXECUTE FUNCTION flume.suppress_outbox()");
  await assert.rejects(s.command(actor,cmd('generation.submit',{projectId:r.projectId,reviewId:r.reviewId})),{code:'ENQUEUE_FAILED'});
  await db.pool.query('DROP TRIGGER suppress ON flume.outbox');
  const fault=createCommandService({pool:db.pool,provider,workerAvailable:true,queue:{async enqueue(c,job){await durableOutboxQueue.enqueue(c,job);throw new Error('injected queue failure');}}});
  await assert.rejects(fault.command(actor,cmd('generation.submit',{projectId:r.projectId,reviewId:r.reviewId})),/injected queue failure/);
  for(const table of ['attempts','reservations','outbox'])assert.equal((await db.pool.query(`SELECT count(*)::int n FROM flume.${table}`)).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT reserved_count FROM flume.approvals')).rows[0].reserved_count,0);
 }finally{await db.close();}
});

test('dispatch is fenced after lease turnover; ambiguous acceptance cannot resume into another POST',async()=>{
 const db=await ownedPostgres();
 try{
  await migrate(db.pool);const s=createCommandService({pool:db.pool,provider,workerAvailable:true}),r=await ready(s);
  const media={async importLocal(){throw Error('unused')},async verifyOwned(){},async readOwned(){return new Uint8Array()}};
  const worker=createWorkerStore({pool:db.pool,media});
  const attemptId=(await s.command(actor,cmd('generation.submit',{projectId:r.projectId,reviewId:r.reviewId}))).attemptId!;
  const old=await worker.claimAttempt(attemptId,randomUUID());assert.ok(old);
  assert.equal((await worker.beginDispatch(old.lease)).allowed,true);
  await db.pool.query("UPDATE flume.outbox SET lease_expires_at=clock_timestamp()-interval '1 second'; UPDATE flume.attempts SET lease_expires_at=clock_timestamp()-interval '1 second'");
  const fresh=await worker.claimAttempt(attemptId,randomUUID());assert.ok(fresh);assert.equal(fresh.status,'acceptance_unknown');
  assert.equal(typeof (worker as any).renew,'function','lease renewal exists');
  await (worker as any).renew(fresh.lease,120);
  await assert.rejects((worker as any).renew(old.lease,120),{code:'STALE_WORKER'});
  await assert.rejects(worker.recordAccepted(old.lease,{providerJobId:'late-receipt',receipt:{jobId:'late-receipt'}}),{code:'STALE_WORKER'});
  assert.equal((await worker.beginDispatch(fresh.lease)).allowed,false);
  await db.pool.query("UPDATE flume.attempts SET lease_expires_at=clock_timestamp()-interval '1 second'");
  await assert.rejects(s.command(actor,cmd('attempt.resume',{projectId:r.projectId,attemptId})),{code:'ACCEPTANCE_UNKNOWN'});
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.outbox')).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT provider_job_id FROM flume.attempts')).rows[0].provider_job_id,null);
  const next=await ready(s);
  const accepted=(await s.command(actor,cmd('generation.submit',{projectId:next.projectId,reviewId:next.reviewId}))).attemptId!;
  const claim=await worker.claimAttempt(accepted,randomUUID());assert.ok(claim);
  await s.command(actor,cmd('shot.update',{projectId:next.projectId,shotId:next.shotId,expectedRevision:1,patch:{prompt:'No longer authorized'}}));
  assert.deepEqual(await worker.beginDispatch(claim.lease),{allowed:false,code:'STALE_AUTHORITY'});
 }finally{await db.close();}
});

test('worker lease is rechecked after waiting on dispatch authority',async()=>{
 const db=await ownedPostgres();let holder:pg.PoolClient|undefined,pending:Promise<any>|undefined;
 try{
  await migrate(db.pool);const s=createCommandService({pool:db.pool,provider,workerAvailable:true}),r=await ready(s);
  const worker=createWorkerStore({pool:db.pool,media:{async importLocal(){throw Error('unused')},async verifyOwned(){},async readOwned(){return new Uint8Array()}}});
  const attemptId=(await s.command(actor,cmd('generation.submit',{projectId:r.projectId,reviewId:r.reviewId}))).attemptId!;
  const claim=await worker.claimAttempt(attemptId,randomUUID(),1);assert.ok(claim);
  holder=await db.pool.connect();await holder.query('BEGIN');await holder.query('SELECT review_id FROM flume.approvals WHERE review_id=$1 FOR UPDATE',[r.reviewId]);
  pending=worker.beginDispatch(claim.lease);const rejected=assert.rejects(pending,{code:'STALE_WORKER'});
  await new Promise(r=>setTimeout(r,1100));await holder.query('COMMIT');await rejected;
  assert.equal((await db.pool.query('SELECT dispatch_state FROM flume.attempts WHERE id=$1',[attemptId])).rows[0].dispatch_state,'not_started');
 }finally{await holder?.query('ROLLBACK');holder?.release();await pending?.catch(()=>{});await db.close();}
});

test('expired approval is checked at acceptance, never at transaction start',async()=>{
 const db=await ownedPostgres();let holder:pg.PoolClient|undefined,pending:Promise<any>|undefined;
 try{
  await migrate(db.pool);const s=createCommandService({pool:db.pool,provider,workerAvailable:true}),r=await ready(s);
  holder=await db.pool.connect();await holder.query('BEGIN');
  const blocker=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await holder.query('SELECT review_id FROM flume.approvals WHERE review_id=$1 FOR UPDATE',[r.reviewId]);
  pending=s.command(actor,cmd('generation.submit',{projectId:r.projectId,reviewId:r.reviewId}));
  // Attach rejection immediately; the assertion waits after the held lock is released.
  const rejected=assert.rejects(pending,{code:'APPROVAL_REQUIRED'});
  let waiting=false;for(let i=0;i<100;i++){if((await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[blocker])).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,5));}
  assert(waiting);await holder.query("UPDATE flume.approvals SET expires_at=clock_timestamp() WHERE review_id=$1",[r.reviewId]);await holder.query('COMMIT');await rejected;
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.attempts')).rows[0].n,0);
 }finally{await holder?.query('ROLLBACK');holder?.release();await pending?.catch(()=>{});await db.close();}
});
