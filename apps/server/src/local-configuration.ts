import {isAbsolute} from 'node:path';
import {isPriorJobVerificationReference} from '@flume/providers';
import type {RuntimeOptions} from './runtime.ts';

/** Entry-point-only configuration. Does not load files, discover keys, or contact providers. */
export function readLocalRuntimeConfiguration(env:Readonly<Record<string,string|undefined>>):{
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
