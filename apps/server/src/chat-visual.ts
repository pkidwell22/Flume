import {createHash} from 'node:crypto';
import {lstat,mkdir,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {z} from 'zod';
import {actorSchema,authorize,uuid,type Actor} from './contracts.ts';

export type VisualReference={assetId:string;sourceSha256:string;kind:'image'|'video';durationSeconds:number|null;totalFrames:number;sampling:'uniform-frame-index-v1'|'still-image-v1';frames:Array<{index:number;timestampSeconds:number;sha256:string}>;audio:'not-analyzed'};
export type VisualImage={assetId:string;timestampSeconds:number;mimeType:'image/png';base64:string};
export type VisualResult={reference:VisualReference;images:VisualImage[]};
type Asset={id:string;projectId:string;kind:string;sha256?:string};
type ReadMedia=(actor:Actor,assetId:string)=>Promise<{bytes:Uint8Array;mimeType:string;sha256:string}>;
const absolute=z.string().refine(value=>isAbsolute(value)&&!/[\x00-\x1f\x7f]/.test(value));
const resultSchema=z.discriminatedUnion('ok',[
 z.object({ok:z.literal(false),code:z.string()}).strict(),
 z.object({ok:z.literal(true),inspection:z.object({kind:z.enum(['image','video']),durationSeconds:z.number().nonnegative(),audioStreams:z.number().int().nonnegative(),frames:z.array(z.object({index:z.number().int().nonnegative()}).passthrough()).min(1)}).passthrough(),images:z.array(z.object({assetId:z.string(),timestampSeconds:z.number().nonnegative(),mimeType:z.literal('image/png'),base64:z.string(),index:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(16)}).strict(),
]);
const sourceLimit=32*1024*1024;
const failure=(code:string,message:string)=>Object.assign(new Error(message),{code});
type Waiter={signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:Error)=>void;abort:()=>void};
function createGate(){
 let active=0;const waiting:Waiter[]=[];
 const admit=():void=>{while(active<2&&waiting.length){const waiter=waiting.shift()!;waiter.signal.removeEventListener('abort',waiter.abort);if(waiter.signal.aborted){waiter.reject(waiter.signal.reason);continue;}active++;waiter.resolve(release);}};
 const release=()=>{if(active<=0)throw new Error('Visual admission accounting underflow.');active--;admit();};
 return (signal:AbortSignal):Promise<()=>void>=>{
  if(signal.aborted)return Promise.reject(signal.reason);
  if(active<2){active++;return Promise.resolve(release);}
  if(waiting.length>=4)return Promise.reject(failure('VISUAL_BUSY','Visual resolver is busy.'));
  return new Promise((resolvePromise,reject)=>{const waiter:Waiter={signal,resolve:resolvePromise,reject,abort:()=>{const index=waiting.indexOf(waiter);if(index>=0)waiting.splice(index,1);reject(signal.reason);}};waiting.push(waiter);signal.addEventListener('abort',waiter.abort,{once:true});});
 };
}
async function safeScratchRoot(configuredRoot:string,explicit:boolean){
 if(explicit){let existing=configuredRoot;for(;;){try{await lstat(existing);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(existing);if(parent===existing)throw error;existing=parent;}}
  if((await realpath(existing))!==resolve(existing))throw failure('VISUAL_SCRATCH_UNSAFE','Visual scratch configuration is unsafe.');
 }
 await mkdir(configuredRoot,{recursive:true,mode:0o700});const canonical=await realpath(configuredRoot);
 if(explicit&&canonical!==configuredRoot)throw failure('VISUAL_SCRATCH_UNSAFE','Visual scratch configuration is unsafe.');
 return canonical;
}
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{if(signal.aborted)return Promise.reject(signal.reason);return new Promise((resolvePromise,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});promise.then(value=>{signal.removeEventListener('abort',abort);resolvePromise(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});}

export function createChatVisualResolver(options:{readMedia:ReadMedia;ffmpegPath:string;ffprobePath:string;scratchRoot?:string;deadlineMs?:number}) {
 const ffmpegPath=absolute.parse(options.ffmpegPath),ffprobePath=absolute.parse(options.ffprobePath);
 const configuredRoot=resolve(options.scratchRoot??tmpdir());
 const deadlineMs=z.number().int().positive().max(60_000).default(60_000).parse(options.deadlineMs),enter=createGate();
 return async (rawActor:Actor,asset:Asset,signal:AbortSignal):Promise<VisualResult>=>{
  const actor=actorSchema.parse(rawActor);uuid.parse(asset.id);uuid.parse(asset.projectId);authorize(actor,asset.projectId);
  if(signal.aborted)throw Object.assign(new Error('Visual resolution cancelled.'),{code:'VISUAL_CANCELLED'});
  if(!asset.sha256||!/^[a-f0-9]{64}$/.test(asset.sha256))throw Object.assign(new Error('Exact owned source hash is required.'),{code:'VISUAL_SOURCE_REQUIRED'});
  if(asset.kind!=='image'&&asset.kind!=='video')throw Object.assign(new Error('Unsupported visual reference kind.'),{code:'VISUAL_KIND'});
  const operation=new AbortController();let reason:Error|undefined;
  const cancel=(code:string,message:string)=>{if(!operation.signal.aborted){reason=failure(code,message);operation.abort(reason);}};
  const externalAbort=()=>cancel('VISUAL_CANCELLED','Visual resolution cancelled.');signal.addEventListener('abort',externalAbort,{once:true});
  // This timer owns the operation deadline, including while an injected media read is pending.
  // Keep it referenced until the resolver settles so cancellation cannot disappear with an idle loop.
  const deadlineAt=Date.now()+deadlineMs,deadline=setTimeout(()=>cancel('VISUAL_DEADLINE','Visual resolution deadline exceeded.'),deadlineMs);
  let leave:(()=>void)|undefined;
  try{return await new Promise<VisualResult>((resolvePromise,reject)=>{
   void (async()=>{
   try{
   leave=await enter(operation.signal);
   const scratchRoot=await abortable(safeScratchRoot(configuredRoot,options.scratchRoot!==undefined),operation.signal);
   const read=options.readMedia(actor,asset.id);let media:Awaited<ReturnType<ReadMedia>>;
   try{media=await abortable(read,operation.signal);}catch(error){if(operation.signal.aborted&&leave){const held=leave;leave=undefined;void read.finally(held).catch(()=>{});}throw error;}
   if(operation.signal.aborted)throw operation.signal.reason;
   if(media.bytes.byteLength<1||media.bytes.byteLength>sourceLimit)throw failure('VISUAL_SOURCE_LIMIT','Visual source exceeds the allowed size.');
   const actual=createHash('sha256').update(media.bytes).digest('hex');
   if(media.sha256!==asset.sha256||actual!==asset.sha256||!media.mimeType.startsWith(`${asset.kind}/`))throw failure('VISUAL_SOURCE_INTEGRITY','Owned source bytes failed integrity or kind checks.');
   if(operation.signal.aborted)throw operation.signal.reason;
   const bytes=Buffer.from(media.bytes);
   if(operation.signal.aborted)throw operation.signal.reason;
   const worker=new Worker(new URL('./chat-visual-job.ts',import.meta.url),{workerData:{bytes,assetId:asset.id,projectId:asset.projectId,sourceSha256:asset.sha256,mimeType:media.mimeType,ffmpegPath,ffprobePath,scratchRoot,deadlineAt},execArgv:[]});
   let settled=false,result:z.infer<typeof resultSchema>|undefined,protocolError:unknown;
   const finish=(error?:unknown,value?:VisualResult)=>{if(settled)return;settled=true;operation.signal.removeEventListener('abort',abortWorker);error?reject(error):resolvePromise(value!);};
   const abortWorker=()=>worker.postMessage('cancel');operation.signal.addEventListener('abort',abortWorker,{once:true});if(operation.signal.aborted)abortWorker();
   worker.once('message',raw=>{try{result=resultSchema.parse(raw);}catch(error){protocolError=error;worker.postMessage('cancel');}});
   worker.once('error',finish);
   worker.once('exit',code=>{
    if(settled)return;
    if(reason)return finish(reason);
    if(protocolError)return finish(protocolError);
    if(code!==0||!result)return finish(Object.assign(new Error('Visual worker failed.'),{code:'VISUAL_JOB_FAILED'}));
    if(!result.ok)return finish(Object.assign(new Error('Visual media was rejected.'),{code:result.code}));
    const frames=result.images.map(image=>({index:image.index,timestampSeconds:image.timestampSeconds,sha256:image.sha256}));
    if(result.inspection.kind!==asset.kind||frames[0].index!==0||frames.at(-1)!.index!==result.inspection.frames.length-1)return finish(Object.assign(new Error('Visual endpoint sampling mismatch.'),{code:'VISUAL_SAMPLING_INTEGRITY'}));
    finish(undefined,{reference:{assetId:asset.id,sourceSha256:asset.sha256!,kind:result.inspection.kind,durationSeconds:result.inspection.kind==='video'?result.inspection.durationSeconds:null,totalFrames:result.inspection.frames.length,sampling:result.inspection.kind==='video'?'uniform-frame-index-v1':'still-image-v1',frames,audio:'not-analyzed'},images:result.images.map(({assetId,timestampSeconds,mimeType,base64})=>({assetId,timestampSeconds,mimeType,base64}))});
   });
   }catch(error){reject(error);}
   })();
  });}finally{clearTimeout(deadline);signal.removeEventListener('abort',externalAbort);leave?.();}
 };
}
