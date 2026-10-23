// Request-originated decoding/preparation runs in an isolated worker thread, not an HTTP handler.
// Only internal typed jobs arrive here; there is no public path/FFmpeg-command interface.
import {parentPort,workerData} from 'node:worker_threads';
import {createMediaStore,MediaError,type StoreOptions,type PrepareRequest,type FrameRequest} from '@flume/media';
export type MediaJob=
 | {kind:'import';id:string;projectId:string;filename:string;mimeType:string;bytes:Uint8Array}
 | {kind:'prepare';request:PrepareRequest}
 | {kind:'extract';request:FrameRequest};
const {options,job}:{options:StoreOptions;job:MediaJob}=workerData;
try{
 const store=await createMediaStore(options);
 const asset=job.kind==='prepare'?await store.prepareImage(job.request)
  :job.kind==='extract'?await store.extractFrame(job.request)
  :await store.importStream({assetId:job.id,projectId:job.projectId,filename:job.filename,origin:'imported',claimedMime:job.mimeType},(async function*(){yield job.bytes;})());
 parentPort!.postMessage({ok:true,asset});
}catch(error){parentPort!.postMessage({ok:false,code:error instanceof MediaError?error.code:'MEDIA_JOB_FAILED'});}
