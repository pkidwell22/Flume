import type { Pool } from 'pg';
import { z } from 'zod';
import { createOpenRouterVideoProvider, compileVideoRequest, validateVideoIntent, estimateH3VideoCost, estimateWanVideoCost, VIDEO_PRIVACY_MESSAGE,
 isPriorJobVerificationReference, type VideoCapability, type VideoReceipt, type ProviderProblem, type VideoCatalogPricing,
 type H3VideoPricingMetadata, type WanVideoPricingMetadata, type PriorJobVerificationReference } from '@flume/providers';
import type { MediaStore } from '@flume/media';
import { generatedAssetId } from '@flume/media';
import type { ProviderPort as WorkerProvider, MediaPort as WorkerMedia, ProviderReceipt } from '@flume/worker';
import type { ProviderPort } from './ports.ts';
import { resolveFrame, toWorkerMedia } from './media-bridge.ts';
import { sha256 } from './contracts.ts';
import { createPhaseStore } from './phase-store.ts';

const H3='minimax/hailuo-3';
const WAN='alibaba/wan-2.7';
/** Server-injected retention decision for the historical H3 hold only, not entitlement or spending approval. */
export type ProviderBridgePrivacyPolicy={readonly h3RetentionDecision:'keep-blocked'|'allow-temporary-retention'};
/** Server-only pointer to one prior completed job. Never exposed in public capability or review DTOs. */
export type ProviderBridgeVerificationReference=PriorJobVerificationReference;
const bodySchema=z.object({model:z.string(),prompt:z.string(),duration:z.number(),resolution:z.string(),aspect_ratio:z.string(),generate_audio:z.boolean(),seed:z.number().optional(),
 frame_images:z.array(z.object({type:z.literal('image_url'),image_url:z.object({url:z.string()}).strict(),frame_type:z.enum(['first_frame','last_frame'])}).strict()).optional()}).strict();
const issue=(e:ProviderProblem)=>({code:e.providerCode==='zdr-violation-by-account'?'zdr-violation-by-account':e.code,message:e.message});
/** No environment or credential discovery. The caller must explicitly configure the getter. */
export function createProviderBridge(pool:Pool,media:MediaStore,scope:string,getApiKey:()=>string|undefined=()=>undefined,transport?:{baseUrl:string;allowLoopbackHttpForTests:true},privacyPolicy?:ProviderBridgePrivacyPolicy,verificationReference?:ProviderBridgeVerificationReference) {
 // Only this explicit decision lifts the local hold. A key or account setting is not consent.
 // Snapshot the decision so later caller mutation cannot split catalog and submit policy.
 const h3PrivacyBlocked=privacyPolicy?.h3RetentionDecision!=='allow-temporary-retention';
 if(verificationReference!==undefined&&!isPriorJobVerificationReference(verificationReference))
  throw new TypeError('verificationReference must be exactly one exact model id and one exact job id; values are never repaired.');
 // Snapshot exact identity. This grants no approval and is re-proven on every refresh.
 const verification=verificationReference===undefined?undefined:{modelId:verificationReference.modelId,jobId:verificationReference.jobId};
 // Only the currently proven single model, cleared at the start of every refresh.
 let verifiedModelId:string|null=null;
 const h3:VideoCapability={modelId:H3,name:'Hailuo 3',durations:[5],resolutions:['2K'],aspectRatios:['16:9'],frameRoles:['first_frame','last_frame'],seedSupported:false,generateAudioSupported:false,availability:h3PrivacyBlocked?'blocked':'unknown',blocker:h3PrivacyBlocked?VIDEO_PRIVACY_MESSAGE:null};
 const adapter=createOpenRouterVideoProvider({getApiKey,fetch:globalThis.fetch,timeoutMs:10000,...transport,...(verification?{verificationReference:verification}:{}),privacyBlockedModelIds:h3PrivacyBlocked?[H3]:[],maxContentBytes:256*1024*1024,contentTimeoutMs:25000});
 const apiBase=transport?.baseUrl??'https://openrouter.ai/api/v1';
 let catalog:VideoCapability[]=[h3];
 let pricing:VideoCatalogPricing[]=[];
 const project=(c:VideoCapability)=>{
  const privacy=c.modelId===H3&&h3PrivacyBlocked;
  const noKey=!getApiKey();
  // Precedence: explicit privacy hold, then missing credential, then a catalog-declared block,
  // then the single currently proven route. Everything else stays exactly as observed (unknown).
  const availability=privacy||noKey||c.availability==='blocked'?'blocked' as const
   :c.modelId===verifiedModelId?'available' as const:c.availability;
  return {modelId:c.modelId,name:c.name,durations:[...c.durations],resolutions:[...c.resolutions],aspectRatios:[...c.aspectRatios],frameRoles:c.frameRoles.map(r=>r==='first_frame'?'first':'last'),seedSupported:c.seedSupported,generateAudioSupported:c.generateAudioSupported,
   availability,
   blocker:privacy?VIDEO_PRIVACY_MESSAGE:noKey?'No generation credentials are configured in this local session.':c.blocker};
 };
 const provider:ProviderPort={
  async capabilities(){return catalog.map(project);},
  async prepare({projectId,shot}){
   const capability=catalog.find(c=>c.modelId===shot.controls.modelId);
   // Capture capability and price from one observation before owned-media awaits.
   const price=pricing.find(p=>p.modelId===shot.controls.modelId);
   if(!capability)return {envelope:null,estimatedCostUsd:null,blockers:['The requested model is absent from the verified catalog. No fallback was selected.']};
   const blockers:{code:string;message:string}[]=[];
   const availability=project(capability);
   if(availability.blocker)blockers.push({code:capability.modelId===H3&&h3PrivacyBlocked?'provider_privacy_blocked':'PROVIDER_UNAVAILABLE',message:availability.blocker});
   if(availability.availability==='unknown')blockers.push({code:'ENTITLEMENT_UNKNOWN',message:'Catalog presence does not establish entitlement. This route has not been verified.'});
   try{
    const firstFrame=await resolveFrame(media,projectId,shot.bindings.firstFrameAssetId,'first_frame');
    const lastFrame=await resolveFrame(media,projectId,shot.bindings.lastFrameAssetId,'last_frame');
    const frames={firstFrame,lastFrame};
    const errors=validateVideoIntent(shot,capability,frames);
    if(errors.length)return {envelope:null,estimatedCostUsd:null,blockers:[...blockers,...errors.map(e=>e.message)]};
    const compiled=compileVideoRequest(shot,capability,frames);
    // The pure estimators revalidate the complete untrusted SKU map; never prefilter it.
    // Pricing support is explicit per model; no generic model-pricing guesser is used.
    const estimate=compiled.modelId===WAN
     ?estimateWanVideoCost(compiled,capability,price as WanVideoPricingMetadata)
     :estimateH3VideoCost(compiled,capability,price as H3VideoPricingMetadata);
    // A Wan review without a price could otherwise be approved with an attempt-only allowance.
    // Require a known estimate for exactly Wan 2.7 before producing a review envelope.
    if(compiled.modelId===WAN&&estimate.status!=='estimated')
     return {envelope:null,estimatedCostUsd:null,blockers:[...blockers,{code:'WAN_ESTIMATE_UNKNOWN',
      message:`A known Wan 2.7 catalog estimate is required before review. The estimator returned unknown (${estimate.reason}).`}]};
    return {envelope:{provider:compiled.provider,modelId:compiled.modelId,body:compiled.bodyJson,bodySha256:compiled.bodySha256},
     estimatedCostUsd:estimate.estimatedCostUsd,...(estimate.status==='estimated'?{estimate}:{}),blockers};
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
 return {provider,workerProvider,workerMedia,async discover(){
  // Every refresh must re-prove the same exact prior job; a failed refresh cannot keep either
  // a previously verified route or a previously observed price.
  verifiedModelId=null;
  const result=await adapter.discoverModels();
  if(result.status==='ok'){
   catalog=result.capabilities.some(c=>c.modelId===H3)?result.capabilities:[h3,...result.capabilities];
   pricing=result.pricing;
   const evidence=result.verification;
   if(evidence?.status==='verified'&&verification&&evidence.modelId===verification.modelId&&evidence.jobId===verification.jobId&&
    catalog.some(c=>c.modelId===evidence.modelId)&&!(evidence.modelId===H3&&h3PrivacyBlocked)&&getApiKey())
    verifiedModelId=evidence.modelId;
  }else{catalog=[h3];pricing=[];} // A failed refresh cannot keep a previously observed price or route.
 }};
}
