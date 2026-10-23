import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,readFile,readdir,realpath,stat,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixture,FFMPEG,FFPROBE,projectId} from '../../../packages/media/test/support.ts';
import {createChatVisualResolver} from '../src/chat-visual.ts';

const actor={id:'10000000-0000-4000-8000-000000000002',kind:'operator' as const,projectIds:[projectId]};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('chat visual resolver samples actual ordered endpoints from verified owned video bytes',async t=>{
 const f=await fixture(t),bytes=await readFile(f.video),sourceSha256=sha(bytes),assetId=randomUUID();
 const resolver=createChatVisualResolver({readMedia:async(received,id)=>{assert.deepEqual(received,actor);assert.equal(id,assetId);return{bytes,mimeType:'video/x-matroska',sha256:sourceSha256};},ffmpegPath:FFMPEG,ffprobePath:FFPROBE,scratchRoot:await realpath(process.env.TMPDIR!)});
 const result=await resolver(actor,{id:assetId,projectId,kind:'video',sha256:sourceSha256},new AbortController().signal);
 assert.equal(result.reference.kind,'video');assert.equal(result.reference.sampling,'uniform-frame-index-v1');assert.equal(result.reference.totalFrames,6);
 assert.deepEqual(result.reference.frames.map(frame=>frame.index),[0,1,2,3,4,5]);
 assert.deepEqual(result.reference.frames.map(frame=>frame.timestampSeconds),[0,.04,.16,.2,.4,.48]);
 assert.equal(result.images.length,6);assert.equal(result.reference.audio,'not-analyzed');
 for(const [index,image] of result.images.entries()){
  const png=Buffer.from(image.base64,'base64');assert.ok(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.equal(sha(png),result.reference.frames[index].sha256);
 }
 assert.equal(new Set(result.reference.frames.map(frame=>frame.sha256)).size,6);
});

test('chat visual resolver caps a 40-frame native clip at 16 increasing real-PTS samples including endpoints',async t=>{
 const f=await fixture(t),clip=join(f.dir,'forty.mkv');
 const {spawnSync}=await import('node:child_process');
 const made=spawnSync(FFMPEG,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=64x48:rate=25','-frames:v','40','-c:v','ffv1',clip]);
 assert.equal(made.status,0,made.stderr.toString());
 const bytes=await readFile(clip),sourceSha256=sha(bytes),assetId=randomUUID();
 const resolver=createChatVisualResolver({readMedia:async()=>({bytes,mimeType:'video/x-matroska',sha256:sourceSha256}),ffmpegPath:FFMPEG,ffprobePath:FFPROBE,scratchRoot:f.dir});
 const result=await resolver(actor,{id:assetId,projectId,kind:'video',sha256:sourceSha256},new AbortController().signal);
 assert.equal(result.reference.sourceSha256,sourceSha256);assert.equal(result.reference.totalFrames,40);assert.equal(result.reference.frames.length,16);
 assert.equal(result.reference.frames[0].index,0);assert.equal(result.reference.frames.at(-1)?.index,39);
 for(let i=1;i<result.reference.frames.length;i++)assert.ok(result.reference.frames[i].timestampSeconds>result.reference.frames[i-1].timestampSeconds);
});

test('verified native RGB bytes, not a second source selection, determine each scaled PNG',async t=>{
 const f=await fixture(t),bytes=await readFile(f.video),sourceSha256=sha(bytes),assetId=randomUUID(),wrapper=join(f.dir,'wrong-second-selection.cjs');
 await writeFile(wrapper,`#!${process.execPath}\nconst {readFileSync}=require('node:fs');const {spawnSync}=require('node:child_process');let args=process.argv.slice(2);const png=args.includes('png');if(png&&args.some(x=>x.includes('select=eq(n\\\\,')))args=args.map(x=>x.replace(/select=eq\\(n\\\\,\\d+\\)/,'select=eq(n\\\\,1)'));const input=args.includes('pipe:0')?readFileSync(0):undefined;const r=spawnSync(${JSON.stringify(FFMPEG)},args,{input,stdio:[input?'pipe':'ignore','inherit','inherit']});process.exit(r.status??1);\n`,{mode:0o700});
 const resolver=createChatVisualResolver({readMedia:async()=>({bytes,mimeType:'video/x-matroska',sha256:sourceSha256}),ffmpegPath:wrapper,ffprobePath:FFPROBE,scratchRoot:f.dir});
 const result=await resolver(actor,{id:assetId,projectId,kind:'video',sha256:sourceSha256},new AbortController().signal);
 const expected=ffScale(f.video,0);
 assert.equal(sha(Buffer.from(result.images[0].base64,'base64')),sha(expected));
});

function ffScale(path:string,index:number){
 const result=spawnSync(FFMPEG,['-hide_banner','-nostdin','-v','error','-threads','1','-filter_threads','1','-i',path,'-vf',`select=eq(n\\,${index}),format=rgb24,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgb24`,'-frames:v','1','-c:v','png','-threads','1','-f','image2pipe','-'],{maxBuffer:7*1024*1024});
 assert.equal(result.status,0,result.stderr.toString());return result.stdout as Buffer;
}

test('chat visual resolver refuses cross-project and source hash substitutions before sampling',async()=>{
 let reads=0;const bytes=Buffer.from('owned'),assetId=randomUUID(),sourceSha256=sha(bytes);
 const resolver=createChatVisualResolver({readMedia:async()=>{reads++;return{bytes,mimeType:'video/mp4',sha256:sourceSha256};},ffmpegPath:FFMPEG,ffprobePath:FFPROBE});
 await assert.rejects(resolver(actor,{id:assetId,projectId:randomUUID(),kind:'video',sha256:sourceSha256},new AbortController().signal),{code:'FORBIDDEN'});assert.equal(reads,0);
 const bad=createChatVisualResolver({readMedia:async()=>({bytes,mimeType:'video/mp4',sha256:'0'.repeat(64)}),ffmpegPath:FFMPEG,ffprobePath:FFPROBE});
 await assert.rejects(bad(actor,{id:assetId,projectId,kind:'video',sha256:sourceSha256},new AbortController().signal),{code:'VISUAL_SOURCE_INTEGRITY'});
});

test('chat visual resolver honors pre-cancellation without reading media',async()=>{
 let reads=0;const controller=new AbortController();controller.abort();
 const resolver=createChatVisualResolver({readMedia:async()=>{reads++;throw new Error('unreachable');},ffmpegPath:FFMPEG,ffprobePath:FFPROBE});
 await assert.rejects(resolver(actor,{id:randomUUID(),projectId,kind:'image',sha256:'0'.repeat(64)},controller.signal),{code:'VISUAL_CANCELLED'});assert.equal(reads,0);
});

test('chat visual resolver bounds admission including reads, refuses overflow, and removes a cancelled waiter',async()=>{
 const bytes=Buffer.from('not decoded'),sourceSha256=sha(bytes),started:string[]=[];
 const releases=new Map<string,()=>void>();let activeReads=0,maxActiveReads=0;
 const resolver=createChatVisualResolver({
  readMedia:async(_actor,id)=>{started.push(id);activeReads++;maxActiveReads=Math.max(maxActiveReads,activeReads);await new Promise<void>(resolve=>releases.set(id,resolve));activeReads--;return{bytes,mimeType:'image/png',sha256:sourceSha256};},
  ffmpegPath:FFMPEG,ffprobePath:FFPROBE,
 });
 const controllers=Array.from({length:7},()=>new AbortController());
 const ids=Array.from({length:7},()=>randomUUID());
 const jobs=ids.map((id,index)=>resolver(actor,{id,projectId,kind:'image',sha256:sourceSha256},controllers[index].signal));
 for(const job of jobs)void job.catch(()=>{});
 await sleep(30);
 assert.equal(started.length,2);assert.equal(maxActiveReads,2);
 await assert.rejects(jobs[6],{code:'VISUAL_BUSY'});
 controllers[2].abort();
 await assert.rejects(jobs[2],{code:'VISUAL_CANCELLED'});assert.ok(!started.includes(ids[2]));
 releases.get(ids[0])!();await assert.rejects(jobs[0]);
 for(let i=0;i<100&&!started.includes(ids[3]);i++)await sleep(5);
 assert.ok(started.includes(ids[3]));assert.ok(!started.includes(ids[2]));assert.ok(maxActiveReads<=2);
 for(const controller of controllers)controller.abort();
 for(const id of ids)releases.get(id)?.();
 await Promise.allSettled(jobs);
});

test('chat visual resolver applies one deadline while waiting to read and returns a privacy-safe code',async()=>{
 let reads=0;
 const resolver=createChatVisualResolver({readMedia:async()=>{reads++;await new Promise(()=>{});throw new Error('unreachable');},ffmpegPath:FFMPEG,ffprobePath:FFPROBE,deadlineMs:50});
 const started=Date.now();
 await assert.rejects(resolver(actor,{id:randomUUID(),projectId,kind:'image',sha256:'0'.repeat(64)},new AbortController().signal),{code:'VISUAL_DEADLINE'});
 assert.equal(reads,1);assert.ok(Date.now()-started<1000);
});

test('chat visual resolver deadline reaps native work and waits for worker-owned cleanup',async t=>{
 const f=await fixture(t),bytes=await readFile(f.video),sourceSha256=sha(bytes),pidFile=join(f.dir,'deadline.pid'),slow=join(f.dir,'deadline-ffmpeg');
 const quote=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
 await writeFile(slow,`#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec ${quote(await realpath(FFMPEG))} -hide_banner -nostdin -v warning -re -f lavfi -i testsrc2=size=64x48:rate=1 -t 30 -threads 1 -f null -\n`,{mode:0o700});
 const resolver=createChatVisualResolver({readMedia:async()=>({bytes,mimeType:'video/x-matroska',sha256:sourceSha256}),ffmpegPath:slow,ffprobePath:FFPROBE,scratchRoot:f.dir,deadlineMs:2000});
 await assert.rejects(resolver(actor,{id:randomUUID(),projectId,kind:'video',sha256:sourceSha256},new AbortController().signal),{code:'VISUAL_DEADLINE'});
 const pid=Number(await readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 assert.deepEqual((await readdir(f.dir)).filter(name=>name.startsWith('flume-chat-visual-')),[]);
});

test('chat visual resolver rejects oversized owned bytes before copying or spawning a worker',async t=>{
 const f=await fixture(t),bytes=new Uint8Array(32*1024*1024+1),sourceSha256=sha(bytes);
 const resolver=createChatVisualResolver({readMedia:async()=>({bytes,mimeType:'image/png',sha256:sourceSha256}),ffmpegPath:FFMPEG,ffprobePath:FFPROBE,scratchRoot:f.dir});
 await assert.rejects(resolver(actor,{id:randomUUID(),projectId,kind:'image',sha256:sourceSha256},new AbortController().signal),{code:'VISUAL_SOURCE_LIMIT'});
 assert.deepEqual((await readdir(f.dir)).filter(name=>name.startsWith('flume-chat-visual-')),[]);
});

test('chat visual resolver rejects a configured scratch symlink before reading owned bytes',async t=>{
 const f=await fixture(t),target=join(f.dir,'target'),link=join(f.dir,'linked-root');await mkdir(target);await symlink(target,link);
 let reads=0;
 const resolver=createChatVisualResolver({readMedia:async()=>{reads++;throw new Error('unreachable');},ffmpegPath:FFMPEG,ffprobePath:FFPROBE,scratchRoot:link});
 await assert.rejects(resolver(actor,{id:randomUUID(),projectId,kind:'image',sha256:'0'.repeat(64)},new AbortController().signal),{code:'VISUAL_SCRATCH_UNSAFE'});
 assert.equal(reads,0);
});

test('chat visual resolver decodes an actual JPEG into a verified PNG',async t=>{
 const f=await fixture(t),jpeg=join(f.dir,'source.jpg');
 const {spawnSync}=await import('node:child_process');
 const made=spawnSync(FFMPEG,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=blue:size=32x24','-frames:v','1','-update','1',jpeg]);
 assert.equal(made.status,0,made.stderr.toString());
 const bytes=await readFile(jpeg),sourceSha256=sha(bytes),assetId=randomUUID();
 const resolver=createChatVisualResolver({readMedia:async()=>({bytes,mimeType:'image/jpeg',sha256:sourceSha256}),ffmpegPath:FFMPEG,ffprobePath:FFPROBE,scratchRoot:f.dir});
 const result=await resolver(actor,{id:assetId,projectId,kind:'image',sha256:sourceSha256},new AbortController().signal);
 assert.equal(result.reference.kind,'image');assert.equal(result.images.length,1);
 assert.ok(Buffer.from(result.images[0].base64,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
});

test('chat visual resolver cancellation reaps an active native decoder and cleans owned scratch',async t=>{
 const f=await fixture(t),bytes=await readFile(f.video),sourceSha256=sha(bytes),assetId=randomUUID(),pidFile=join(f.dir,'decoder.pid'),slow=join(f.dir,'slow-ffmpeg');
 const quote=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
 await writeFile(slow,`#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec ${quote(await realpath(FFMPEG))} -hide_banner -nostdin -v warning -re -f lavfi -i testsrc2=size=64x48:rate=1 -t 30 -threads 1 -f null -\n`,{mode:0o700});
 const resolver=createChatVisualResolver({readMedia:async()=>({bytes,mimeType:'video/x-matroska',sha256:sourceSha256}),ffmpegPath:slow,ffprobePath:FFPROBE,scratchRoot:f.dir});
 const controller=new AbortController(),pending=resolver(actor,{id:assetId,projectId,kind:'video',sha256:sourceSha256},controller.signal);
 for(let i=0;i<100;i++){try{await stat(pidFile);break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
 const pid=Number(await readFile(pidFile,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>1);controller.abort();
 await assert.rejects(pending,{code:'VISUAL_CANCELLED'});assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 assert.deepEqual((await readdir(f.dir)).filter(name=>name.startsWith('flume-chat-visual-')),[]);
});

test('RGB-only scaling refuses conversion notices outside the verified source conversion stage',async t=>{
 const f=await fixture(t),bytes=await readFile(f.video),sourceSha256=sha(bytes),wrapper=join(f.dir,'phase-ffmpeg');
 const quote=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
 await writeFile(wrapper,`#!/bin/sh\nfor arg in "$@"; do\n if [ "$arg" = "pipe:0" ]; then\n printf '%s\\n' '[swscaler @ 0x123abc] No accelerated colorspace conversion found from yuv420p to rgb24.' >&2\n fi\ndone\nexec ${quote(await realpath(FFMPEG))} "$@"\n`,{mode:0o700});
 const resolver=createChatVisualResolver({readMedia:async()=>({bytes,mimeType:'video/x-matroska',sha256:sourceSha256}),ffmpegPath:wrapper,ffprobePath:FFPROBE,scratchRoot:f.dir});
 await assert.rejects(resolver(actor,{id:randomUUID(),projectId,kind:'video',sha256:sourceSha256},new AbortController().signal),{code:'DECODE_DIAGNOSTIC'});
});
