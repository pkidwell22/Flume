import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hash,ServiceError,type Actor,type Command,type Receipt } from './contracts.ts';
import { lockShot } from './store-helpers.ts';
import { getTakeAsset } from './assets.ts';
import { enqueue } from './generation.ts';
import type { TransactionalQueuePort } from './ports.ts';
export type PreparedInspection={shotRevision:number;sha256:string;takeId:string};
export async function selectionCommand(c:PoolClient,actor:Actor,cmd:Command,queue:TransactionalQueuePort,inspection?:PreparedInspection):Promise<Receipt> {
 if(!('projectId' in cmd))throw new Error('Unexpected command');
 const base={commandId:cmd.commandId,projectId:cmd.projectId};
 if(cmd.type==='take.inspect') {
  const asset=await getTakeAsset(c,cmd.projectId,cmd.takeId);
  const shot=await lockShot(c,cmd.projectId,asset.shot_id);
  if(!inspection||inspection.shotRevision!==shot.revision||inspection.sha256!==asset.sha256||inspection.takeId!==asset.take_id)throw new ServiceError('INSPECTION_STALE','The shot changed during inspection.',409,shot.revision);
  const id=randomUUID();
  await c.query('INSERT INTO flume.inspections (id,actor_id,project_id,shot_id,shot_revision,take_id,asset_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,actor.id,cmd.projectId,shot.id,shot.revision,cmd.takeId,asset.sha256]);
  return {...base,resourceId:id,revision:shot.revision};
 }
 if(cmd.type==='take.select'||cmd.type==='export.create') {
  const shot=await lockShot(c,cmd.projectId,cmd.shotId,cmd.expectedRevision);
  if(shot.selection_revision!==cmd.expectedSelectionRevision)throw new ServiceError('SELECTION_CONFLICT','The selection changed. Reload before selecting or exporting.',409,shot.revision,{currentSelectionRevision:shot.selection_revision});
  if(cmd.type==='take.select') {
   const asset=await getTakeAsset(c,cmd.projectId,cmd.takeId);
   if(asset.shot_id!==shot.id)throw new ServiceError('TAKE_SCOPE','The take belongs to a different shot.');
   const found=await c.query('SELECT id FROM flume.inspections WHERE id=$1 AND actor_id=$2 AND project_id=$3 AND shot_id=$4 AND shot_revision=$5 AND take_id=$6 AND asset_sha256=$7',[cmd.inspectionId,actor.id,cmd.projectId,shot.id,shot.revision,cmd.takeId,asset.sha256]);
   if(!found.rowCount)throw new ServiceError('INSPECTION_REQUIRED','Inspect this owned take against the current shot before selecting it.');
   await c.query('UPDATE flume.shots SET selected_take_id=$2,selection_revision=selection_revision+1 WHERE id=$1',[shot.id,cmd.takeId]);
   await c.query('UPDATE flume.exports SET stale=true WHERE shot_id=$1',[shot.id]);
   return {...base,resourceId:shot.id,revision:shot.revision};
  }
  if(!shot.selected_take_id)throw new ServiceError('SELECTION_REQUIRED','Explicitly select an inspected take before exporting.');
  const asset=await getTakeAsset(c,cmd.projectId,shot.selected_take_id);
  const snapshot={projectId:cmd.projectId,shotId:shot.id,takeId:shot.selected_take_id,shotRevision:shot.revision,selectionRevision:shot.selection_revision,prompt:shot.prompt,controls:shot.controls,bindings:shot.bindings,sourceAssetId:asset.id,sourceSha256:asset.sha256};
  const id=randomUUID();
  await c.query('INSERT INTO flume.exports (id,project_id,shot_id,take_id,shot_revision,selection_revision,snapshot,snapshot_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id,cmd.projectId,shot.id,shot.selected_take_id,shot.revision,shot.selection_revision,snapshot,hash(snapshot)]);
  await enqueue(c,queue,{id,kind:'export',projectId:cmd.projectId,resourceId:id,payload:{exportId:id}});
  return {...base,exportId:id,resourceId:id,revision:shot.revision};
 }
 if(cmd.type==='attempt.resume') {
  const a=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS active FROM flume.attempts WHERE id=$1 AND project_id=$2 FOR UPDATE',[cmd.attemptId,cmd.projectId])).rows[0];
  if(!a)throw new ServiceError('ATTEMPT_NOT_FOUND','Attempt not found.',404);
  if(a.status==='ready')throw new ServiceError('ATTEMPT_READY','This attempt is already complete.');
  if(a.active)throw new ServiceError('ATTEMPT_ACTIVE','The current worker still owns this attempt.');
  if(a.dispatch_state!=='not_started'&&!a.provider_receipt)throw new ServiceError('ACCEPTANCE_UNKNOWN','Provider acceptance is unknown. Reconcile the original request; do not submit again.');
  const pending=await c.query("SELECT id FROM flume.outbox WHERE resource_id=$1 AND kind IN ('generation','resume') AND state='pending'",[a.id]);
  if(!pending.rowCount)await enqueue(c,queue,{id:randomUUID(),kind:'resume',projectId:cmd.projectId,resourceId:a.id,payload:{attemptId:a.id}});
  return {...base,attemptId:a.id,resourceId:a.id,revision:a.shot_revision};
 }
 throw new Error('Unexpected command');
}
