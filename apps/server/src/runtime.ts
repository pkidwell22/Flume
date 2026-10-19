import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { PgBossPhaseQueue, runWorker, type WorkerDependencies, type ProviderPort as WorkerProvider, type MediaPort as WorkerMedia } from '@flume/worker';
import { freezeExportSelection, type MediaStore } from '@flume/media';
import { createPhaseStore, createDispatchQueue } from './phase-store.ts';
import { createMediaBridge, toOwnedAsset, type MediaToolPaths } from './media-bridge.ts';
import { createProviderBridge } from './provider-bridge.ts';
import { createExportStore } from './export-store.ts';
import type { ProviderPort } from './ports.ts';

export interface RuntimeOptions {
 pool:Pool;mediaRoot:string;autoStart?:boolean;scope?:string;
 provider?:ProviderPort;workerProvider?:WorkerProvider;
 getApiKey?:Parameters<typeof createProviderBridge>[3];
 providerTransport?:Parameters<typeof createProviderBridge>[4];
 privacyPolicy?:Parameters<typeof createProviderBridge>[5];
 /** Server-only prior completed job evidence. Never exposed in public reads. */
 verificationReference?:Parameters<typeof createProviderBridge>[6];
 mediaTools?:MediaToolPaths;
 outputAdapter?:(store:MediaStore)=>WorkerMedia;
}
/** One API process supervises background phases; only the root launcher owns PostgreSQL. */
export async function createRuntime(options:RuntimeOptions){
 const {pool}=options;
 if(options.getApiKey&&(!options.scope||options.scope==='openrouter/local-unconfigured/v1'||/[\s\x00-\x1f\x7f]/.test(options.scope)))throw new Error('Provider credentials require an explicit account scope.');
 const {store:mediaStore,media,drain}=await createMediaBridge(options.mediaRoot,options.mediaTools);
 const scope=options.scope??'openrouter/local-unconfigured/v1';
 const bridge=createProviderBridge(pool,mediaStore,scope,options.getApiKey,options.providerTransport,options.privacyPolicy,options.verificationReference);
 const boss=new PgBoss({db:{executeSql:(text,values)=>pool.query(text,values)},schema:'flume_queue',supervise:true,schedule:false});
 boss.on('error',()=>{console.error('Queue supervision error; durable jobs retained.');});
 await boss.start();
 const controller=new AbortController();let loop:Promise<void>|undefined,exportLoop:Promise<void>|undefined;
 try{
  const queue=new PgBossPhaseQueue(boss);
  await boss.createQueue(queue.queueName,{policy:'standard',retryLimit:2,expireInSeconds:120,retentionSeconds:86400,deleteAfterSeconds:86400});
  const phase=createPhaseStore(pool);
  const activeMedia=new Set<Promise<unknown>>();
  const output=options.outputAdapter?.(mediaStore)??bridge.workerMedia;
  const worker:WorkerDependencies={store:phase.store,queue,provider:options.workerProvider??bridge.workerProvider,media:{ownOutput(input,signal){
   const work=output.ownOutput(input,signal);activeMedia.add(work);
   void work.finally(()=>activeMedia.delete(work)).catch(()=>{});return work;
  }}};
  const exports=createExportStore({pool,media});
  const owner=randomUUID();
  async function runExport(){
   const row=(await pool.query("SELECT id FROM flume.outbox WHERE kind='export' AND (state='pending' OR (state='running' AND lease_expires_at<clock_timestamp())) ORDER BY created_at,id LIMIT 1")).rows[0];
   if(!row)return false;
   const claimed=await exports.claim(row.id,owner);if(!claimed)return false;
   try{
    const s=claimed.snapshot;
    // Destination identity is deterministic and persisted export identity never changes.
    const frozen=freezeExportSelection({exportId:claimed.lease.exportId,assetId:claimed.lease.exportId,projectId:s.projectId,shotId:s.shotId,takeId:s.takeId,sourceAssetId:s.sourceAssetId,sourceSha256:s.sourceSha256,shotRevision:s.shotRevision,selectionRevision:s.selectionRevision,profile:'mp4-copy-v1'});
    const asset=await mediaStore.exportSelected(frozen);
    await exports.complete(claimed.lease,toOwnedAsset(asset));
   }catch{await exports.fail(claimed.lease,{code:'EXPORT_FAILED',message:'The frozen export could not be produced. The selected take and source media are unchanged.'});}
   return true;
  }
  if(options.autoStart!==false){
   loop=runWorker(worker,{signal:controller.signal,onError:()=>console.error('Generation phase interrupted; durable activation retained.'),idleDelayMs:250,operationTimeoutMs:90000});
   exportLoop=(async()=>{while(!controller.signal.aborted){try{await runExport();}catch{console.error('Export phase interrupted; durable work retained.');}await delay(250);}})();
  }
  let closing:Promise<void>|undefined;
  return {
   worker,mediaStore,boss,runExport,
   serviceOptions:{provider:options.provider??bridge.provider,queue:createDispatchQueue(pool,queue,scope),media,workerAvailable:true},
   discover:bridge.discover,
   close:()=>closing??=(async()=>{controller.abort();await Promise.all([loop,exportLoop]);await Promise.allSettled([...activeMedia]);await drain();await boss.stop();})(),
  };
 }catch(error){controller.abort();await Promise.allSettled([loop,exportLoop].filter(Boolean));await boss.stop();throw error;}
}
