import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '@flume/database';
import { uuid,hash,ServiceError } from './contracts.ts';
import { ownedAsset,ownedAssetSchema,insertAsset } from './assets.ts';
import type { MediaPort,OwnedAsset } from './ports.ts';
export type ExportLease={jobId:string;exportId:string;ownerId:string;fence:number;jobFence:number};
export function createExportStore({pool,media}:{pool:Pool;media:MediaPort}) {
 async function guarded(c:PoolClient,lease:ExportLease) {
  z.strictObject({jobId:uuid,exportId:uuid,ownerId:uuid,fence:z.number().int().positive(),jobFence:z.number().int().positive()}).parse(lease);
  const job=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM flume.outbox WHERE id=$1 FOR UPDATE',[lease.jobId])).rows[0];
  const e=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM flume.exports WHERE id=$1 FOR UPDATE',[lease.exportId])).rows[0];
  // Both lock acquisitions may block past their earlier SELECT expressions.
  const live=(await c.query('SELECT (SELECT lease_expires_at>clock_timestamp() FROM flume.outbox WHERE id=$1) AS job_live,(SELECT lease_expires_at>clock_timestamp() FROM flume.exports WHERE id=$2) AS export_live',[lease.jobId,lease.exportId])).rows[0];
  if(!job||!e||job.resource_id!==e.id||job.kind!=='export'||job.owner_id!==lease.ownerId||e.owner_id!==lease.ownerId||job.fence!==lease.jobFence||e.fence!==lease.fence||!live.job_live||!live.export_live||job.state!=='running'||e.status!=='running')throw new ServiceError('STALE_WORKER','This export worker no longer owns the activation.');
  if(hash(e.snapshot)!==e.snapshot_hash)throw new ServiceError('EXPORT_INTEGRITY','Frozen export changed.');
  return e;
 }
 async function claim(jobId:string,ownerId:string,leaseSeconds=300) {
  uuid.parse(jobId);uuid.parse(ownerId);z.number().int().min(1).max(900).parse(leaseSeconds);
  return await transaction(pool,async c=>{
   const job=(await c.query("SELECT *,lease_expires_at>clock_timestamp() AS live FROM flume.outbox WHERE id=$1 AND kind='export' FOR UPDATE",[jobId])).rows[0];
   if(!job||job.state==='done'||job.state==='failed'||(job.state==='running'&&job.live))return null;
   const e=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM flume.exports WHERE id=$1 FOR UPDATE',[job.resource_id])).rows[0];
   if(!e||e.status==='ready'||e.status==='failed'||e.live)return null;
   if(hash(e.snapshot)!==e.snapshot_hash)throw new ServiceError('EXPORT_INTEGRITY','Frozen export changed.');
   const source=(await c.query('SELECT * FROM flume.assets WHERE id=$1 AND project_id=$2',[e.snapshot.sourceAssetId,e.project_id])).rows[0];
   if(!source||source.sha256!==e.snapshot.sourceSha256)throw new ServiceError('EXPORT_SOURCE','Frozen source is unavailable.');
   await c.query("UPDATE flume.outbox SET owner_id=$2,fence=fence+1,state='running',lease_expires_at=clock_timestamp()+$3*interval '1 second' WHERE id=$1",[job.id,ownerId,leaseSeconds]);
   await c.query("UPDATE flume.exports SET owner_id=$2,fence=fence+1,status='running',lease_expires_at=clock_timestamp()+$3*interval '1 second' WHERE id=$1",[e.id,ownerId,leaseSeconds]);
   return {lease:{jobId:job.id,exportId:e.id,ownerId:ownerId.toLowerCase(),fence:e.fence+1,jobFence:job.fence+1},snapshot:e.snapshot,snapshotHash:e.snapshot_hash,source:ownedAsset(source)};
  });
 }
 async function complete(lease:ExportLease,raw:OwnedAsset) {
  const asset=ownedAssetSchema.parse(raw);if(asset.kind!=='video')throw new ServiceError('EXPORT_KIND','Export must be an owned video.');
  await media.verifyOwned(asset);
  await transaction(pool,async c=>{
   const e=await guarded(c,lease);
   if(asset.projectId.toLowerCase()!==e.project_id)throw new ServiceError('ASSET_SCOPE','Export project mismatch.');
   await insertAsset(c,asset);
   await guarded(c,lease); // Foreign-key/uniqueness waits can also outlive the lease; roll back publication.
   await c.query("UPDATE flume.exports SET status='ready',asset_id=$2 WHERE id=$1",[e.id,asset.id]);
   await c.query("UPDATE flume.outbox SET state='done' WHERE id=$1",[lease.jobId]);
  });
 }
 async function fail(lease:ExportLease,error:{code:string;message:string}){
  z.strictObject({code:z.string().min(1).max(100),message:z.string().max(2000)}).parse(error);
  await transaction(pool,async c=>{await guarded(c,lease);await c.query("UPDATE flume.exports SET status='failed',error_code=$2,message=$3 WHERE id=$1",[lease.exportId,error.code,error.message]);await c.query("UPDATE flume.outbox SET state='failed' WHERE id=$1",[lease.jobId]);});
 }
 return {claim,complete,fail};
}
