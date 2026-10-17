import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { queue } from '../01-approved-attempt/dist/src/database.js';
import { z } from 'zod';
import { accept } from '../01-approved-attempt/dist/src/accept.js';
import { hash, requestSchema } from '../01-approved-attempt/dist/src/contracts.js';
import { inspectVideo } from './media.ts';
import { render } from './export.ts';
import type { ChildProcess } from 'node:child_process';
import type { PoolClient } from 'pg';
import type { Experiment } from '../01-approved-attempt/dist/src/database.js';
export type Catalog = { continuity: any; files: Record<string,string>;
  outputs: {id:string; path:string; sha256:string; size:number; description:string}[] };
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const revision = z.number().int().positive();
const commands = z.discriminatedUnion('type', [
  z.strictObject({type:z.literal('edit'), revision, prompt:z.string().min(1).max(1000)}),
  z.strictObject({type:z.literal('submit'), revision, commandId:z.uuid()}),
  z.strictObject({type:z.literal('inspect'), revision, artifact:z.union([z.literal('first-look'),z.uuid()])}),
  z.strictObject({type:z.literal('approve'), revision, inspectionId:z.uuid()}),
  z.strictObject({type:z.literal('recover'), revision, attemptId:z.uuid()}),
  z.strictObject({type:z.literal('export'), revision, selectionRevision:z.number().int().nonnegative()}),
  z.strictObject({type:z.literal('select'), revision, selectionRevision:z.number().int().nonnegative(),takeId:z.uuid(),inspectionId:z.uuid()}),
]);
export async function transaction<T>(client:PoolClient, action:()=>Promise<T>):Promise<T> {
  await client.query('BEGIN');
  try {const result = await action(); await client.query('COMMIT'); return result;}
  catch(error) {await client.query('ROLLBACK'); throw error;}
}
export async function createService(e:Experiment, catalog:Catalog, storage:string) {
  await e.pool.query(await readFile(new URL('../01-approved-attempt/recovery/schema.sql',import.meta.url),'utf8'));
  await e.pool.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const projectId = randomUUID(), shotId = randomUUID(), accountId = randomUUID();
  const credentials = {human:randomBytes(32).toString('hex'), agent:randomBytes(32).toString('hex')};
  // Process-local handle for this fixture reviewer only; never a wire credential.
  // Its lifetime is the owned demo, not the one-hour protected bearer session.
  const localFixtureReviewer=Symbol('trusted-local-fixture-review');
  await e.pool.query('INSERT INTO spike.drafts VALUES ($1,$2,1,$3)',[shotId,projectId,'Continue from the cyan last frame; end reference is red.']);
  await e.pool.query('INSERT INTO parity.plans (shot_id,continuity) VALUES ($1,$2)',[shotId,catalog.continuity]);
  for (const [role,token] of Object.entries(credentials)) await e.pool.query(
    `INSERT INTO parity.sessions VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`,
    [digest(token),randomUUID(),projectId,role==='human']);
  async function identity(token:string|symbol, client: Pick<PoolClient,'query'> = e.pool) {
    const local=token===localFixtureReviewer;
    if(typeof token!=='string'&&!local)throw new Error('AUTHORIZATION');
    const {rows:[actor]} = await client.query('SELECT * FROM parity.sessions WHERE token_hash=$1 AND project_id=$2 AND (expires_at>clock_timestamp() OR $3)',[digest(local?credentials.human:token as string),projectId,local]);
    if (!actor) throw new Error('AUTHORIZATION'); return actor;
  }
  async function state(client:Pick<PoolClient,'query'> = e.pool) {
    const {rows:[draft]}=await client.query('SELECT d.*,p.continuity,p.selected_take,p.selection_revision FROM spike.drafts d JOIN parity.plans p ON p.shot_id=d.id WHERE d.id=$1',[shotId]);
    return draft;
  }
  async function artifact(id:string,client:Pick<PoolClient,'query'>=e.pool) {
    if(id==='first-look') return catalog.outputs[0];
    const {rows:[take]}=await client.query(`SELECT t.* FROM recovery.takes t JOIN spike.attempts a ON a.id=t.attempt_id
      WHERE t.id=$1 AND a.project_id=$2`,[id,projectId]);
    if(!take || !catalog.outputs.some(o=>o.sha256===take.sha256)) throw new Error('OWNED_MEDIA_REQUIRED');
    return {path:path.join(storage,`${take.sha256}.simulation`),sha256:take.sha256};
  }
  const planHash=(draft:any)=>hash({revision:draft.revision,prompt:draft.prompt,continuity:draft.continuity});
  async function read(token:string|symbol) {
    const actor=await identity(token);
    const client=await e.pool.connect();
    try {return await transaction(client,async()=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const draft=await state(client);
      const takes=(await client.query(`SELECT t.* FROM recovery.takes t JOIN spike.attempts a ON a.id=t.attempt_id
        WHERE a.project_id=$1 ORDER BY t.output_id`,[projectId])).rows;
      const attempts=(await client.query(`SELECT a.id,a.request_fingerprint,a.request->>'draftRevision' AS revision,l.*
        FROM spike.attempts a JOIN recovery.lifecycle l ON l.attempt_id=a.id WHERE a.project_id=$1 ORDER BY a.created_at`,[projectId])).rows;
      const exports=(await client.query('SELECT * FROM parity.exports WHERE shot_id=$1',[shotId])).rows;
      return {...draft,takes,attempts,exports,canReview:actor.can_review};
    });} finally {client.release();}
  }
  async function media(token:string|symbol,id:string) {
    await identity(token);
    if(/^image-[a-f0-9]{64}$/.test(id)&&catalog.files[id]) {
      const bytes=await readFile(catalog.files[id]);if(digest(bytes)!==id.slice(6)) throw new Error('MEDIA_HASH');
      return {bytes,type:'image/png'};
    }
    if(/^export-[a-f0-9-]{36}$/.test(id)) {
      const {rows:[job]}=await e.pool.query("SELECT * FROM parity.exports WHERE id=$1 AND shot_id=$2 AND status='complete'",[id.slice(7),shotId]);
      if(!job) throw new Error('OWNED_MEDIA_REQUIRED');
      const file=path.join(storage,`${id}.mp4`);await inspectVideo(file,job.output_sha256);
      return {bytes:await readFile(file),type:'video/mp4'};
    }
    if(id!=='first-look'&&!z.uuid().safeParse(id).success) throw new Error('STRUCTURE');
    const file=await artifact(id);await inspectVideo(file.path,file.sha256);
    return {bytes:await readFile(file.path),type:'video/mp4'};
  }
  async function command(token:string|symbol, raw:unknown,
    recover?:(id:string,reactivate:()=>Promise<void>)=>Promise<void>):Promise<any> {
    await identity(token);
    if (raw && typeof raw==='object' && 'type' in raw && ['transfer','spend','authorize'].includes(String(raw.type))) throw new Error('CAPABILITY');
    const parsed=commands.safeParse(raw); if (!parsed.success) throw new Error('STRUCTURE');
    const cmd=parsed.data;
    const client=await e.pool.connect();
    try {
      // All adapter commands serialize per owned shot, including the unchanged
      // core accept() transaction on its own checked-out connection.
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[shotId]);
      const actor=await identity(token,client);
      if(cmd.type==='submit') {
        // Resolve the original immutable core command, not today's approval.
        // Principal and strict command validation still precede this receipt read.
        const {rows:[accepted]}=await client.query(`SELECT a.* FROM spike.receipts r
          JOIN spike.attempts a ON a.id=r.attempt_id
          WHERE r.project_id=$1 AND r.actor_id=$2 AND r.command_id=$3`,[projectId,actor.actor_id,cmd.commandId]);
        if(accepted) {
          if(cmd.revision!==accepted.request.draftRevision || accepted.request.shotId!==shotId) throw new Error('COMMAND_CONFLICT');
          return await accept(e,{projectId,actorId:actor.actor_id},{commandId:cmd.commandId,
            reviewId:accepted.review_id,grantId:accepted.grant_id,requestFingerprint:accepted.request_fingerprint});
        }
      }
      const draft=await state(client);
      if (cmd.revision!==draft.revision) throw new Error('REVISION_CONFLICT');
      if (cmd.type==='edit') return await transaction(client,async()=>{
        const changed=await client.query('UPDATE spike.drafts SET prompt=$2,revision=revision+1 WHERE id=$1 AND revision=$3',[shotId,cmd.prompt,cmd.revision]);
        if(changed.rowCount!==1) throw new Error('REVISION_CONFLICT');
        await client.query('UPDATE spike.grants SET revoked=true WHERE project_id=$1',[projectId]);
        await client.query('UPDATE parity.exports SET stale=true WHERE shot_id=$1',[shotId]);
        return state(client);
      });
      if(cmd.type==='inspect') {
        const output=await artifact(cmd.artifact,client);
        const measured=await inspectVideo(output.path,output.sha256);
        const id=randomUUID();
        await client.query('INSERT INTO parity.inspections VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id,actor.actor_id,shotId,planHash(draft),cmd.artifact,measured.sha256,measured.probe]);
        return {id,artifact:cmd.artifact,...measured};
      }
      if(cmd.type==='approve') {
        if(!actor.can_review) throw new Error('AUTHORIZATION_DENIED');
        const {rows:[inspection]}=await client.query('SELECT * FROM parity.inspections WHERE id=$1 AND actor_id=$2 AND shot_id=$3',
          [cmd.inspectionId,actor.actor_id,shotId]);
        if(!inspection || inspection.plan_hash!==planHash(draft)) throw new Error('REVIEW_SCOPE');
        await inspectVideo((await artifact(inspection.artifact,client)).path,inspection.sha256);
        if((await client.query('SELECT 1 FROM spike.reviews WHERE shot_id=$1 AND draft_revision=$2',[shotId,draft.revision])).rowCount)
          throw new Error('REVIEW_EXISTS');
        const {first,last}=draft.continuity;
        const frozen=requestSchema.parse({version:1,projectId,shotId,draftRevision:draft.revision,
          route:'fixture/video-v1',accountId,
          spec:{prompt:draft.prompt,seed:0,audio:false,
            firstFrame:{assetRevisionId:first.assetRevisionId,sha256:first.image.sha256},
            lastFrame:{assetRevisionId:last.assetRevisionId,sha256:last.image.sha256}},
          envelope:{version:1,adapterVersion:'fixture-1',body:JSON.stringify({profile:'owned-pattern-mp4-v1',
            prompt:draft.prompt,continuity:draft.continuity,firstLook:{inspectionId:inspection.id,artifact:inspection.artifact,sha256:inspection.sha256,planHash:inspection.plan_hash}})}});
        const reviewId=randomUUID(),fingerprint=hash(frozen);
        return await transaction(client,async()=>{
          await client.query('UPDATE spike.grants SET revoked=true WHERE project_id=$1',[projectId]);
          await client.query('INSERT INTO spike.reviews (id,project_id,shot_id,draft_revision,request,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6)',
            [reviewId,projectId,shotId,draft.revision,frozen,fingerprint]);
          await client.query('INSERT INTO parity.approvals VALUES ($1,$2,$3)',[reviewId,inspection.id,actor.actor_id]);
          const members=await client.query('SELECT actor_id FROM parity.sessions WHERE project_id=$1',[projectId]);
          for(const member of members.rows) await client.query(`INSERT INTO spike.grants
            (id,project_id,actor_id,approving_principal,route,account_id,effect,allowed_fingerprints,expires_at,budget_policy,attempt_limit,reserved_count,revoked)
            VALUES ($1,$2,$3,$4,'fixture/video-v1',$5,'generate',$6,clock_timestamp()+interval '15 minutes','count_only_unknown_cost',1,0,false)`,
            [randomUUID(),projectId,member.actor_id,actor.actor_id,accountId,JSON.stringify([fingerprint])]);
          return {reviewId,fingerprint,inspectionId:inspection.id};
        });
      }
      if(cmd.type==='recover') {
        const {rows:[attempt]}=await client.query('SELECT * FROM spike.attempts WHERE id=$1 AND project_id=$2',[cmd.attemptId,projectId]);
        if(!attempt) throw new Error('AUTHORIZATION');
        const reactivate=async()=>{await e.boss.fail(queue,attempt.job_id);await e.boss.retry(queue,attempt.job_id);};
        // HTTP owns the local worker. Keep its stop/reactivate/start decision
        // together, but only after the common authorization/revision checks.
        if(recover)await recover(attempt.id,reactivate);else await reactivate();
        return {attemptId:attempt.id,jobId:attempt.job_id};
      }
      if(cmd.type==='select') {
        if(cmd.selectionRevision!==draft.selection_revision) throw new Error('SELECTION_CONFLICT');
        const {rows:[inspection]}=await client.query(`SELECT * FROM parity.inspections
          WHERE id=$1 AND actor_id=$2 AND shot_id=$3 AND artifact=$4 AND plan_hash=$5`,
          [cmd.inspectionId,actor.actor_id,shotId,cmd.takeId,planHash(draft)]);
        if(!inspection) throw new Error('INSPECTION_REQUIRED');
        const media=await artifact(cmd.takeId,client); await inspectVideo(media.path,inspection.sha256);
        return await transaction(client,async()=>{
          const changed=await client.query('UPDATE parity.plans SET selected_take=$2,selection_revision=selection_revision+1 WHERE shot_id=$1 AND selection_revision=$3',[shotId,cmd.takeId,cmd.selectionRevision]);
          if(changed.rowCount!==1) throw new Error('SELECTION_CONFLICT');
          await client.query('UPDATE parity.exports SET stale=true WHERE shot_id=$1',[shotId]);
          return state(client);
        });
      }
      if(cmd.type==='export') {
        if(cmd.selectionRevision!==draft.selection_revision) throw new Error('SELECTION_CONFLICT');
        if(!draft.selected_take) throw new Error('SELECTION_REQUIRED');
        const {rows:[take]}=await client.query(`SELECT t.*,a.request FROM recovery.takes t
          JOIN spike.attempts a ON a.id=t.attempt_id WHERE t.id=$1 AND a.project_id=$2`,[draft.selected_take,projectId]);
        if(!take) throw new Error('SELECTION_REQUIRED');
        const snapshot={revision:draft.revision,selectionRevision:draft.selection_revision,prompt:draft.prompt,continuity:draft.continuity,take};
        const id=randomUUID();
        await client.query(`INSERT INTO parity.exports VALUES ($1,$2,$3,$4,$5,$6,'queued',false,NULL)`,
          [id,shotId,draft.revision,draft.selection_revision,snapshot,hash(snapshot)]);
        return {id};
      }
      const {rows:[approval]}=await client.query(`SELECT r.id,r.request_fingerprint,g.id AS grant_id FROM spike.reviews r
        JOIN spike.grants g ON g.allowed_fingerprints @> jsonb_build_array(r.request_fingerprint)
        WHERE r.project_id=$1 AND r.draft_revision=$2 AND g.actor_id=$3 AND NOT g.revoked`,[projectId,draft.revision,actor.actor_id]);
      if(!approval) throw new Error('REVIEW_REQUIRED');
      return await accept(e,{projectId,actorId:actor.actor_id},{commandId:cmd.commandId,reviewId:approval.id,grantId:approval.grant_id,requestFingerprint:approval.request_fingerprint});
    } finally {
      try {await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[shotId]);}
      finally {client.release();}
    }
  }
  return {credentials,localFixtureReviewer,projectId,shotId,accountId,read,command,media,catalog,storage,
    async isQueued(attemptId:string){return (await e.pool.query(`SELECT 1 FROM pgboss.job j JOIN spike.attempts a ON a.job_id=j.id
      WHERE a.id=$1 AND a.project_id=$2 AND j.name=$3 AND j.state IN ('created','retry')`,[attemptId,projectId,queue])).rowCount===1;},
    renderExport:(id:string,onProgress?:(child:ChildProcess)=>Promise<void>)=>render(e,storage,id,onProgress)};
}
