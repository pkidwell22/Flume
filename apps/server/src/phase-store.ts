import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '@flume/database';
import { resumeAttempt, type AttemptState, type WorkerStore, type WorkerTransaction, type PhaseQueue } from '@flume/worker';
import { z } from 'zod';
import { hash, sha256, ServiceError, uuid } from './contracts.ts';
import { verifyReview } from './generation.ts';
import { insertAsset, ownedAssetSchema } from './assets.ts';
import { durableOutboxQueue, type TransactionalQueuePort } from './ports.ts';

const requestSchema=z.object({provider:z.string(),modelId:z.string(),scope:z.string(),body:z.string(),bodySha256:z.string()}).strict();
const receiptSchema=z.object({provider:z.string(),scope:z.string(),modelId:z.string(),providerJobId:z.string().min(1).max(512)}).strict();
const checkpointSchema=z.object({
 id:uuid,projectId:uuid,shotId:uuid,shotRevision:z.number().int(),request:requestSchema,
 version:z.number().int().nonnegative(),owner:uuid.nullable(),epoch:z.number().int().nonnegative(),
 phase:z.enum(['submit','poll','retrieve','import','hold','done']),status:z.enum(['queued','running','retrieving','ready','blocked','failed','acceptance_unknown']),
 recoverPhase:z.enum(['submit','poll','retrieve','import']).nullable(),
 dispatch:z.object({key:z.string(),request:requestSchema}).strict().nullable(),receipt:receiptSchema.nullable(),
 remoteState:z.enum(['not_dispatched','unknown','running','succeeded','failed']),
 outputs:z.array(z.object({outputId:z.string(),url:z.string(),sha256:z.string().optional()}).strict()),
 imports:z.record(z.object({takeId:uuid,assetId:uuid}).strict()),polls:z.number().int(),
 issue:z.object({code:z.string(),message:z.string()}).strict().nullable(),
}).strict();

/** Runtime store, not a fixture store. No media or network I/O in its transactions. */
export function createPhaseStore(pool:Pool) {
 function bind(c:PoolClient):WorkerTransaction {
  return {
   executeSql: (text,values)=>c.query(text,values),
   async loadAttempt(id){
    const row=(await c.query('SELECT state FROM flume.worker_checkpoints WHERE attempt_id=$1 FOR UPDATE',[id])).rows[0];
    return row?checkpointSchema.parse(row.state):null;
   },
   async saveAttempt(raw,expectedVersion){
    const s=checkpointSchema.parse(raw);
    const result=await c.query('UPDATE flume.worker_checkpoints SET version=$3,state=$4 WHERE attempt_id=$1 AND version=$2',[s.id,expectedVersion,s.version,s]);
    if(result.rowCount!==1)throw new Error('CHECKPOINT_CONFLICT');
    await c.query(`UPDATE flume.attempts SET status=$2,provider_job_id=$3,provider_receipt=$4,error_code=$5,message=$6,dispatch_state=$7,owner_id=$8,fence=$9 WHERE id=$1`,
     [s.id,s.status,s.receipt?.providerJobId??null,s.receipt,s.issue?.code??null,s.issue?.message??null,s.receipt?'accepted':s.dispatch?'intent':'not_started',s.owner,s.epoch]);
   },
   async authorizeDispatch(s){
    const deny=()=>({allowed:false as const,issue:{code:'STALE_AUTHORITY',message:'The reviewed shot or approval changed before dispatch.'}});
    const a=(await c.query('SELECT * FROM flume.attempts WHERE id=$1',[s.id])).rows[0];
    if(!a)return deny();
    const review=(await c.query('SELECT * FROM flume.reviews WHERE id=$1',[a.review_id])).rows[0];
    verifyReview(review);
    const shot=(await c.query('SELECT revision FROM flume.shots WHERE id=$1 FOR UPDATE',[s.shotId])).rows[0];
    await c.query('SELECT review_id FROM flume.approvals WHERE review_id=$1 FOR UPDATE',[a.review_id]);
    // Fresh statement AFTER potentially blocking locks: transaction-start time is insufficient.
    const valid=(await c.query(`SELECT 1 FROM flume.approvals ap JOIN flume.reservations r ON r.review_id=ap.review_id
     WHERE ap.review_id=$1 AND r.attempt_id=$2 AND NOT ap.revoked AND ap.expires_at>clock_timestamp()
     AND ap.reserved_count>=1 AND r.amount_usd IS NOT DISTINCT FROM $3::numeric`,[a.review_id,s.id,review.estimated_cost_usd])).rowCount;
    if(!valid||shot.revision!==s.shotRevision||a.shot_revision!==s.shotRevision||a.project_id!==s.projectId||a.shot_id!==s.shotId||review.consumed_attempt_id!==s.id||review.blockers.length||!review.envelope||
     s.request.body!==review.envelope.body||s.request.bodySha256!==review.envelope.bodySha256||s.request.modelId!==review.envelope.modelId||s.request.provider!==review.envelope.provider||sha256(s.request.body)!==s.request.bodySha256)return deny();
    return {allowed:true};
   },
   async receipts(id){return (await c.query('SELECT receipt FROM flume.worker_receipts WHERE attempt_id=$1 ORDER BY observed_at,identity_hash',[id])).rows.map(r=>receiptSchema.parse(r.receipt));},
   async publishTake(s,output,owned){
    if(!s.receipt||s.phase!=='import'||s.remoteState!=='succeeded')throw new Error('PUBLICATION_STATE');
    // Verified by media adapter outside SQL, then fenced by coordinator queue + owner locks.
    const a=ownedAssetSchema.parse({id:owned.assetId,projectId:s.projectId,filename:owned.filename,kind:owned.kind,origin:owned.origin,
     sha256:owned.sha256,storageKey:owned.storageKey,mimeType:owned.mimeType,byteSize:owned.byteLength,width:owned.width,height:owned.height,
     ...(owned.durationSeconds===undefined?{}:{durationSeconds:owned.durationSeconds}),provenance:owned.provenance});
    if(a.kind!=='video'||!['generated','sample'].includes(a.origin)||a.storageKey!==a.id)throw new Error('PUBLICATION_ASSET');
    const identity=hash([s.receipt.provider,s.receipt.scope,s.receipt.providerJobId,output.outputId]);
    const previous=(await c.query('SELECT t.id,t.asset_id,a.sha256,a.provenance FROM flume.takes t JOIN flume.assets a ON a.id=t.asset_id WHERE t.attempt_id=$1 AND t.remote_identity=$2',[s.id,identity])).rows[0];
    if(previous){if(previous.asset_id!==a.id||previous.sha256!==a.sha256||hash(previous.provenance)!==hash(a.provenance??null))throw new Error('PUBLICATION_CONFLICT');return {takeId:previous.id,assetId:a.id};}
    await insertAsset(c,a);
    const takeId=randomUUID();
    await c.query('INSERT INTO flume.takes (id,project_id,shot_id,attempt_id,asset_id,remote_identity) VALUES ($1,$2,$3,$4,$5,$6)',[takeId,s.projectId,s.shotId,s.id,a.id,identity]);
    return {takeId,assetId:a.id};
   },
  };
 }
 const store:WorkerStore={
  transaction:action=>transaction(pool,c=>action(bind(c))),
  async observeReceipt(id,intent,raw){
   const receipt=receiptSchema.parse(raw);
   await transaction(pool,async c=>{
    const s=await bind(c).loadAttempt(id);
    if(!s?.dispatch||hash(s.dispatch)!==hash(intent)||receipt.provider!==s.request.provider||receipt.scope!==s.request.scope)throw new Error('RECEIPT_IDENTITY');
    await c.query('INSERT INTO flume.worker_receipts (attempt_id,identity_hash,receipt) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[id,hash(receipt),receipt]);
   });
  },
 };
 return {store,bind};
}

export function createDispatchQueue(pool:Pool,queue:PhaseQueue,scope:string):TransactionalQueuePort {
 const {bind}=createPhaseStore(pool);
 return {async enqueue(c,job){
  const id=await durableOutboxQueue.enqueue(c,job);if(id!==job.id)return id;
  if(job.kind==='export')return id; // Frozen-export executor owns this durable outbox phase.
  let scheduled:string|null;
  if(job.kind==='generation'){
   const row=(await c.query('SELECT a.*,r.envelope FROM flume.attempts a JOIN flume.reviews r ON r.id=a.review_id WHERE a.id=$1',[job.resourceId])).rows[0];
   if(!row?.envelope)throw new Error('REQUEST_MISSING');
   const s:AttemptState={id:row.id,projectId:row.project_id,shotId:row.shot_id,shotRevision:row.shot_revision,request:{...row.envelope,scope},
    version:0,owner:null,epoch:0,phase:'submit',status:'queued',recoverPhase:null,dispatch:null,receipt:null,remoteState:'not_dispatched',outputs:[],imports:{},polls:0,issue:null};
   checkpointSchema.parse(s);
   await c.query('INSERT INTO flume.worker_checkpoints (attempt_id,version,state) VALUES ($1,0,$2)',[s.id,s]);
   scheduled=await queue.enqueue(bind(c),s.id);
  }else{
   scheduled=await resumeAttempt(bind(c),queue,job.resourceId);
   if(!scheduled)throw new ServiceError('RESUME_BLOCKED','This attempt cannot be resumed. No new submission was made.');
  }
  // Acknowledge the OUTBOX dispatch only after pg-boss really inserted its job in THIS transaction.
  await c.query("UPDATE flume.outbox SET state='done',scheduled_job_id=$2 WHERE id=$1",[id,scheduled]);
  return id;
 }};
}
