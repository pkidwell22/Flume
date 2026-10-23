import type { PoolClient } from 'pg';
import type { CatalogEstimate } from '@flume/domain';
import type { Asset,Shot,Capability } from './dto.ts';
export type ProviderEnvelope={provider:string;modelId:string;body:string;bodySha256:string};
export type PreparedGeneration={envelope:ProviderEnvelope|null;estimatedCostUsd:string|null;estimate?:CatalogEstimate;blockers:(string|{code:string;message:string})[]};
export interface ProviderPort {
 capabilities():Promise<Capability[]>;
 /** Compile only: do not submit or upload in this operation. Called without a DB transaction. */
 prepare(input:{projectId:string;shot:Shot;assets:Asset[]}):Promise<PreparedGeneration>;
}
export type OwnedAsset={id:string;projectId:string;filename:string;kind:'image'|'video';origin:'imported'|'generated'|'sample';sha256:string;storageKey:string;mimeType:string;byteSize:number;width:number;height:number;durationSeconds?:number;provenance?:unknown};
export interface MediaPort {
 /** Bounded import into immutable owned storage; never upload externally. */
 importLocal(input:{id:string;projectId:string;filename:string;mimeType:string;bytes:Uint8Array}):Promise<OwnedAsset>;
 /** Verify cleanly decoded, immutable owned bytes and hash; no DB transaction is held. */
 verifyOwned(asset:OwnedAsset):Promise<void>;
 readOwned(asset:OwnedAsset):Promise<Uint8Array>;
 /** Derive an immutable endpoint image from an already-owned video. */
 extractFrame?(input:{id:string;projectId:string;sourceAssetId:string;frame:'first'|'last'}):Promise<OwnedAsset>;
}
export type QueueJob={id:string;kind:'generation'|'resume'|'export';resourceId:string;projectId:string;payload:Record<string,unknown>};
export interface TransactionalQueuePort {
 /** SQL only. Must use the supplied checked-out client; null/wrong IDs abort acceptance. */
 enqueue(client:PoolClient,job:QueueJob):Promise<string|null>;
}
export const durableOutboxQueue:TransactionalQueuePort={async enqueue(c,job){
 const result=await c.query('INSERT INTO flume.outbox (id,kind,resource_id,project_id,payload) VALUES ($1,$2,$3,$4,$5) RETURNING id',[job.id,job.kind,job.resourceId,job.projectId,job.payload]);
 return result.rows[0]?.id??null;
}};
export const blockedProvider:ProviderPort={
 async capabilities(){return [{modelId:'minimax/hailuo-3',name:'Hailuo 3',durations:[5],resolutions:['2K'],frameRoles:['first','last'],seedSupported:false,availability:'blocked',blocker:'Provider integration is not configured. Editing and local imports remain available.'}];},
 async prepare(){return {envelope:null,estimatedCostUsd:null,blockers:['Provider integration is not configured. No generation was submitted.']};}
};
