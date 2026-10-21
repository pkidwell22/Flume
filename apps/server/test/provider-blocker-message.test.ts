import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Pool} from 'pg';
import type {MediaStore} from '@flume/media';
import {VIDEO_PRIVACY_MESSAGE} from '@flume/providers';
import {createProviderBridge} from '../src/provider-bridge.ts';
import {readLocalRuntimeConfiguration} from '../src/local-configuration.ts';
import {sha256} from '../src/contracts.ts';
import type {Shot} from '../src/dto.ts';
const H3='minimax/hailuo-3',scope='retention-message-fixture';
const pool={async query(){throw new Error('No database access allowed');}} as unknown as Pool;
const media={} as MediaStore;
const shot:Shot={id:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222',title:'Fixture',prompt:'Synthetic fixture',revision:1,controls:{modelId:H3,durationSeconds:5,resolution:'2K',aspectRatio:'16:9',generateAudio:false},bindings:{firstFrameAssetId:null,lastFrameAssetId:null},selectedTakeId:null,selectionRevision:0};
function intent(){const body=JSON.stringify({model:H3,prompt:shot.prompt,duration:5,resolution:'2K',aspect_ratio:'16:9',generate_audio:false});return{key:'fixture',request:{provider:'openrouter',scope,modelId:H3,body,bodySha256:sha256(body)}};}
test('unconfigured generation reports configuration, not an account ZDR requirement',async t=>{
 const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('No network allowed');});
 for(const env of [{},{OPENROUTER_API_KEY:'synthetic-unused-key'}]){
  const config=readLocalRuntimeConfiguration(env);assert.equal(config.discover,false);
  const bridge=createProviderBridge(pool,media,scope,config.runtime.getApiKey,undefined,config.runtime.privacyPolicy);
  const [capability]=await bridge.provider.capabilities();
  assert.equal(capability.availability,'blocked');assert.match(capability.blocker!,/No generation credentials/);assert.doesNotMatch(capability.blocker!,/Zero Data Retention is required/);
  const prepared=await bridge.provider.prepare({projectId:shot.projectId,shot,assets:[]});assert.equal((prepared.blockers[0] as {code:string}).code,'PROVIDER_UNAVAILABLE');
 }
 assert.equal(network.mock.callCount(),0);
});
test('local H3 hold is labeled as local in capabilities and submit without lifting it',async t=>{
 const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('No network allowed');});
 const bridge=createProviderBridge(pool,media,scope,()=> 'synthetic-fixture-only');
 const [capability]=await bridge.provider.capabilities();assert.equal(capability.availability,'blocked');assert.match(capability.blocker!,/Flume.*local retention policy/);assert.match(capability.blocker!,/separate from.*OpenRouter/i);
 const result=await bridge.workerProvider.submit(intent(),new AbortController().signal);assert.equal(result.kind,'blocked');assert.ok('issue' in result);assert.equal(result.issue.code,'provider_privacy_blocked');assert.equal(result.issue.message,capability.blocker);assert.equal(network.mock.callCount(),0);
});
test('actual provider ZDR rejection remains a provider privacy error after local opt-in',async t=>{
 const network=t.mock.method(globalThis,'fetch',async()=>Response.json({error:{metadata:{reasons:[{code:'zdr-violation-by-account',count:1}]}}},{status:404}));
 const bridge=createProviderBridge(pool,media,scope,()=> 'synthetic-fixture-only',undefined,{h3RetentionDecision:'allow-temporary-retention'});
 const result=await bridge.workerProvider.submit(intent(),new AbortController().signal);assert.equal(result.kind,'blocked');assert.ok('issue' in result);assert.equal(result.issue.code,'zdr-violation-by-account');assert.equal(result.issue.message,VIDEO_PRIVACY_MESSAGE);assert.equal(network.mock.callCount(),1);
});
