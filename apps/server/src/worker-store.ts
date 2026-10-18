import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { transaction } from '@flume/database';
import { z } from 'zod';
import { uuid,ServiceError } from './contracts.ts';
import { verifyReview } from './generation.ts';
import { insertAsset,ownedAssetSchema } from './assets.ts';
import type { MediaPort,OwnedAsset } from './ports.ts';
export type AttemptLease={jobId:string;attemptId:string;ownerId:string;fence:number;jobFence:number};
const leaseSchema=z.strictObject({jobId:uuid,attemptId:uuid,ownerId:uuid,fence:z.number().int().positive(),jobFence:z.number().int().positive()});
const takeDto=(r:any)=>({id:r.id,projectId:r.project_id,shotId:r.shot_id,attemptId:r.attempt_id,assetId:r.asset_id,createdAt:r.created_at.toISOString()});
export function createWorkerStore({pool,media}:{pool:Pool;media:MediaPort}) {
 async function guarded(c:PoolClient,raw:AttemptLease,done=false){
  const lease=leaseSchema.parse(raw);
  // Queue activation first, then domain ownership. Never acknowledge a stale activation.
  const job=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM flume.outbox WHERE id=$1 FOR UPDATE',[lease.jobId])).rows[0];
  const a=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM flume.attempts WHERE id=$1 FOR UPDATE',[lease.attemptId])).rows[0];
  const live=(await c.query('SELECT (SELECT lease_expires_at>clock_timestamp() FROM flume.outbox WHERE id=$1) AS job_live,(SELECT lease_expires_at>clock_timestamp() FROM flume.attempts WHERE id=$2) AS attempt_live',[lease.jobId,lease.attemptId])).rows[0];
  if(!job||!a||job.resource_id!==a.id||job.owner_id!==lease.ownerId||a.owner_id!==lease.ownerId||job.fence!==lease.jobFence||a.fence!==lease.fence||(!(done&&job.state==='done'&&a.status==='ready')&&(!live.job_live||!live.attempt_live||job.state!=='running')))throw new ServiceError('STALE_WORKER','This worker no longer owns the activation.');
  return a;
 }
 async function claimAttempt(jobId:string,ownerId:string,leaseSeconds=60){
  uuid.parse(jobId);uuid.parse(ownerId);z.number().int().min(1).max(900).parse(leaseSeconds);
  return await transaction(pool,async c=>{
   const job=(await c.query("SELECT *,lease_expires_at>clock_timestamp() AS live FROM flume.outbox WHERE id=$1 AND kind IN ('generation','resume') FOR UPDATE",[jobId])).rows[0];
   if(!job||job.state==='done'||job.state==='failed'||(job.state==='running'&&job.live))return null;
   const a=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM flume.attempts WHERE id=$1 FOR UPDATE',[job.resource_id])).rows[0];
   if(!a||a.status==='ready'||a.live)return null;
   const unknown=a.dispatch_state==='intent'&&!a.provider_receipt;
   const status=unknown?'acceptance_unknown':(a.provider_receipt?'running':'queued');
   await c.query("UPDATE flume.outbox SET owner_id=$2,fence=fence+1,state='running',lease_expires_at=clock_timestamp()+$3*interval '1 second' WHERE id=$1",[job.id,ownerId,leaseSeconds]);
   await c.query("UPDATE flume.attempts SET owner_id=$2,fence=fence+1,status=$3,lease_expires_at=clock_timestamp()+$4*interval '1 second' WHERE id=$1",[a.id,ownerId,status,leaseSeconds]);
   const review=(await c.query('SELECT * FROM flume.reviews WHERE id=$1',[a.review_id])).rows[0];verifyReview(review);
   return {lease:{jobId:job.id,attemptId:a.id,ownerId:ownerId.toLowerCase(),fence:a.fence+1,jobFence:job.fence+1},status,dispatchState:a.dispatch_state,envelope:review.envelope,providerReceipt:a.provider_receipt};
  });
 }
 async function beginDispatch(lease:AttemptLease){
  return await transaction(pool,async c=>{
   const a=await guarded(c,lease);
   if(a.dispatch_state!=='not_started')return {allowed:false,code:a.provider_receipt?'ALREADY_ACCEPTED':'ACCEPTANCE_UNKNOWN'};
   const review=(await c.query('SELECT * FROM flume.reviews WHERE id=$1',[a.review_id])).rows[0];verifyReview(review);
   const shot=(await c.query('SELECT revision FROM flume.shots WHERE id=$1 FOR UPDATE',[a.shot_id])).rows[0];
   await c.query('SELECT review_id FROM flume.approvals WHERE review_id=$1 FOR UPDATE',[review.id]);
   const approval=(await c.query('SELECT 1 FROM flume.approvals WHERE review_id=$1 AND NOT revoked AND expires_at>clock_timestamp()',[review.id])).rowCount;
   await guarded(c,lease); // Authority locks may have outlived the worker lease.
   if(!approval||shot.revision!==a.shot_revision){
    await c.query("UPDATE flume.attempts SET status='blocked',error_code='STALE_AUTHORITY',message='The shot or approval changed before dispatch.' WHERE id=$1",[a.id]);
    await c.query("UPDATE flume.outbox SET state='done' WHERE id=$1",[lease.jobId]);
    return {allowed:false,code:'STALE_AUTHORITY'};
   }
   await c.query("UPDATE flume.attempts SET dispatch_state='intent',status='running' WHERE id=$1",[a.id]);
   return {allowed:true,envelope:review.envelope};
  });
 }
 async function recordAccepted(lease:AttemptLease,input:{providerJobId:string;receipt:Record<string,unknown>}){
  z.string().min(1).max(1000).parse(input.providerJobId);z.record(z.string(),z.unknown()).parse(input.receipt);
  await transaction(pool,async c=>{
   const a=await guarded(c,lease);
   if(a.dispatch_state!=='intent'||a.provider_receipt)throw new ServiceError('DISPATCH_STATE','Only the original unresolved dispatch may accept a receipt.');
   await c.query("UPDATE flume.attempts SET dispatch_state='accepted',provider_job_id=$2,provider_receipt=$3,status='running' WHERE id=$1",[a.id,input.providerJobId,input.receipt]);
  });
 }
 async function checkpoint(lease:AttemptLease,input:{status:'running'|'retrieving'|'blocked'|'failed'|'acceptance_unknown';errorCode?:string;message?:string}){
  const data=z.strictObject({status:z.enum(['running','retrieving','blocked','failed','acceptance_unknown']),errorCode:z.string().max(100).optional(),message:z.string().max(2000).optional()}).parse(input);
  await transaction(pool,async c=>{
   const a=await guarded(c,lease);
   if(data.status==='retrieving'&&!a.provider_receipt)throw new ServiceError('PROVIDER_RECEIPT_REQUIRED','Cannot retrieve without the exact accepted receipt.');
   await c.query('UPDATE flume.attempts SET status=$2,error_code=$3,message=$4 WHERE id=$1',[a.id,data.status,data.errorCode??null,data.message??null]);
  });
 }
 async function publishTake(lease:AttemptLease,input:{remoteIdentity:string;asset:OwnedAsset}){
  z.string().min(1).max(2000).parse(input.remoteIdentity);const asset=ownedAssetSchema.parse(input.asset);
  if(asset.kind!=='video'||asset.origin!=='generated')throw new ServiceError('OUTPUT_KIND','Generated take publication requires owned generated video.');
  await media.verifyOwned(asset); // Immutable owned bytes before availability, outside SQL.
  return await transaction(pool,async c=>{
   const a=await guarded(c,lease,true);
   if(asset.projectId.toLowerCase()!==a.project_id)throw new ServiceError('ASSET_SCOPE','Output project mismatch.');
   const previous=(await c.query('SELECT t.*,a.sha256 FROM flume.takes t JOIN flume.assets a ON a.id=t.asset_id WHERE t.attempt_id=$1 AND t.remote_identity=$2',[a.id,input.remoteIdentity])).rows[0];
   if(previous){if(previous.sha256!==asset.sha256)throw new ServiceError('OUTPUT_CONFLICT','Remote output bytes changed.');return takeDto(previous);}
   if(a.status!=='retrieving'||!a.provider_receipt)throw new ServiceError('ATTEMPT_STATE','The owned output is not ready for publication.');
   await insertAsset(c,asset);
   const take=(await c.query('INSERT INTO flume.takes (id,project_id,shot_id,attempt_id,asset_id,remote_identity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),a.project_id,a.shot_id,a.id,asset.id,input.remoteIdentity])).rows[0];
   await c.query("UPDATE flume.attempts SET status='ready',error_code=NULL,message=NULL WHERE id=$1",[a.id]);
   await c.query("UPDATE flume.outbox SET state='done' WHERE id=$1",[lease.jobId]);
   return takeDto(take);
  });
 }
 async function renew(lease:AttemptLease,leaseSeconds=60){
  z.number().int().min(1).max(900).parse(leaseSeconds);
  await transaction(pool,async c=>{await guarded(c,lease);await c.query("UPDATE flume.outbox SET lease_expires_at=clock_timestamp()+$2*interval '1 second' WHERE id=$1",[lease.jobId,leaseSeconds]);await c.query("UPDATE flume.attempts SET lease_expires_at=clock_timestamp()+$2*interval '1 second' WHERE id=$1",[lease.attemptId,leaseSeconds]);});
 }
 return {claimAttempt,beginDispatch,recordAccepted,checkpoint,publishTake,renew};
}
