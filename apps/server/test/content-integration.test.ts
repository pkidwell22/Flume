import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {migrate} from '@flume/database';
import {runDelivery} from '@flume/worker';
import {ownedPostgres} from '../../../packages/database/test/owned-postgres.ts';
import {createRuntime} from '../src/runtime.ts';
import {createCommandService} from '../src/service.ts';
import {createProviderBridge} from '../src/provider-bridge.ts';
import {sha256} from '../src/contracts.ts';

test('controlled HTTP provider fixture: authenticated owned import rejects redirects and wrong MIME',async()=>{
 const db=await ownedPostgres();let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined;
 let posts=0,contentGets=0,redirectHits=0,redirect=false,wrongMime=false;const requests:{url:string;auth:string|undefined}[]=[];
 const sink=createServer((_q,r)=>{redirectHits++;r.end('must not receive credentials');});
 const file=join(db.root,'SAMPLE.mp4');
 let bytes:Buffer=Buffer.alloc(0);let baseUrl='';
 const upstream=createServer(async(q,r)=>{
  requests.push({url:q.url!,auth:q.headers.authorization});r.setHeader('Content-Type','application/json');
  if(q.method==='POST'){posts++;for await(const _ of q){}r.statusCode=202;r.end(JSON.stringify({id:`fixture-job-${posts}`,model:'fixture/model',status:'pending'}));return;}
  if(q.url?.includes('/content?index=0')){contentGets++;if(redirect){r.statusCode=302;r.setHeader('location',`http://127.0.0.1:${(sink.address() as {port:number}).port}/private`);r.end();return;}r.setHeader('Content-Type',wrongMime?'text/html':'video/mp4');r.end(bytes);return;}
  const job=q.url!.split('/').at(-1);r.end(JSON.stringify({id:job,model:'fixture/model',status:'completed',unsigned_urls:[`${baseUrl}/videos/${job}/content?index=0`]}));
 });
 try{
  execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=64x48:rate=10:duration=1','-c:v','libx264','-threads','1',file]);
  bytes=await readFile(file);
  sink.listen(0,'127.0.0.1');await once(sink,'listening');upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  baseUrl=`http://127.0.0.1:${(upstream.address() as {port:number}).port}/api/v1`;
  await migrate(db.pool);const scope='controlled-http-fixture-v1';
  runtime=await createRuntime({pool:db.pool,mediaRoot:join(db.root,'media'),scope,autoStart:false});
  const bridge=createProviderBridge(db.pool,runtime.mediaStore,scope,()=> 'SYNTHETIC-FIXTURE-KEY',{baseUrl,allowLoopbackHttpForTests:true});
  runtime.worker.provider=bridge.workerProvider;runtime.worker.media=bridge.workerMedia;
  const body=JSON.stringify({model:'fixture/model',prompt:'CONTROLLED SAMPLE',duration:1,resolution:'180p',aspect_ratio:'16:9',generate_audio:false});
  const service=createCommandService({pool:db.pool,...runtime.serviceOptions,provider:{async capabilities(){return [];},async prepare(){return {envelope:{provider:'openrouter',modelId:'fixture/model',body,bodySha256:sha256(body)},estimatedCostUsd:'0',blockers:[]};}}});
  const actor={id:randomUUID(),kind:'operator' as const,projectIds:'*' as const};const send=(c:object)=>service.command(actor,{commandId:randomUUID(),...c});
  const {projectId}=await send({type:'project.create',name:'CONTROLLED HTTP SAMPLE',brief:'No real provider calls'});
  const shotId=(await send({type:'shot.create',projectId,title:'Sample',prompt:'CONTROLLED SAMPLE'})).resourceId!;
  await send({type:'shot.update',projectId,shotId,expectedRevision:1,patch:{controls:{modelId:'fixture/model'}}});
  for(let n=0;n<3;n++){
   redirect=n===1;wrongMime=n===2;
   const {reviewId}=await send({type:'generation.prepare',projectId,shotId,expectedRevision:2});await send({type:'generation.approve',projectId,reviewId,maxAttempts:1,maxCostUsd:'0'});
   await send({type:'generation.submit',projectId,reviewId});
   for(let phase=0;phase<4;phase++)await runDelivery(runtime.worker,{pollDelaySeconds:0});
   const w=await service.getWorkspace(actor,projectId);
   assert.equal(w.attempts[n].status,n===0?'ready':'blocked',`content case ${n} must retain its expected outcome`);assert.equal(w.shots[0].selectedTakeId,null);assert.equal(w.takes.length,1);
  }
  assert.equal(posts,3);assert.equal(contentGets,3);assert.equal(redirectHits,0);
  assert.ok(requests.every(r=>r.auth==='Bearer SYNTHETIC-FIXTURE-KEY'));
 }finally{
  try{await runtime?.close();}finally{
   try{upstream.closeAllConnections();sink.closeAllConnections();await Promise.all([new Promise<void>(r=>upstream.close(()=>r())),new Promise<void>(r=>sink.close(()=>r()))]);}finally{await db.close();}
  }
 }
});
