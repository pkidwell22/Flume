import {isAbsolute,join} from 'node:path';
import {isPriorJobVerificationReference} from '@flume/providers';
import type {RuntimeOptions} from './runtime.ts';
import type {FrameModelConfiguration,ImageAuthoringConfiguration} from './authoring-runtime.ts';
import type {StoryboardPlannerConfiguration} from './storyboard-planner.ts';
import {DEFAULT_PLANNER_MAX_RESPONSE_CHARS,DEFAULT_PLANNER_MAX_TOKENS,DEFAULT_PLANNER_TIMEOUT_MS} from './storyboard-planner.ts';

/** Entry-point-only configuration. Does not load files, discover keys, or contact providers. */
function readRuntimeOnly(env:Readonly<Record<string,string|undefined>>):{
 runtime:Pick<RuntimeOptions,'scope'|'getApiKey'|'privacyPolicy'|'verificationReference'|'mediaTools'>;discover:boolean;
}{
 const mediaTools:NonNullable<RuntimeOptions['mediaTools']>={};
 for(const [variable,field] of [['FLUME_FFMPEG_PATH','ffmpegPath'],['FLUME_FFPROBE_PATH','ffprobePath']] as const){
  const value=env[variable];
  if(value!==undefined){
   if(!isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value))throw new Error(`${variable} must be an absolute executable path without control characters.`);
   mediaTools[field]=value;
  }
 }
 const mode=env.FLUME_PROVIDER_MODE??'edit-only';
 if(mode==='edit-only')return {runtime:{mediaTools},discover:false};
 if(mode!=='openrouter')throw new Error('FLUME_PROVIDER_MODE must be edit-only or openrouter.');
 const scope=env.FLUME_OPENROUTER_SCOPE;
 if(!scope||scope.length>200||/^openrouter\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.exec(scope)?.[0]!==scope)
  throw new Error('FLUME_OPENROUTER_SCOPE must be an explicit, stable, non-secret openrouter/account/version identity.');
 const decision=env.FLUME_H3_RETENTION_DECISION??'keep-blocked';
 if(decision!=='keep-blocked'&&decision!=='allow-temporary-retention')
  throw new Error('FLUME_H3_RETENTION_DECISION must be keep-blocked or allow-temporary-retention. This is not entitlement or spending approval.');
 // Captured in a closure, never returned as an enumerable value or logged. A key grants no policy exception.
 const key=env.OPENROUTER_API_KEY;
 // Optional, paired prior-job evidence pointer. It is not entitlement or approval and is
 // re-proven on every discovery; omission leaves every discovered route unknown.
 const verifiedModel=env.FLUME_OPENROUTER_VERIFIED_MODEL_ID;
 const verifiedJob=env.FLUME_OPENROUTER_VERIFIED_JOB_ID;
 if((verifiedModel===undefined)!==(verifiedJob===undefined))
  throw new Error('FLUME_OPENROUTER_VERIFIED_MODEL_ID and FLUME_OPENROUTER_VERIFIED_JOB_ID must be provided together; a partial reference is never inferred.');
 const verificationReference=verifiedModel===undefined?undefined:{modelId:verifiedModel,jobId:verifiedJob};
 if(verificationReference&&!isPriorJobVerificationReference(verificationReference))
  throw new Error('FLUME_OPENROUTER_VERIFIED_MODEL_ID and FLUME_OPENROUTER_VERIFIED_JOB_ID must be an exact catalog model id and exact provider job id; values are never trimmed, aliased or repaired.');
 return {runtime:{scope,getApiKey:()=>key,privacyPolicy:{h3RetentionDecision:decision},verificationReference,mediaTools},discover:true};
}


export interface LocalAuthoringConfiguration {
 stagingRoot: string | null;
 image: ImageAuthoringConfiguration;
}

const AUTHORING_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;
const AUTHORING_MONEY = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;

/**
 * Image authoring is opt-in and defaults to blocked. Nothing is enabled, estimated or dispatched
 * unless FLUME_IMAGE_AUTHORING_MODE=openrouter and literal model ids (plus optional exact estimates)
 * are configured. The credential stays inside a closure and is never enumerated or logged.
 */
export function readAuthoringConfiguration(env:Readonly<Record<string,string|undefined>>):LocalAuthoringConfiguration {
 const stagingRoot=env.FLUME_FRAME_STAGING_ROOT??(env.FLUME_DATA_DIR?join(env.FLUME_DATA_DIR,'frame-staging'):undefined);
 if(stagingRoot!==undefined&&(!isAbsolute(stagingRoot)||/[\x00-\x1f\x7f]/.test(stagingRoot)))
  throw new Error('FLUME_FRAME_STAGING_ROOT must be an absolute server-owned path without control characters.');
 // Opt-in wire route for newly compiled image requests. It selects no model, holds no price and
 // changes no spend guard; historical envelopes keep the endpoint they were compiled for.
 const transport=env.FLUME_IMAGE_AUTHORING_TRANSPORT??'chat-completions';
 if(transport!=='chat-completions'&&transport!=='images')
  throw new Error('FLUME_IMAGE_AUTHORING_TRANSPORT must be chat-completions or images.');
 const mode=env.FLUME_IMAGE_AUTHORING_MODE??'blocked';
 if(mode==='blocked')return {stagingRoot:stagingRoot??null,image:{mode:'blocked'}};
 if(mode!=='openrouter')throw new Error('FLUME_IMAGE_AUTHORING_MODE must be blocked or openrouter.');
 const scope=env.FLUME_OPENROUTER_SCOPE;
 if(!scope||!/^openrouter\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(scope))
  throw new Error('FLUME_OPENROUTER_SCOPE must be an explicit, stable, non-secret openrouter/account/version identity before image authoring is enabled.');
 const rawModels=env.FLUME_IMAGE_AUTHORING_MODELS;
 if(!rawModels)throw new Error('FLUME_IMAGE_AUTHORING_MODELS must be a JSON array of explicit image model declarations; no model is enabled by default.');
 let parsed:unknown;
 try{parsed=JSON.parse(rawModels);}catch{throw new Error('FLUME_IMAGE_AUTHORING_MODELS must be valid JSON.');}
 if(!Array.isArray(parsed)||parsed.length===0||parsed.length>200)throw new Error('FLUME_IMAGE_AUTHORING_MODELS must contain between 1 and 200 models.');
 const seen=new Set<string>();
 const models:FrameModelConfiguration[]=parsed.map((entry,index)=>{
  const row=entry as Record<string,unknown>|null;
  if(!row||typeof row!=='object'||Array.isArray(row))throw new Error(`FLUME_IMAGE_AUTHORING_MODELS[${index}] must be an object.`);
  const unknownKeys=Object.keys(row).filter(key=>!['modelId','name','aspectRatios','availability','blocker'].includes(key));
  if(unknownKeys.length)throw new Error(`FLUME_IMAGE_AUTHORING_MODELS[${index}] has unsupported keys.`);
  const modelId=row.modelId, name=row.name;
  if(typeof modelId!=='string'||!AUTHORING_MODEL_ID.test(modelId))throw new Error(`FLUME_IMAGE_AUTHORING_MODELS[${index}].modelId must be a literal provider/model id.`);
  if(seen.has(modelId))throw new Error(`FLUME_IMAGE_AUTHORING_MODELS repeats ${modelId}.`);
  seen.add(modelId);
  if(typeof name!=='string'||name.trim().length===0||name.length>200)throw new Error(`FLUME_IMAGE_AUTHORING_MODELS[${index}].name must be a display name.`);
  const availability=row.availability??'unknown';
  if(availability!=='available'&&availability!=='blocked'&&availability!=='unknown')
   throw new Error(`FLUME_IMAGE_AUTHORING_MODELS[${index}].availability must be available, blocked or unknown.`);
  const ratios=row.aspectRatios;
  if(ratios!==undefined&&(!Array.isArray(ratios)||ratios.length>24||!ratios.every(value=>typeof value==='string'&&/^\d{1,2}:\d{1,2}$/.test(value))))
   throw new Error(`FLUME_IMAGE_AUTHORING_MODELS[${index}].aspectRatios must be literal W:H values.`);
  if(row.blocker!==undefined&&row.blocker!==null&&typeof row.blocker!=='string')throw new Error(`FLUME_IMAGE_AUTHORING_MODELS[${index}].blocker must be text or null.`);
  return {
   modelId,name,availability,
   ...(Array.isArray(ratios)?{aspectRatios:ratios as string[]}:{}),
   ...(typeof row.blocker==='string'?{blocker:row.blocker}:{}),
  } as FrameModelConfiguration;
 });
 let estimatesUsd:Record<string,string>|undefined;
 const rawEstimates=env.FLUME_IMAGE_AUTHORING_ESTIMATES_USD;
 if(rawEstimates!==undefined){
  let estimates:unknown;
  try{estimates=JSON.parse(rawEstimates);}catch{throw new Error('FLUME_IMAGE_AUTHORING_ESTIMATES_USD must be valid JSON.');}
  if(!estimates||typeof estimates!=='object'||Array.isArray(estimates))throw new Error('FLUME_IMAGE_AUTHORING_ESTIMATES_USD must map model ids to exact USD amounts.');
  estimatesUsd={};
  for(const [modelId,value] of Object.entries(estimates as Record<string,unknown>)){
   if(!AUTHORING_MODEL_ID.test(modelId)||typeof value!=='string'||!AUTHORING_MONEY.test(value))
    throw new Error('FLUME_IMAGE_AUTHORING_ESTIMATES_USD must map literal model ids to literal USD amounts; unknown estimates are not inferred.');
   estimatesUsd[modelId]=value;
  }
 }
 const key=env.OPENROUTER_API_KEY;
 return {stagingRoot:stagingRoot??null,image:{mode:'openrouter',transport,models,...(estimatesUsd?{estimatesUsd}:{}),getApiKey:()=>key}};
}

const PLANNER_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;

/**
 * Storyboard planning is opt-in and defaults to blocked. A planner exists only when
 * FLUME_STORYBOARD_PLANNER_MODEL names a literal registered chat model id; provider credentials are
 * still read by the server entry point and never appear in this object.
 */
export function readStoryboardPlannerConfiguration(env:Readonly<Record<string,string|undefined>>):StoryboardPlannerConfiguration {
 const modelId=env.FLUME_STORYBOARD_PLANNER_MODEL;
 if(modelId===undefined||modelId==='')return {mode:'blocked'};
 if(!PLANNER_MODEL_ID.test(modelId))
  throw new Error('FLUME_STORYBOARD_PLANNER_MODEL must be a literal registered chat model id (provider/model); no model is enabled by default.');
 const bounded=(variable:string,fallback:number,min:number,max:number)=>{
  const raw=env[variable];
  if(raw===undefined)return fallback;
  const value=Number(raw);
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${variable} must be an integer between ${min} and ${max}.`);
  return value;
 };
 return {
  mode:'chat',modelId,
  maxTokens:bounded('FLUME_STORYBOARD_PLANNER_MAX_TOKENS',DEFAULT_PLANNER_MAX_TOKENS,128,4096),
  timeoutMs:bounded('FLUME_STORYBOARD_PLANNER_TIMEOUT_MS',DEFAULT_PLANNER_TIMEOUT_MS,1000,120000),
  maxResponseChars:bounded('FLUME_STORYBOARD_PLANNER_MAX_RESPONSE_CHARS',DEFAULT_PLANNER_MAX_RESPONSE_CHARS,2000,200000),
 };
}

/** Entry-point configuration plus the explicit image-authoring and planner blocks. */
export function readLocalRuntimeConfiguration(env:Readonly<Record<string,string|undefined>>) {
 return {...readRuntimeOnly(env),authoring:readAuthoringConfiguration(env),storyboard:readStoryboardPlannerConfiguration(env)};
}
