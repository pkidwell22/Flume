import type { Pool } from 'pg';
import { z } from 'zod';
import { createOpenRouterVideoProvider, compileVideoRequest, validateVideoIntent, VIDEO_PRIVACY_MESSAGE,
 type VideoCapability, type VideoReceipt, type ProviderProblem } from '@flume/providers';
import type { MediaStore } from '@flume/media';
import { generatedAssetId } from '@flume/media';
import type { ProviderPort as WorkerProvider, MediaPort as WorkerMedia, ProviderReceipt } from '@flume/worker';
import type { ProviderPort } from './ports.ts';
import { resolveFrame, toWorkerMedia } from './media-bridge.ts';
import { sha256 } from './contracts.ts';
import { createPhaseStore } from './phase-store.ts';

const H3='minimax/hailuo-3';
const h3:VideoCapability={modelId:H3,name:'Hailuo 3',durations:[5],resolutions:['2K'],aspectRatios:['16:9'],frameRoles:['first_frame','last_frame'],seedSupported:false,generateAudioSupported:false,availability:'blocked',blocker:VIDEO_PRIVACY_MESSAGE};
const bodySchema=z.object({model:z.string(),prompt:z.string(),duration:z.number(),resolution:z.string(),aspect_ratio:z.string(),generate_audio:z.boolean(),seed:z.number().optional(),
 frame_images:z.array(z.object({type:z.literal('image_url'),image_url:z.object({url:z.string()}).strict(),frame_type:z.enum(['first_frame','last_frame'])}).strict()).optional()}).strict();
const issue=(e:ProviderProblem)=>({code:e.providerCode==='zdr-violation-by-account'?'zdr-violation-by-account':e.code,message:e.message});
/** No environment or credential discovery. The local product intentionally supplies no key. */
export function createProviderBridge(pool:Pool,media:MediaStore,scope:string,getApiKey:()=>string|undefined=()=>undefined,transport?:{baseUrl:string;allowLoopbackHttpForTests:true}) {
 const adapter=createOpenRouterVideoProvider({getApiKey,fetch:globalThis.fetch,privacyBlockedModelIds:[H3],timeoutMs:10000,...transport,maxContentBytes:256*1024*1024,contentTimeoutMs:25000});
 const apiBase=transport?.baseUrl??'https://openrouter.ai/api/v1';
 let catalog:VideoCapability[]=[h3];
 const project=(c:VideoCapability)=>({modelId:c.modelId,name:c.name,durations:[...c.durations],resolutions:[...c.resolutions],frameRoles:c.frameRoles.map(r=>r==='first_frame'?'first':'last'),seedSupported:c.seedSupported,
  availability:c.modelId===H3?'blocked' as const:!getApiKey()?'blocked' as const:c.availability,
  blocker:c.modelId===H3?VIDEO_PRIVACY_MESSAGE:!getApiKey()?'No generation credentials are configured in this local session.':c.blocker});
 const provider:ProviderPort={
  async capabilities(){return catalog.map(project);},
  async prepare({projectId,shot}){
   const capability=catalog.find(c=>c.modelId===shot.controls.modelId);
   if(!capability)return {envelope:null,estimatedCostUsd:null,blockers:['The requested model is absent from the verified catalog. No fallback was selected.']};
   const blockers:{code:string;message:string}[]=[];
   const availability=project(capability);
   if(availability.blocker)blockers.push({code:capability.modelId===H3?'provider_privacy_blocked':'PROVIDER_UNAVAILABLE',message:availability.blocker});
   if(availability.availability==='unknown')blockers.push({code:'ENTITLEMENT_UNKNOWN',message:'Catalog presence does not establish entitlement. This route has not been verified.'});
   try{
    const firstFrame=await resolveFrame(media,projectId,shot.bindings.firstFrameAssetId,'first_frame');
    const lastFrame=await resolveFrame(media,projectId,shot.bindings.lastFrameAssetId,'last_frame');
    const frames={firstFrame,lastFrame};
    const errors=validateVideoIntent(shot,capability,frames);
    if(errors.length)return {envelope:null,estimatedCostUsd:null,blockers:[...blockers,...errors.map(e=>e.message)]};
    const compiled=compileVideoRequest(shot,capability,frames);
    return {envelope:{provider:compiled.provider,modelId:compiled.modelId,body:compiled.bodyJson,bodySha256:compiled.bodySha256},estimatedCostUsd:null,blockers};
   }catch{return {envelope:null,estimatedCostUsd:null,blockers:[...blockers,'Owned frame preparation failed. Keep the shot and inspect its imported images.']};}
  },
 };
 const toReceipt=async(r:ProviderReceipt):Promise<VideoReceipt>=>{
  if(r.provider!=='openrouter'||r.scope!==scope)throw new Error('RECEIPT_SCOPE');
  const row=(await pool.query("SELECT state FROM flume.worker_checkpoints WHERE state->'receipt'->>'providerJobId'=$1 AND state->'request'->>'scope'=$2",[r.providerJobId,scope])).rows[0];
  if(!row||row.state.request.modelId!==r.modelId)throw new Error('RECEIPT_IDENTITY');
  return {provider:'openrouter',modelId:r.modelId,jobId:r.providerJobId,bodySha256:row.state.request.bodySha256};
 };
 const workerProvider:WorkerProvider={
  async submit(intent,signal){
   if(intent.request.scope!==scope||intent.request.provider!=='openrouter')throw new Error('REQUEST_SCOPE');
   const body=bodySchema.parse(JSON.parse(intent.request.body));
   const result=await adapter.submit({provider:'openrouter',modelId:intent.request.modelId,body,bodyJson:intent.request.body,bodySha256:intent.request.bodySha256},{signal});
   if(result.status==='accepted')return {kind:'accepted',receipt:{provider:'openrouter',scope,modelId:result.receipt.modelId,providerJobId:result.receipt.jobId}};
   // Even anomalous acceptance evidence is retained by the coordinator, never replaced by another POST.
   if(result.receipt){
    const receipt={provider:'openrouter',scope,modelId:result.receipt.modelId,providerJobId:result.receipt.jobId};
    await createPhaseStore(pool).store.observeReceipt(intent.key,intent,receipt);
    return {kind:'blocked',issue:issue(result.error)};
   }
   return {kind:result.status==='blocked'?'blocked':result.status==='failed'?'rejected':'unknown',issue:issue(result.error)};
  },
  async status(receipt,signal){
   const result=await adapter.status(await toReceipt(receipt),{signal});
   if(result.status==='queued'||result.status==='running')return {kind:'running',receipt};
   if(result.status==='retrieving')return {kind:'succeeded',receipt};
   return {kind:result.status==='failed'?'failed':result.status==='blocked'?'blocked':'unavailable',issue:'error' in result?issue(result.error):{code:'STATUS_UNAVAILABLE',message:'Provider status unavailable.'}};
  },
  async outputs(receipt,signal){
   const result=await adapter.status(await toReceipt(receipt),{signal});
   if(result.status!=='retrieving')return {kind:'unavailable',issue:{code:'OUTPUTS_UNAVAILABLE',message:'The accepted video has no available content manifest.'}};
   return {kind:'outputs',receipt,outputs:result.outputs.map(o=>({outputId:String(o.index),url:`${apiBase}/videos/${encodeURIComponent(o.jobId)}/content?index=${o.index}`}))};
  },
 };
 const workerMedia:WorkerMedia={async ownOutput({projectId,receipt,output},signal){
  const videoReceipt=await toReceipt(receipt);
  // Status-produced indices are canonical decimal 0–7, not arbitrary or repaired IDs.
  if(!/^[0-7]$/.test(output.outputId))throw new Error('CONTENT_IDENTITY');
  const expected=`${apiBase}/videos/${encodeURIComponent(receipt.providerJobId)}/content?index=${output.outputId}`;
  if(output.url!==expected)throw new Error('CONTENT_IDENTITY');
  const remoteIdentity={provider:'openrouter',jobId:sha256(scope)+':'+receipt.providerJobId,outputId:output.outputId};
  const assetId=generatedAssetId(projectId,remoteIdentity);
  try{const opened=await media.openAsset({projectId,assetId});try{return toWorkerMedia(opened.asset);}finally{await opened.file.close();}}catch(e){if(!(e instanceof Error)||!('code'in e)||e.code!=='ENOENT')throw e;}
  const content=await adapter.readContent(videoReceipt,{kind:'openrouter_content',jobId:receipt.providerJobId,index:Number(output.outputId)},
   ({body,mimeType})=>media.importGeneratedOutput({projectId,filename:'generated-take.mp4',remoteIdentity,claimedMime:mimeType},body),{signal});
  if(content.status!=='read')throw new Error(content.error.code==='provider_authentication_required'?'PROVIDER_NOT_CONFIGURED':'CONTENT_UNAVAILABLE');
  return toWorkerMedia(content.value);
 }};
 return {provider,workerProvider,workerMedia,async discover(){const result=await adapter.discoverModels();if(result.status==='ok')catalog=result.capabilities.some(c=>c.modelId===H3)?result.capabilities:[h3,...result.capabilities];}};
}
