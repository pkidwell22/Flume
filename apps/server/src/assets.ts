import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { uuid,ServiceError } from './contracts.ts';
import type { OwnedAsset } from './ports.ts';
export const ownedAssetSchema=z.strictObject({id:uuid,projectId:uuid,filename:z.string().min(1).max(255).refine(v=>!/[\/\\\x00-\x1f]/.test(v)),kind:z.enum(['image','video']),origin:z.enum(['imported','generated','sample']),sha256:z.string().regex(/^[a-f0-9]{64}$/),storageKey:z.string().min(1).max(1024),mimeType:z.enum(['image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime']),byteSize:z.number().int().positive().max(268435456),width:z.number().int().positive().max(32768),height:z.number().int().positive().max(32768),durationSeconds:z.number().finite().positive().optional(),provenance:z.unknown().optional()}).refine(a=>a.mimeType.startsWith(a.kind+'/'),'Media kind must match verified MIME');
export function ownedAsset(r:any):OwnedAsset {return {id:r.id,projectId:r.project_id,filename:r.filename,kind:r.kind,origin:r.origin,sha256:r.sha256,storageKey:r.storage_key,mimeType:r.mime_type,byteSize:Number(r.byte_size),width:r.width,height:r.height,...(r.duration_seconds===null?{}:{durationSeconds:r.duration_seconds}),...(r.provenance===null?{}:{provenance:r.provenance})};}
export async function insertAsset(c:PoolClient,raw:OwnedAsset) {
 const a=ownedAssetSchema.parse(raw);
 const inserted=await c.query('INSERT INTO flume.assets (id,project_id,filename,kind,origin,sha256,storage_key,mime_type,byte_size,width,height,duration_seconds,provenance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',[a.id,a.projectId,a.filename,a.kind,a.origin,a.sha256,a.storageKey,a.mimeType,a.byteSize,a.width,a.height,a.durationSeconds??null,a.provenance??null]);
 return inserted.rows[0];
}
export async function getTakeAsset(c:Pick<Pool,'query'>,projectId:string,takeId:string) {
 const row=(await c.query('SELECT t.id AS take_id,t.shot_id,t.attempt_id,a.* FROM flume.takes t JOIN flume.assets a ON a.id=t.asset_id WHERE t.id=$1 AND t.project_id=$2',[takeId,projectId])).rows[0];
 if(!row)throw new ServiceError('TAKE_NOT_FOUND','Owned take not found.',404);
 return row;
}
