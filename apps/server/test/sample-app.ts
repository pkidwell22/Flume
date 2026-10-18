// Isolated full-product acceptance fixture. Never imported by production main.
// Real PostgreSQL, API, pg-boss, media, React app; only provider response is SAMPLE.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate } from '@flume/database';
import { ownedPostgres } from '../../../packages/database/test/owned-postgres.ts';
import { createRuntime } from '../src/runtime.ts';
import { createCommandService } from '../src/service.ts';
import { buildServer } from '../src/http.ts';
import { sha256 } from '../src/contracts.ts';
import { toWorkerMedia } from '../src/media-bridge.ts';

if(process.env.NODE_ENV!=='test'||process.env.FLUME_SAMPLE_ACCEPTANCE!=='owned-test-only')throw new Error('Explicit isolated sample acceptance required');
const db=await ownedPostgres();
let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined,app:Awaited<ReturnType<typeof buildServer>>|undefined;
try{
 await migrate(db.pool);const clip=join(db.root,'CONTROLLED-SAMPLE.mp4');
 execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-t','3','-threads','1','-c:v','libx264','-pix_fmt','yuv420p',clip]);
 const bytes=await readFile(clip);let posts=0;
 runtime=await createRuntime({pool:db.pool,mediaRoot:join(db.root,'media'),scope:'sample-acceptance-v1',
  provider:{async capabilities(){return [{modelId:'sample/local',name:'LOCAL SAMPLE — not generated',durations:[3],resolutions:['360p'],frameRoles:['first','last'],seedSupported:true,availability:'available',blocker:null}];},
   async prepare({shot}){const body=JSON.stringify(shot);return {envelope:{provider:'sample',modelId:shot.controls.modelId,body,bodySha256:sha256(body)},estimatedCostUsd:'0.00',blockers:[]};}},
  workerProvider:{async submit({request}){posts++;return {kind:'accepted',receipt:{provider:'sample',scope:request.scope,modelId:request.modelId,providerJobId:`SAMPLE-${posts}`}};},async status(receipt){return {kind:'succeeded',receipt};},async outputs(receipt){return {kind:'outputs',receipt,outputs:[{outputId:'sample',url:'https://sample.invalid/owned'}]};}},
  outputAdapter:store=>({async ownOutput({projectId,importKey},signal){signal.throwIfAborted();const id=importKey.slice(0,8)+'-'+importKey.slice(8,12)+'-4'+importKey.slice(13,16)+'-8'+importKey.slice(17,20)+'-'+importKey.slice(20,32);return toWorkerMedia(await store.importStream({projectId,assetId:id,filename:'CONTROLLED-SAMPLE-NOT-GENERATED.mp4',origin:'sample',claimedMime:'video/mp4'},(async function*(){yield bytes;})()));}}),
 });
 const origin='http://127.0.0.1:4320';
 app=await buildServer({service:createCommandService({pool:db.pool,...runtime.serviceOptions}),security:{mode:'local-operator',allowedHosts:['127.0.0.1:4320'],allowedOrigins:[origin]}});
 const dist=new URL('../../web/dist/',import.meta.url);
 app.get('/',async(_req,reply)=>reply.type('text/html').send(await readFile(new URL('index.html',dist))));
 app.get('/assets/:filename',async(req,reply)=>{const name=(req.params as {filename:string}).filename;if(!/^[A-Za-z0-9_-]+\.(js|css)$/.test(name))return reply.code(404).send();return reply.type(name.endsWith('.js')?'text/javascript':'text/css').send(await readFile(new URL(`assets/${name}`,dist)));});
 await app.listen({host:'127.0.0.1',port:4320});console.log(JSON.stringify({sampleAcceptance:true,url:origin,store:db.root,pid:process.pid}));
 await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
 console.log(JSON.stringify({samplePosts:posts}));
}finally{await app?.close();await runtime?.close();await db.close();}
