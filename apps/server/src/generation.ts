import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { hash,sha256,money,ServiceError,type Actor,type Command,type Receipt } from './contracts.ts';
import type { PreparedGeneration,TransactionalQueuePort,QueueJob } from './ports.ts';
import { lockShot } from './store-helpers.ts';
export type Prepared={snapshot:any;result:PreparedGeneration};
export const preparedSchema=z.strictObject({
 envelope:z.strictObject({provider:z.string().min(1),modelId:z.string().min(1),body:z.string().max(8_000_000),bodySha256:z.string().regex(/^[0-9a-f]{64}$/)}).nullable(),
 estimatedCostUsd:money.nullable(),blockers:z.array(z.union([z.string().max(2000),z.object({code:z.string().min(1),message:z.string().min(1).max(2000)}).strict()])).max(100),
});
export async function enqueue(c:PoolClient,queue:TransactionalQueuePort,job:QueueJob){
 if(await queue.enqueue(c,job)!==job.id)throw new ServiceError('ENQUEUE_FAILED','Work was not queued; nothing was accepted.',503);
}
export function verifyReview(review:any){
 if(hash({snapshot:review.snapshot,envelope:review.envelope})!==review.request_hash)throw new ServiceError('REVIEW_INTEGRITY','Reviewed request integrity failed.');
 if(review.envelope && sha256(review.envelope.body)!==review.envelope.bodySha256)throw new ServiceError('REVIEW_INTEGRITY','Provider envelope integrity failed.');
}
export async function generationCommand(c:PoolClient,actor:Actor,cmd:Command,queue:TransactionalQueuePort,prepared?:Prepared):Promise<Receipt> {
 if(!('projectId' in cmd))throw new Error('Unexpected command');
 const base={commandId:cmd.commandId,projectId:cmd.projectId};
 if(cmd.type==='generation.prepare') {
  const shot=await lockShot(c,cmd.projectId,cmd.shotId,cmd.expectedRevision);
  if(!prepared||prepared.snapshot.shotRevision!==shot.revision)throw new ServiceError('REVISION_CONFLICT','The shot changed during preparation.',409,shot.revision);
  const {snapshot,result}=prepared,id=randomUUID(),requestHash=hash({snapshot,envelope:result.envelope});
  await c.query('INSERT INTO flume.reviews (id,project_id,shot_id,shot_revision,request_hash,snapshot,envelope,estimated_cost_usd,blockers) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,cmd.projectId,cmd.shotId,shot.revision,requestHash,snapshot,result.envelope,result.estimatedCostUsd,JSON.stringify(result.blockers)]);
  return {...base,reviewId:id,resourceId:id,revision:shot.revision};
 }
 if(cmd.type!=='generation.approve'&&cmd.type!=='generation.submit')throw new Error('Unexpected command');
 if(cmd.type==='generation.approve'&&actor.kind!=='operator')throw new ServiceError('APPROVAL_FORBIDDEN','Only the configured operator context may approve spending.',403);
 const review=(await c.query('SELECT * FROM flume.reviews WHERE id=$1 AND project_id=$2 FOR UPDATE',[cmd.reviewId,cmd.projectId])).rows[0];
 if(!review)throw new ServiceError('REVIEW_NOT_FOUND','Review not found.',404);
 const shot=await lockShot(c,cmd.projectId,review.shot_id);
 if(review.shot_revision!==shot.revision)throw new ServiceError('STALE_REVIEW','The shot changed. Prepare and review its current state.',409,shot.revision);
 verifyReview(review);
 if(review.consumed_attempt_id)throw new ServiceError('REVIEW_CONSUMED','This review already created an attempt.');
 if(review.blockers.length||!review.envelope)throw new ServiceError('GENERATION_BLOCKED','Resolve the generation blockers before approval or submission.',409,undefined,{blockers:review.blockers});
 if(cmd.type==='generation.approve') {
  if(review.estimated_cost_usd===null&&cmd.maxCostUsd!==null)throw new ServiceError('COST_UNKNOWN','A dollar limit cannot be enforced when price is unknown. Use explicit attempt-count approval.');
  if((await c.query('SELECT 1 FROM flume.approvals WHERE review_id=$1',[review.id])).rowCount)throw new ServiceError('ALREADY_APPROVED','This review already has an approval.');
  if(cmd.maxCostUsd!==null && (await c.query('SELECT $1::numeric < $2::numeric AS insufficient',[cmd.maxCostUsd,review.estimated_cost_usd])).rows[0].insufficient)throw new ServiceError('BUDGET_EXCEEDED','The cost limit is less than the reviewed estimate.');
  await c.query("INSERT INTO flume.approvals (review_id,actor_id,max_attempts,max_cost_usd,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')",[review.id,actor.id,cmd.maxAttempts,cmd.maxCostUsd]);
  return {...base,reviewId:review.id,resourceId:review.id,revision:shot.revision};
 }
 await c.query('SELECT review_id FROM flume.approvals WHERE review_id=$1 FOR UPDATE',[review.id]);
 const reserved=await c.query(`UPDATE flume.approvals SET reserved_count=reserved_count+1,reserved_cost_usd=reserved_cost_usd+coalesce($2::numeric,0)
  WHERE review_id=$1 AND NOT revoked AND expires_at>clock_timestamp() AND reserved_count<max_attempts
  AND (max_cost_usd IS NULL OR ($2::numeric IS NOT NULL AND reserved_cost_usd+$2::numeric<=max_cost_usd)) RETURNING review_id`,[review.id,review.estimated_cost_usd]);
 if(reserved.rowCount!==1)throw new ServiceError('APPROVAL_REQUIRED','Current, unexpired approval with available allowance is required.');
 const id=randomUUID();
 await c.query("INSERT INTO flume.attempts (id,project_id,shot_id,shot_revision,review_id,actor_id,status) VALUES ($1,$2,$3,$4,$5,$6,'queued')",[id,cmd.projectId,shot.id,shot.revision,review.id,actor.id]);
 await c.query('UPDATE flume.reviews SET consumed_attempt_id=$2 WHERE id=$1',[review.id,id]);
 await c.query('INSERT INTO flume.reservations (attempt_id,review_id,amount_usd) VALUES ($1,$2,$3)',[id,review.id,review.estimated_cost_usd]);
 await enqueue(c,queue,{id,kind:'generation',projectId:cmd.projectId,resourceId:id,payload:{attemptId:id}});
 return {...base,attemptId:id,resourceId:id,revision:shot.revision};
}
