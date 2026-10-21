import assert from 'node:assert/strict';
import {test} from 'node:test';
import {controlledProvider} from './provider-wiring-fixture.ts';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {migrate} from '@flume/database';
import {ownedPostgres} from '../../../packages/database/test/owned-postgres.ts';
import {createRuntime} from '../src/runtime.ts';
import {readLocalRuntimeConfiguration} from '../src/local-configuration.ts';
import {runDelivery} from '@flume/worker';
import {compileVideoRequest,type VideoCapability} from '@flume/providers';
import pg from 'pg';
import {createCommandService} from '../src/service.ts';

const model={id:'minimax/hailuo-3',name:'LOCAL ONLY',supported_durations:[5],supported_resolutions:['2K'],supported_aspect_ratios:['16:9'],supported_frame_images:['first_frame','last_frame'],seed:false,generate_audio:false,pricing_skus:{duration_seconds:'0.17',reference_images:'0.021'}};
const actor={id:randomUUID(),kind:'operator' as const,projectIds:'*' as const};
test('default and incomplete configurations remain edit-only with zero submissions',async t=>{
 const f=await controlledProvider(t,{data:[model]}),db=await ownedPostgres();let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined;
 try{
  await migrate(db.pool);
  const cases:[Record<string,string>,string][]=[
   [{},'PROVIDER_UNAVAILABLE'],
   [{OPENROUTER_API_KEY:'synthetic-runtime-key'},'PROVIDER_UNAVAILABLE'],
   [{FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/fixture/v1',FLUME_H3_RETENTION_DECISION:'allow-temporary-retention'},'PROVIDER_UNAVAILABLE'],
   [{FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/fixture/v1',OPENROUTER_API_KEY:'synthetic-runtime-key'},'provider_privacy_blocked'],
  ];
  for(const [index,[env,blocker]] of cases.entries()){
   const config=readLocalRuntimeConfiguration(env);
   runtime=await createRuntime({pool:db.pool,mediaRoot:join(db.root,`media-${index}`),...config.runtime,providerTransport:f.transport});
   if(config.discover)await runtime.discover();
   const service=createCommandService({pool:db.pool,...runtime.serviceOptions});
   const send=(body:object)=>service.command(actor,{commandId:randomUUID(),...body});
   const {projectId}=await send({type:'project.create',name:'Held configuration',brief:''});
   const shotId=(await send({type:'shot.create',projectId,title:'One',prompt:'Still editable'})).resourceId!;
   const reviewId=(await send({type:'generation.prepare',projectId,shotId,expectedRevision:1})).reviewId!;
   const w=await service.getWorkspace(actor,projectId);
   assert.ok(w.reviews[0].blockers.some(b=>b.code===blocker));
   await assert.rejects(send({type:'generation.approve',projectId,reviewId,maxAttempts:1,maxCostUsd:null}),{code:'GENERATION_BLOCKED'});
   await assert.rejects(send({type:'generation.submit',projectId,reviewId}),{code:'GENERATION_BLOCKED'});
   await send({type:'shot.update',projectId,shotId,expectedRevision:1,patch:{prompt:'Local editing still works'}});
   if(!config.discover)assert.equal(f.requests.length,0,'default launch and key-only launch make no discovery requests');
   assert.equal(JSON.stringify(w).includes('synthetic-runtime-key'),false);
   await runtime.close();runtime=undefined;
  }
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.attempts')).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.approvals')).rows[0].n,0);
 }finally{try{await runtime?.close();}finally{await db.close();}}
});

test('existing injected fixture authority preserves ordinary scoped approval, one submission, exact bytes and replay',async t=>{
 const f=await controlledProvider(t,{data:[model]}),db=await ownedPostgres();let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined,independent:pg.Pool|undefined;
 const capability:VideoCapability={modelId:'fixture/approved',name:'SYNTHETIC AUTHORITY ONLY',durations:[5],resolutions:['2K'],aspectRatios:['16:9'],frameRoles:[],seedSupported:false,generateAudioSupported:false,availability:'available',blocker:null};
 try{
  await migrate(db.pool);
  const config=readLocalRuntimeConfiguration({FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/synthetic-account/v1',OPENROUTER_API_KEY:'synthetic-runtime-key'});
  runtime=await createRuntime({pool:db.pool,mediaRoot:join(db.root,'media'),autoStart:false,...config.runtime,providerTransport:f.transport,
   provider:{async capabilities(){return [{modelId:capability.modelId,name:capability.name,durations:[5],resolutions:['2K'],frameRoles:[],seedSupported:false,availability:'available',blocker:null}];},
    async prepare({shot}){const c=compileVideoRequest(shot,capability,{firstFrame:null,lastFrame:null});return {envelope:{provider:c.provider,modelId:c.modelId,body:c.bodyJson,bodySha256:c.bodySha256},estimatedCostUsd:'0.25',blockers:[]};}},
  });
  const readiness=(await runtime.serviceOptions.provider.capabilities()).find(c=>c.modelId===capability.modelId);
  assert.equal(readiness?.availability,'available','the exact injected fixture provider remains the readiness authority');
  const service=createCommandService({pool:db.pool,...runtime.serviceOptions});
  const send=(body:object)=>service.command(actor,{commandId:randomUUID(),...body});
  const {projectId}=await send({type:'project.create',name:'Synthetic authority, not H3 entitlement',brief:''});
  const shotId=(await send({type:'shot.create',projectId,title:'One',prompt:'Literal  request\n'})).resourceId!;
  await send({type:'shot.update',projectId,shotId,expectedRevision:1,patch:{controls:{modelId:capability.modelId}}});
  const reviewId=(await send({type:'generation.prepare',projectId,shotId,expectedRevision:2})).reviewId!;
  const agent={id:randomUUID(),kind:'agent' as const,projectIds:[projectId]};
  const submission={type:'generation.submit',commandId:randomUUID(),projectId,reviewId};
  await assert.rejects(service.command(agent,{type:'generation.approve',commandId:randomUUID(),projectId,reviewId,maxAttempts:1,maxCostUsd:'1'}),{code:'APPROVAL_FORBIDDEN'});
  await assert.rejects(service.command(agent,submission),{code:'APPROVAL_REQUIRED'});
  await assert.rejects(service.command({...agent,projectIds:[]},submission),{code:'FORBIDDEN'});
  await assert.rejects(send({type:'generation.approve',projectId,reviewId,maxAttempts:1,maxCostUsd:'0.24'}),{code:'BUDGET_EXCEEDED'});
  await send({type:'generation.approve',projectId,reviewId,maxAttempts:1,maxCostUsd:'0.25'});
  const receipt=await service.command(agent,submission);assert.deepEqual(await service.command(agent,submission),receipt);
  independent=new pg.Pool(db.config);
  const row=(await independent.query('SELECT * FROM flume.reviews WHERE id=$1',[reviewId])).rows[0];
  const state=(await independent.query('SELECT state FROM flume.worker_checkpoints WHERE attempt_id=$1',[receipt.attemptId])).rows[0].state;
  assert.equal(state.request.scope,config.runtime.scope);
  await assert.rejects(runtime.worker.provider.submit({key:state.id,request:{...state.request,scope:'openrouter/wrong-account/v1'}},new AbortController().signal),/REQUEST_SCOPE/);
  assert.equal(f.requests.length,0);
  await runDelivery(runtime.worker,{pollDelaySeconds:0});
  const posts=f.requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);
  assert.equal(posts[0].body,row.envelope.body);assert.equal(posts[0].authorization,'Bearer synthetic-runtime-key');
  const accepted=(await independent.query('SELECT provider_receipt FROM flume.attempts WHERE id=$1',[receipt.attemptId])).rows[0].provider_receipt;
  assert.equal(accepted.scope,config.runtime.scope);assert.equal(accepted.providerJobId,'synthetic-wiring-job');
  assert.equal((await independent.query('SELECT reserved_count FROM flume.approvals WHERE review_id=$1',[reviewId])).rows[0].reserved_count,1);
  await send({type:'shot.update',projectId,shotId,expectedRevision:2,patch:{prompt:'Later edit'}});
  assert.deepEqual(await service.command(agent,submission),receipt);
  const w=await service.getWorkspace(actor,projectId);
  assert.equal(w.attempts.length,1);assert.equal(w.takes.length,0);assert.equal(w.shots[0].selectedTakeId,null);
  assert.equal(JSON.stringify(w).includes('synthetic-runtime-key'),false);
  assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
 }finally{try{await independent?.end();}finally{try{await runtime?.close();}finally{await db.close();}}}
});

test('runtime requires explicit account scope for credential injection and forwards optional media paths',async()=>{
 const db=await ownedPostgres();let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined;
 try{
  await migrate(db.pool);
  await assert.rejects(async()=>{runtime=await createRuntime({pool:db.pool,mediaRoot:join(db.root,'unscoped'),autoStart:false,getApiKey:()=> 'synthetic-runtime-key'});},/explicit account scope/);
  for(const field of ['ffmpegPath','ffprobePath'] as const){
   await assert.rejects(async()=>{runtime=await createRuntime({pool:db.pool,mediaRoot:join(db.root,field),autoStart:false,mediaTools:{[field]:join(db.root,'missing-'+field)}});},{code:'ENOENT'});
  }
 }finally{try{await runtime?.close();}finally{await db.close();}}
});

test('runtime attaches exact configured scope, credential, retention decision and discovery without granting entitlement',async t=>{
 const f=await controlledProvider(t,{data:[model]}),db=await ownedPostgres();let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined;
 try{
  await migrate(db.pool);
  const configured=readLocalRuntimeConfiguration({FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/synthetic-account/v1',OPENROUTER_API_KEY:'synthetic-runtime-key',FLUME_H3_RETENTION_DECISION:'allow-temporary-retention'});
  runtime=await createRuntime({pool:db.pool,mediaRoot:join(db.root,'media'),autoStart:false,...configured.runtime,providerTransport:f.transport});
  assert.equal(f.requests.length,0,'construction itself does not discover or submit');
  await runtime.discover();
  assert.equal(f.requests.length,1,'configured discovery uses only the injected local transport');
  assert.equal(f.requests[0].authorization,undefined);
  const capabilities=await runtime.serviceOptions.provider.capabilities();
  assert.equal(capabilities[0].name,'LOCAL ONLY');assert.equal(capabilities[0].availability,'unknown');assert.equal(capabilities[0].blocker,null);
  const service=createCommandService({pool:db.pool,...runtime.serviceOptions});
  const send=(body:object)=>service.command(actor,{commandId:randomUUID(),...body});
  const {projectId}=await send({type:'project.create',name:'Configured, not entitled',brief:''});
  const shotId=(await send({type:'shot.create',projectId,title:'one',prompt:'Exact'})).resourceId!;
  const reviewId=(await send({type:'generation.prepare',projectId,shotId,expectedRevision:1})).reviewId!;
  const w=await service.getWorkspace(actor,projectId);
  assert.equal(w.reviews[0].estimatedCostUsd,'0.850000');assert.deepEqual(w.reviews[0].blockers.map(b=>b.code),['ENTITLEMENT_UNKNOWN']);
  await assert.rejects(send({type:'generation.approve',projectId,reviewId,maxAttempts:1,maxCostUsd:'1'}),{code:'GENERATION_BLOCKED'});
  await assert.rejects(send({type:'generation.submit',projectId,reviewId}),{code:'GENERATION_BLOCKED'});
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
  assert.equal(JSON.stringify(w).includes('synthetic-runtime-key'),false);
 }finally{try{await runtime?.close();}finally{await db.close();}}
});
