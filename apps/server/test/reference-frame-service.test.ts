import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createCommandService} from '../src/service.ts';

const projectId='10000000-0000-4000-8000-000000000001',assetId='20000000-0000-4000-8000-000000000001',sourceSha='1'.repeat(64);
const actor={id:'30000000-0000-4000-8000-000000000001',kind:'operator' as const,projectIds:[projectId]};
const source={id:assetId,project_id:projectId,filename:'source.mp4',kind:'video',origin:'imported',sha256:sourceSha,storage_key:assetId,mime_type:'video/mp4',byte_size:100,width:64,height:48,duration_seconds:1,provenance:null};

function fakePool(inserted:any[]){
 const client={async query(query:string|{text:string;values?:unknown[]},params?:unknown[]){
  const sql=typeof query==='string'?query:query.text;params=typeof query==='string'?params:query.values;
  if(['begin','commit','rollback'].includes(sql.toLowerCase()))return{rows:[],rowCount:0};
  if(sql.includes("FROM flume.assets WHERE id=$1 AND project_id=$2 AND kind='video'"))return{rows:params?.[0]===assetId&&params?.[1]===projectId?[source]:[],rowCount:1};
  if(sql.startsWith('INSERT INTO flume.assets')){const row={...source,id:params![0],filename:params![2],kind:params![3],sha256:params![5],storage_key:params![6],mime_type:params![7],byte_size:params![8],duration_seconds:params![11],provenance:params![12]};inserted.push(row);return{rows:[row],rowCount:1};}
  throw new Error(`unexpected SQL: ${sql}`);
 },release(){}};
 return{query:client.query,async connect(){return client;}} as any;
}

test('service requires operator and registers only a verified source-bound endpoint image',async()=>{
 const inserted:any[]=[],calls:string[]=[],pool=fakePool(inserted);
 const media={importLocal:async()=>{throw new Error('unused');},readOwned:async()=>{throw new Error('unused');},async verifyOwned(a:any){calls.push(`verify:${a.id}`);},async extractFrame(input:any){calls.push(`extract:${input.sourceAssetId}:${input.frame}`);return{id:input.id,projectId:input.projectId,filename:'first-frame.png',kind:'image',origin:'imported',sha256:'2'.repeat(64),storageKey:input.id,mimeType:'image/png',byteSize:50,width:64,height:48,provenance:{kind:'extracted-frame',frame:input.frame,sourceAssetId:input.sourceAssetId,sourceSha256:sourceSha}};}};
 const service=createCommandService({pool,media:media as any});
 const result=await service.extractReferenceFrame(actor,{projectId,assetId,frame:'first'});
 assert.equal(result.kind,'image');assert.equal(inserted.length,1);assert.deepEqual(calls,[`verify:${assetId}`,`extract:${assetId}:first`,`verify:${result.id}`]);
 await assert.rejects(service.extractReferenceFrame({...actor,kind:'agent'},{projectId,assetId,frame:'last'}),{code:'OPERATOR_REQUIRED'});
 assert.equal(inserted.length,1);
});

test('service rejects cross-project and forged extraction provenance',async()=>{
 const pool=fakePool([]),media={importLocal:async()=>{throw 0;},readOwned:async()=>{throw 0;},verifyOwned:async()=>{},extractFrame:async(input:any)=>({id:randomUUID(),projectId:input.projectId,filename:'bad.png',kind:'image',origin:'imported',sha256:'2'.repeat(64),storageKey:'bad',mimeType:'image/png',byteSize:1,width:1,height:1,provenance:{kind:'extracted-frame',frame:input.frame,sourceAssetId:assetId,sourceSha256:sourceSha}})};
 const service=createCommandService({pool,media:media as any});
 await assert.rejects(service.extractReferenceFrame(actor,{projectId:randomUUID(),assetId,frame:'first'}),{code:'FORBIDDEN'});
 await assert.rejects(service.extractReferenceFrame(actor,{projectId,assetId,frame:'first'}),{code:'EXTRACTION_INTEGRITY'});
});
