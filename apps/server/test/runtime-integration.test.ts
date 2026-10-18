import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate } from '@flume/database';
import { WorkspaceSchema } from '@flume/domain';
import { runDelivery } from '@flume/worker';
import { ownedPostgres } from '../../../packages/database/test/owned-postgres.ts';
import { createCommandService } from '../src/service.ts';
import { buildServer } from '../src/http.ts';
import { sha256 } from '../src/contracts.ts';
import { toWorkerMedia, toOwnedAsset } from '../src/media-bridge.ts';
import {createExportStore} from '../src/export-store.ts';
import {freezeExportSelection} from '@flume/media';
import {setTimeout as delay} from 'node:timers/promises';

test('real API → transactional pg-boss → owned SAMPLE take → explicit inspect/select → frozen export',async()=>{
 const db=await ownedPostgres();let runtime:any,app:any;
 try {
  await migrate(db.pool);
  const mod=await import('../src/runtime.ts').catch(()=>null);
  assert.ok(mod?.createRuntime,'integrated runtime exists, not default blocked stubs');
  const clip=join(db.root,'sample.mp4'),png=join(db.root,'sample.png');
  execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','1','-threads','1','-c:v','libx264','-pix_fmt','yuv420p',clip]);
  execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=320x180','-frames:v','1','-threads','1',png]);
  const bytes=await readFile(clip);let posts=0;
  runtime=await mod.createRuntime({pool:db.pool,mediaRoot:join(db.root,'media'),autoStart:false,
   provider:{async capabilities(){return [{modelId:'sample/local',name:'Controlled sample (not generation)',durations:[1],resolutions:['180p'],frameRoles:['first','last'],seedSupported:true,availability:'available',blocker:null}];},
    async prepare({shot}:any){const body=JSON.stringify(shot);return {envelope:{provider:'sample',modelId:shot.controls.modelId,body,bodySha256:sha256(body)},estimatedCostUsd:'0.00',blockers:[]};}},
   workerProvider:{async submit({request}:any){posts++;return {kind:'accepted',receipt:{provider:'sample',scope:'local-fixture-v1',modelId:request.modelId,providerJobId:'sample-job'}};},async status(receipt:any){return {kind:'succeeded',receipt};},async outputs(receipt:any){return {kind:'outputs',receipt,outputs:[{outputId:'sample',url:'https://sample.invalid/owned'}]};}},
   scope:'local-fixture-v1',outputAdapter:store=>({async ownOutput({projectId},signal){signal.throwIfAborted();return toWorkerMedia(await store.importStream({projectId,assetId:randomUUID(),filename:'CONTROLLED-SAMPLE.mp4',origin:'sample',claimedMime:'video/mp4'},(async function*(){yield bytes;})()));}}),
  });
  const service=createCommandService({pool:db.pool,...runtime.serviceOptions});
  app=await buildServer({service,security:{mode:'local-operator',allowedHosts:['localhost'],allowedOrigins:['http://localhost']}});
  const send=async(body:object)=>{const r=await app.inject({method:'POST',url:'/api/commands',headers:{host:'localhost',origin:'http://localhost'},payload:{commandId:randomUUID(),...body}});assert.equal(r.statusCode,200,r.body);return r.json();};
  const {projectId}=await send({type:'project.create',name:'CONTROLLED SAMPLE INTEGRATION',brief:'Not a live provider result'});
  const shotId=(await send({type:'shot.create',projectId,title:'Sample shot',prompt:'Exact  '})).resourceId;
  const actor={id:'10000000-0000-4000-8000-000000000001',kind:'operator' as const,projectIds:'*' as const};
  const first=await service.uploadAsset(actor,{projectId,filename:'sample.png',mimeType:'image/png',bytes:await readFile(png)});
  await send({type:'shot.update',projectId,shotId,expectedRevision:1,patch:{controls:{modelId:'sample/local',durationSeconds:1,resolution:'180p',seed:0},bindings:{firstFrameAssetId:first.id,lastFrameAssetId:first.id}}});
  const {reviewId}=await send({type:'generation.prepare',projectId,shotId,expectedRevision:2});
  await send({type:'generation.approve',projectId,reviewId,maxAttempts:1,maxCostUsd:'0.00'});
  const submit={type:'generation.submit',commandId:randomUUID(),projectId,reviewId};
  const failing=createCommandService({pool:db.pool,...runtime.serviceOptions,queue:{async enqueue(c,job){
   await runtime.serviceOptions.queue.enqueue(c,job);
   const inside=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const outside=(await db.pool.query('SELECT pg_backend_pid() pid,(SELECT count(*)::int FROM flume.attempts) attempts,(SELECT count(*)::int FROM flume_queue.job) jobs')).rows[0];
   assert.notEqual(inside,outside.pid);assert.equal(outside.attempts,0);assert.equal(outside.jobs,0);
   throw new Error('injected bridge rollback');
  }}});
  await assert.rejects(failing.command(actor,submit),/injected bridge rollback/);
  const rolled=(await db.pool.query('SELECT (SELECT count(*)::int FROM flume.attempts) attempts,(SELECT count(*)::int FROM flume.worker_checkpoints) checkpoints,(SELECT count(*)::int FROM flume_queue.job) jobs,(SELECT count(*)::int FROM flume.outbox) outbox')).rows[0];
  assert.deepEqual(rolled,{attempts:0,checkpoints:0,jobs:0,outbox:0});
  const receipt=await service.command(actor,submit);assert.deepEqual(await service.command(actor,submit),receipt);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume_queue.job')).rows[0].n,1);
  for(let i=0;i<4;i++)await runDelivery(runtime.worker,{pollDelaySeconds:0});
  let w=WorkspaceSchema.parse(await service.getWorkspace(actor,projectId));
  assert.equal(posts,1);assert.equal(w.attempts[0].status,'ready');assert.equal(w.takes.length,1);assert.equal(w.shots[0].selectedTakeId,null);
  assert.equal(w.assets.find(a=>a.id===w.takes[0].assetId)?.origin,'sample','fixture must never masquerade as generated');
  const takeId=w.takes[0].id,inspectionId=(await send({type:'take.inspect',projectId,takeId})).resourceId;
  await send({type:'take.select',projectId,shotId,takeId,inspectionId,expectedRevision:2,expectedSelectionRevision:0});
  const {exportId}=await send({type:'export.create',projectId,shotId,expectedRevision:2,expectedSelectionRevision:1});
  await send({type:'shot.update',projectId,shotId,expectedRevision:2,patch:{prompt:'Later edit'}});
  const exportStore=createExportStore({pool:db.pool,media:runtime.serviceOptions.media});
  const claim=await exportStore.claim(exportId,randomUUID(),1);assert.ok(claim);
  const snap=claim.snapshot;
  const rendered=await runtime.mediaStore.exportSelected(freezeExportSelection({exportId,assetId:exportId,projectId,shotId,takeId,sourceAssetId:snap.sourceAssetId,sourceSha256:snap.sourceSha256,shotRevision:snap.shotRevision,selectionRevision:snap.selectionRevision,profile:'mp4-copy-v1'}));
  const blocker=await db.pool.connect();
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM flume.exports WHERE id=$1 FOR UPDATE',[exportId]);
   const completing=exportStore.complete(claim.lease,toOwnedAsset(rendered));
   const rejection=assert.rejects(completing,{code:'STALE_WORKER'});
   await delay(1200);await blocker.query('COMMIT');await rejection;
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  const afterWait=await exportStore.claim(exportId,randomUUID(),1);assert.ok(afterWait);
  const publicationBlocker=await db.pool.connect();
  try{
   await publicationBlocker.query('BEGIN');await publicationBlocker.query('SELECT id FROM flume.projects WHERE id=$1 FOR UPDATE',[projectId]);
   const completing=exportStore.complete(afterWait.lease,toOwnedAsset(rendered));
   const rejection=assert.rejects(completing,{code:'STALE_WORKER'});
   await delay(1200);await publicationBlocker.query('COMMIT');await rejection;
  }finally{await publicationBlocker.query('ROLLBACK');publicationBlocker.release();}
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.assets WHERE id=$1',[exportId])).rows[0].n,0,'stale publication rolls back the inserted asset');
  await runtime.runExport();
  w=WorkspaceSchema.parse(await service.getWorkspace(actor,projectId));
  const exp=w.exports.find(e=>e.id===exportId)!;assert.equal(exp.status,'ready');assert.equal(exp.stale,true);assert.equal(exp.shotRevision,2);
  const response=await app.inject({url:`/api/media/${exp.assetId}`,headers:{host:'localhost',range:'bytes=0-15'}});assert.equal(response.statusCode,206);assert.equal(response.rawPayload.length,16);
  assert.deepEqual(await service.command(actor,submit),receipt,'accepted submit replay survives edits');
  assert.equal(posts,1);
  // Actual production WorkerStore, not the worker lane's fixture store:
  // a conflicting observation commits after adoption and before publication.
  const review2=(await send({type:'generation.prepare',projectId,shotId,expectedRevision:3})).reviewId;
  await send({type:'generation.approve',projectId,reviewId:review2,maxAttempts:1,maxCostUsd:'0'});
  const second=await send({type:'generation.submit',projectId,reviewId:review2});
  for(let i=0;i<3;i++)await runDelivery(runtime.worker,{pollDelaySeconds:0});
  const own=runtime.worker.media.ownOutput;
  runtime.worker.media={async ownOutput(input:any,signal:AbortSignal){
   const owned=await own(input,signal);
   const state=(await db.pool.query('SELECT state FROM flume.worker_checkpoints WHERE attempt_id=$1',[second.attemptId])).rows[0].state;
   await runtime.worker.store.observeReceipt(state.id,state.dispatch,{...state.receipt,providerJobId:'late-conflicting-sample'});
   return owned;
  }};
  assert.equal(await runDelivery(runtime.worker),'blocked');
  const conflict=await service.getWorkspace(actor,projectId);
  assert.equal(conflict.takes.length,1,'no second take may publish after conflicting evidence; historical media remains');
  assert.equal(conflict.attempts.find(a=>a.id===second.attemptId)?.errorCode,'IDENTITY_CONFLICT');
  assert.equal(posts,2,'one submit per approved test attempt, never a retry');
 }finally{await app?.close();await runtime?.close();await db.close();}
});
