import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createMediaStore, MediaError, type Asset, type MediaStore, type StoreOptions } from '@flume/media';
import {Worker} from 'node:worker_threads';
import {AssetSchema} from '@flume/domain';
import {z} from 'zod';
import type {MediaJob} from './media-job.ts';
import type { OwnedMedia } from '@flume/worker';
import type { MediaPort, OwnedAsset } from './ports.ts';

export function toOwnedAsset(a:Asset):OwnedAsset {
 return {id:a.id,projectId:a.projectId,filename:a.filename,kind:a.kind,origin:a.origin,sha256:a.sha256,storageKey:a.id,
  mimeType:a.mimeType,byteSize:a.size,width:a.width,height:a.height,...(a.durationSeconds===undefined?{}:{durationSeconds:a.durationSeconds}),provenance:a.provenance};
}
export function toWorkerMedia(a:Asset):OwnedMedia {
 if(a.origin==='imported')throw new Error('Output must be generated or explicitly sample');
 return {assetId:a.id,storageKey:a.id,filename:a.filename,kind:a.kind,origin:a.origin,sha256:a.sha256,mimeType:a.mimeType,
  byteLength:a.size,width:a.width,height:a.height,...(a.durationSeconds===undefined?{}:{durationSeconds:a.durationSeconds}),provenance:a.provenance};
}
export type MediaToolPaths = Partial<Pick<StoreOptions,'ffmpegPath'|'ffprobePath'>>;
const executablePath=z.string().refine(path=>isAbsolute(path)&&!/[\x00-\x1f\x7f]/.test(path),'Absolute executable path required');
const mediaToolPathsSchema=z.object({
 ffmpegPath:executablePath.default('/opt/homebrew/bin/ffmpeg'),
 ffprobePath:executablePath.default('/opt/homebrew/bin/ffprobe'),
}).strict();
/** Trusted operator configuration only; no env/PATH lookup or shell command parsing. */
export function resolveMediaToolPaths(paths:MediaToolPaths={}):Pick<StoreOptions,'ffmpegPath'|'ffprobePath'> {
 return mediaToolPathsSchema.parse(paths);
}
export async function createMediaBridge(root:string,toolPaths:MediaToolPaths={}) {
 // The media package checks existence/executable bits and resolves installation symlinks.
 // Capture once for both the local store and every worker; callers cannot override bounds.
 const options:StoreOptions={root,...resolveMediaToolPaths(toolPaths),limits:{maxBytes:256*1024*1024,processTimeoutMs:20000,ingestTimeoutMs:25000}};
 const local=await createMediaStore(options);
 const active=new Set<Promise<Asset>>();
 const resultSchema=z.discriminatedUnion('ok',[
  z.object({ok:z.literal(true),asset:AssetSchema.extend({size:z.number().int().positive(),mimeType:z.string()})}).strict(),
  z.object({ok:z.literal(false),code:z.string().regex(/^[A-Z_]+$/)}).strict(),
 ]);
 function runJob(job:MediaJob):Promise<Asset>{
  const promise=new Promise<Asset>((resolve,reject)=>{
   const worker=new Worker(new URL('./media-job.ts',import.meta.url),{workerData:{options,job},execArgv:[]});
   let result:z.infer<typeof resultSchema>|undefined;
   worker.once('message',raw=>{try{result=resultSchema.parse(raw);}catch(error){reject(error);}});
   worker.once('error',reject);
   // Wait for actual worker exit, not merely an early message, before allowing shutdown/cleanup.
   worker.once('exit',code=>{if(code!==0||!result)reject(new MediaError('MEDIA_JOB_FAILED'));else if(result.ok)resolve(result.asset);else reject(new MediaError(result.code));});
  });
  active.add(promise);void promise.finally(()=>active.delete(promise)).catch(()=>{});return promise;
 }
 const store:MediaStore={...local,prepareImage:request=>runJob({kind:'prepare',request})};
 const media:MediaPort={
  async importLocal(input){
   const a=await runJob({kind:'import',...input,projectId:input.projectId.toLowerCase()});
   return toOwnedAsset(a);
  },
  async verifyOwned(a){
   const opened=await store.openAsset({projectId:a.projectId,assetId:a.id});
   try {
    if(opened.asset.sha256!==a.sha256||opened.size!==a.byteSize||opened.mimeType!==a.mimeType||opened.asset.origin!==a.origin||opened.asset.width!==a.width||opened.asset.height!==a.height)throw new Error('MEDIA_INTEGRITY');
   }finally{await opened.file.close();}
  },
  async readOwned(a){
   const opened=await store.openAsset({projectId:a.projectId,assetId:a.id});
   try{return await opened.file.readFile();}finally{await opened.file.close();}
  },
 };
 return {store,media,drain:async()=>{await Promise.allSettled([...active]);}};
}

/** Compilation reads owned stills without external upload or database locks. */
export async function resolveFrame(store:MediaStore,projectId:string,assetId:string|null,role:'first_frame'|'last_frame') {
 if(assetId===null)return null;
 const original=await store.openAsset({projectId,assetId});
 let width:number,height:number;
 try{if(original.asset.kind!=='image')throw new Error('FRAME_KIND');width=original.asset.width;height=original.asset.height;}finally{await original.file.close();}
 // Explicit role-specific preparation retains immutable source/hash provenance.
 const derivative=await store.prepareImage({projectId,assetId:randomUUID(),sourceAssetId:assetId,role,profile:{kind:'fit-png-v1',width,height,fit:'contain',background:'black'}});
 const prepared=await store.openAsset({projectId,assetId:derivative.id});
 try {
  if(prepared.size>12*1024*1024)throw new Error('FRAME_LIMIT');
  const bytes=await prepared.file.readFile();
  if(createHash('sha256').update(bytes).digest('hex')!==derivative.sha256)throw new Error('FRAME_INTEGRITY');
  return {assetId,url:`data:image/png;base64,${bytes.toString('base64')}`};
 }finally{await prepared.file.close();}
}
