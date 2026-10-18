import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {migrate} from '@flume/database';
import {ownedPostgres} from '../../../packages/database/test/owned-postgres.ts';
import {createProviderBridge} from '../src/provider-bridge.ts';
import {createMediaBridge} from '../src/media-bridge.ts';
import {createCommandService} from '../src/service.ts';
import {hash,sha256} from '../src/contracts.ts';
import {verifyReview} from '../src/generation.ts';
import {WorkspaceSchema} from '@flume/domain';
import {controlledProvider} from './provider-wiring-fixture.ts';

const model={id:'minimax/hailuo-3',name:'LOCAL TRANSPORT FIXTURE',supported_durations:[5,6],supported_resolutions:['2K'],supported_aspect_ratios:['16:9'],supported_frame_images:['first_frame','last_frame'],seed:false,generate_audio:false,pricing_skus:{duration_seconds:'0.17',reference_images:'0.021'}};
const actor={id:randomUUID(),kind:'operator' as const,projectIds:'*' as const};

test('owned frame compilation captures one price observation before asynchronous media preparation',async t=>{
 const f=await controlledProvider(t,{data:[model]}),db=await ownedPostgres();let media:Awaited<ReturnType<typeof createMediaBridge>>|undefined,release=()=>{},pending:Promise<any>|undefined;
 try{
  await migrate(db.pool);media=await createMediaBridge(join(db.root,'media'));
  const projectId=randomUUID(),assetId=randomUUID(),png=join(db.root,'owned-frame.png');
  execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=32x32','-frames:v','1','-threads','1',png]);
  await media.media.importLocal({id:assetId,projectId,filename:'owned-frame.png',mimeType:'image/png',bytes:await readFile(png)});
  let enter=()=>{},first=true;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
  const ownedStore=media.store;
  const store={...ownedStore,async openAsset(input:Parameters<typeof ownedStore.openAsset>[0]){if(first){first=false;enter();await gate;}return ownedStore.openAsset(input);}};
  const bridge=createProviderBridge(db.pool,store,'openrouter/fixture/v1',()=> 'synthetic-runtime-test-key',f.transport,{h3RetentionDecision:'allow-temporary-retention'});
  await bridge.discover();
  const shot={id:randomUUID(),projectId,title:'Owned same image, two roles',prompt:'Exact',revision:1,controls:{modelId:model.id,durationSeconds:5,resolution:'2K',aspectRatio:'16:9',generateAudio:false},bindings:{firstFrameAssetId:assetId,lastFrameAssetId:assetId},selectedTakeId:null,selectionRevision:0};
  pending=bridge.provider.prepare({projectId,shot,assets:[]});await entered;
  f.setCatalog({data:[{...model,pricing_skus:{...model.pricing_skus,duration_seconds:'0.31'}}]});await bridge.discover();
  release();const prepared=await pending;
  assert.equal(prepared.estimatedCostUsd,'0.892');assert.equal(prepared.estimate.bodySha256,prepared.envelope.bodySha256);
  assert.equal(JSON.parse(prepared.envelope.body).frame_images.length,2);
  assert.equal(prepared.estimate.lineItems[1].quantity,2);
  const later=await bridge.provider.prepare({projectId,shot,assets:[]});assert.equal(later.estimatedCostUsd,'1.592');
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
 }finally{release();await pending?.catch(()=>{});try{await media?.drain();}finally{await db.close();}}
});

test('missing, malformed, unknown-unit and failed catalog prices stay unknown rather than retaining a prior estimate',async t=>{
 const f=await controlledProvider(t,{data:[model]}),db=await ownedPostgres();let media:Awaited<ReturnType<typeof createMediaBridge>>|undefined;
 try{
  await migrate(db.pool);media=await createMediaBridge(join(db.root,'media'));
  const bridge=createProviderBridge(db.pool,media.store,'openrouter/fixture/v1',()=> 'synthetic-runtime-test-key',f.transport,{h3RetentionDecision:'allow-temporary-retention'});
  const shot={id:randomUUID(),projectId:randomUUID(),title:'Fixture',prompt:'Exact',revision:1,controls:{modelId:model.id,durationSeconds:5,resolution:'2K',aspectRatio:'16:9',generateAudio:false},bindings:{firstFrameAssetId:null,lastFrameAssetId:null},selectedTakeId:null,selectionRevision:0};
  const prepare=()=>bridge.provider.prepare({projectId:shot.projectId,shot,assets:[]});
  for(const [payload,status] of [
   [{data:[{...model,pricing_skus:undefined}]},200],
   [{data:[{...model,pricing_skus:{duration_seconds:0.17}}]},200],
   [{data:[{...model,pricing_skus:{...model.pricing_skus,unknown_fee:'0'}}]},200],
   [{data:[{...model,id:'another/model'}]},200],
   [{data:[model,model]},200],
   [{error:{message:'synthetic-runtime-test-key'}},503],
  ] as [unknown,number][]){
   f.setCatalog({data:[model]});await bridge.discover();assert.equal((await prepare()).estimatedCostUsd,'0.85');
   f.setCatalog(payload,status);await bridge.discover();const prepared=await prepare();
   assert.equal(prepared.estimatedCostUsd,null,'unknown/rejected observation must not reuse an earlier price');
   assert.equal(prepared.estimate,undefined);assert.ok(prepared.blockers.length>0);
   assert.equal(JSON.stringify(prepared).includes('synthetic-runtime-test-key'),false);
  }
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
 }finally{try{await media?.drain();}finally{await db.close();}}
});

test('catalog estimate is calculated from the compiled request and retains its policy/entitlement hold',async t=>{
 const f=await controlledProvider(t,{data:[model]});
 const db=await ownedPostgres();let media:Awaited<ReturnType<typeof createMediaBridge>>|undefined;
 try{
  await migrate(db.pool);media=await createMediaBridge(join(db.root,'media'));
  const calls=f.requests,transport=f.transport;
  const bridge=createProviderBridge(db.pool,media.store,'openrouter/synthetic-account/v1',()=> 'synthetic-runtime-test-key',transport,{h3RetentionDecision:'allow-temporary-retention'});
  await bridge.discover();
  const service=createCommandService({pool:db.pool,provider:bridge.provider,workerAvailable:true});
  const send=(body:object)=>service.command(actor,{commandId:randomUUID(),...body});
  const {projectId}=await send({type:'project.create',name:'Estimate wiring fixture',brief:''});
  const shotId=(await send({type:'shot.create',projectId,title:'Literal',prompt:'Exact  café 🟠\n'})).resourceId!;
  const reviewId=(await send({type:'generation.prepare',projectId,shotId,expectedRevision:1})).reviewId!;
  const row=(await db.pool.query('SELECT * FROM flume.reviews WHERE id=$1',[reviewId])).rows[0];
  assert.equal(row.estimated_cost_usd,'0.850000','uses catalog rate, not the helper fixture price');
  assert.equal(row.envelope.bodySha256,sha256(row.envelope.body));
  assert.equal(JSON.parse(row.envelope.body).prompt,'Exact  café 🟠\n');
  assert.ok(row.blockers.some((b:any)=>b.code==='ENTITLEMENT_UNKNOWN'));
  assert.equal(row.snapshot.estimate.bodySha256,row.envelope.bodySha256);
  assert.equal(row.snapshot.estimate.estimatedCostUsd,'0.85');
  assert.equal(row.snapshot.estimate.providerEnforcedSpendCap,false);
  assert.equal(row.snapshot.estimate.label,'Catalog-based estimate; not a quote or provider-enforced spend cap.');
  const workspace=WorkspaceSchema.parse(await service.getWorkspace(actor,projectId));
  assert.deepEqual(workspace.reviews[0].estimate,row.snapshot.estimate);
  assert.doesNotThrow(()=>verifyReview(row));
  assert.throws(()=>verifyReview({...row,estimated_cost_usd:'0.840000'}),{code:'REVIEW_INTEGRITY'},'persisted estimate amount belongs to the hash-bound snapshot');
  const wrongIdentity=structuredClone(row);wrongIdentity.snapshot.estimate.bodySha256='f'.repeat(64);
  wrongIdentity.request_hash=hash({snapshot:wrongIdentity.snapshot,envelope:wrongIdentity.envelope});
  assert.throws(()=>verifyReview(wrongIdentity),{code:'REVIEW_INTEGRITY'},'an internally hashed estimate still must match the exact compiled envelope');
  const shot=(await service.getWorkspace(actor,projectId)).shots[0];
  const prepared=await bridge.provider.prepare({projectId,shot,assets:[]});
  for(const changed of [
   {...prepared,estimatedCostUsd:'0.84'},
   {...prepared,estimate:{...prepared.estimate!,bodySha256:'f'.repeat(64)}},
   {...prepared,envelope:null},
  ]){
   const invalid=createCommandService({pool:db.pool,workerAvailable:true,provider:{...bridge.provider,async prepare(){return changed;}}});
   await assert.rejects(invalid.command(actor,{commandId:randomUUID(),type:'generation.prepare',projectId,shotId,expectedRevision:1}),{code:'PREPARATION_INTEGRITY'});
  }
  await assert.rejects(send({type:'generation.approve',projectId,reviewId,maxAttempts:1,maxCostUsd:'1'}),{code:'GENERATION_BLOCKED'});
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.attempts')).rows[0].n,0);
  assert.equal(JSON.stringify(workspace).includes('synthetic-runtime-test-key'),false);
 }finally{try{await media?.drain();}finally{await db.close();}}
});
