import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ff, FFMPEG, FFPROBE} from '../../../packages/media/test/support.ts';
import * as bridge from '../src/media-bridge.ts';

const projectId='10000000-0000-4000-8000-000000000001';
async function ownedDir(t:TestContext) {
 assert.ok(process.env.TMPDIR, 'explicit isolated TMPDIR required');
 const parent=await realpath(process.env.TMPDIR);
 assert.equal(process.env.TMPDIR,parent,'TMPDIR must be canonical');
 assert.equal(process.env.FLUME_TEST_SCRATCH_ALLOWED,parent,'explicit scratch authorization required');
 const dir=await mkdtemp(join(parent,'flume-media-bridge-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});await assert.rejects(stat(dir),{code:'ENOENT'});});
 return dir;
}
const quote=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
async function recordedTools(dir:string) {
 // Test-only exec wrappers preserve native process lifetime and exercise literal filenames.
 const tools=join(dir,"tools with spaces $literal;quote'");await mkdir(tools);
 const log=join(dir,'invocations');await writeFile(log,'');
 const paths={ffmpegPath:join(tools,'ffmpeg'),ffprobePath:join(tools,'ffprobe')};
 for (const [path,target,role] of [[paths.ffmpegPath,FFMPEG,'ffmpeg'],[paths.ffprobePath,FFPROBE,'ffprobe']]) {
  await writeFile(path,`#!/bin/sh\nprintf '%s\\n' ${quote(role)} >> ${quote(log)}\nexec ${quote(await realpath(target))} "$@"\n`,{mode:0o700});
 }
 return {paths,log};
}
async function assertBothTools(log:string) {
 const calls=(await readFile(log,'utf8')).trim().split('\n');
 assert.ok(calls.includes('ffmpeg'),'configured FFmpeg must execute');
 assert.ok(calls.includes('ffprobe'),'configured ffprobe must execute');
 await writeFile(log,'');
}

test('media tool defaults retain Homebrew and explicit fields resolve independently without path rewriting', () => {
 const resolve = bridge.resolveMediaToolPaths;
 assert.equal(typeof resolve, 'function', 'bridge needs an explicit media tool-path resolver');
 const defaults = {ffmpegPath:'/opt/homebrew/bin/ffmpeg',ffprobePath:'/opt/homebrew/bin/ffprobe'};
 assert.deepEqual(resolve(), defaults);
 assert.deepEqual(resolve({}), defaults);
 assert.deepEqual(resolve({ffmpegPath:undefined,ffprobePath:undefined}), defaults);
 assert.deepEqual(resolve({ffmpegPath:'/custom tools/ffmpeg'}), {...defaults,ffmpegPath:'/custom tools/ffmpeg'});
 assert.deepEqual(resolve({ffprobePath:'/custom tools/ffprobe'}), {...defaults,ffprobePath:'/custom tools/ffprobe'});
 const paths = {ffmpegPath:'/custom tools/ffmpeg',ffprobePath:'/custom tools/ffprobe'};
 const resolved = resolve(paths);
 assert.deepEqual(resolved, paths);
 paths.ffmpegPath = '/changed/ffmpeg';
 assert.equal(resolved.ffmpegPath, '/custom tools/ffmpeg');
});

test('media tool configuration rejects malformed values rather than repairing or falling back', () => {
 const resolve = bridge.resolveMediaToolPaths as (input:unknown) => unknown;
 for (const field of ['ffmpegPath','ffprobePath']) {
  for (const value of ['', ' ', 'ffmpeg', './ffmpeg', ' /bin/ffmpeg', '/bin/ffmpeg\0', '/bin/ffmpeg\n', null, 4, false, [], {}]) {
   assert.throws(() => resolve({[field]:value}), {name:'ZodError'}, `${field} must reject ${JSON.stringify(value)}`);
  }
 }
 for (const value of [null, 'ffmpeg', [], 4, {limits:{processTimeoutMs:120000}}, {root:'/other/store'}, {ffmpeg:'/bin/ffmpeg'}]) {
  assert.throws(() => resolve(value), {name:'ZodError'});
 }
});

test('explicit installed tools reach worker import, worker preparation and the local store', async t => {
 const dir=await ownedDir(t), {paths,log}=await recordedTools(dir);
 const input=join(dir,'synthetic.png');
 ff(['-f','lavfi','-i','testsrc2=size=64x48:rate=1','-frames:v','1','-update','1',input]);
 const bytes=await readFile(input), root=join(dir,'store');
 const b=await bridge.createMediaBridge(root,paths);
 try {
  // Caller mutation must not alter subsequent worker jobs.
  paths.ffmpegPath=join(dir,'missing');paths.ffprobePath=join(dir,'missing');
  const source=await b.media.importLocal({id:randomUUID(),projectId,filename:'synthetic.png',mimeType:'image/png',bytes});
  await assertBothTools(log);
  assert.equal(source.width,64);assert.equal(source.height,48);
  await b.media.verifyOwned(source);
  assert.deepEqual(await b.media.readOwned(source),bytes);
  const prepared=await b.store.prepareImage({projectId,assetId:randomUUID(),sourceAssetId:source.id,role:'first_frame',profile:{kind:'fit-png-v1',width:32,height:24,fit:'contain',background:'black'}});
  await assertBothTools(log);
  assert.equal(prepared.width,32);assert.equal(prepared.height,24);
  const inspection=await b.store.inspect({projectId,assetId:prepared.id});
  await assertBothTools(log);
  assert.equal(inspection.eof,'observed-clean-decode');assert.equal(inspection.frames.length,1);
 } finally {await b.drain();}
 assert.deepEqual(await readdir(join(root,'staging')),[]);
 await assert.rejects(stat(join(root,'.active-operation')),{code:'ENOENT'});
});

test('bridge rejects bad configuration before creating storage and rejects missing or non-executable tools without fallback', async t => {
 const dir=await ownedDir(t), paths={ffmpegPath:FFMPEG,ffprobePath:FFPROBE};
 const badConfig=join(dir,'bad-config');
 await assert.rejects(bridge.createMediaBridge(badConfig,{ffmpegPath:''}),{name:'ZodError'});
 await assert.rejects(stat(badConfig),{code:'ENOENT'});
 const nonExecutable=join(dir,'not-executable');await writeFile(nonExecutable,'owned fixture',{mode:0o600});
 for (const field of ['ffmpegPath','ffprobePath']) {
  for (const [path,code] of [[join(dir,'missing'),'ENOENT'],[dir,'INVALID_EXECUTABLE'],[nonExecutable,'INVALID_EXECUTABLE']]) {
   await assert.rejects(bridge.createMediaBridge(join(dir,randomUUID()),{...paths,[field]:path}),{code});
  }
 }
});

test('the unchanged Homebrew default and explicit installation symlinks produce the same full video decode', async t => {
 const dir=await ownedDir(t), video=join(dir,'synthetic.mkv');
 ff(['-f','lavfi','-i','testsrc2=size=64x48:rate=10','-frames:v','6','-c:v','ffv1','-level','3',video]);
 const bytes=await readFile(video), inspections=[];
 for (const tools of [undefined,{ffmpegPath:FFMPEG,ffprobePath:FFPROBE}]) {
  const root=join(dir,randomUUID()),b=await bridge.createMediaBridge(root,tools);
  try {
   const asset=await b.media.importLocal({id:randomUUID(),projectId,filename:'synthetic.mkv',mimeType:'video/x-matroska',bytes});
   const inspection=await b.store.inspect({projectId,assetId:asset.id});
   assert.equal(inspection.eof,'observed-clean-decode');assert.equal(inspection.frames.length,6);
   assert.ok(new Set(inspection.frames.map(f=>f.rgbSha256)).size>1,'source frames must differ');
   inspections.push(inspection);
   await assert.rejects(b.media.importLocal({id:randomUUID(),projectId,filename:'truncated.mkv',mimeType:'video/x-matroska',bytes:bytes.subarray(0,bytes.length-300)}),/MEDIA_PROCESS_FAILED|DECODE_DIAGNOSTIC/);
   await assert.rejects(b.media.importLocal({id:randomUUID(),projectId,filename:'unsupported.png',mimeType:'image/png',bytes:Buffer.from('<svg/>')}),{code:'UNSUPPORTED_MEDIA_BYTES'});
   await assert.rejects(b.store.prepareImage({projectId,assetId:randomUUID(),sourceAssetId:asset.id,role:'first_frame',profile:{kind:'fit-png-v1',width:8192,height:8192,fit:'contain',background:'black'}}),{code:'INVALID_IMAGE_PROFILE'});
   assert.deepEqual(await readdir(join(root,'records')),[`${asset.id}.json`]);
  } finally {await b.drain();}
  assert.deepEqual(await readdir(join(root,'staging')),[]);
  await assert.rejects(stat(join(root,'.active-operation')),{code:'ENOENT'});
 }
 assert.deepEqual(inspections[0],inspections[1]);
});

test('worker jobs fail closed when either explicitly configured executable disappears after bridge creation', async t => {
 const dir=await ownedDir(t);
 for (const field of ['ffmpegPath','ffprobePath'] as const) {
  const executable=join(dir,field);await symlink(field==='ffmpegPath'?FFMPEG:FFPROBE,executable);
  const root=join(dir,`${field}-store`),b=await bridge.createMediaBridge(root,{ffmpegPath:FFMPEG,ffprobePath:FFPROBE,[field]:executable});
  try {
   await unlink(executable);
   await assert.rejects(b.media.importLocal({id:randomUUID(),projectId,filename:'fixture.png',mimeType:'image/png',bytes:Buffer.from('not reached')}),{code:'MEDIA_JOB_FAILED'});
  } finally {await b.drain();}
  assert.deepEqual(await readdir(join(root,'records')),[]);
  assert.deepEqual(await readdir(join(root,'staging')),[]);
  await assert.rejects(stat(join(root,'.active-operation')),{code:'ENOENT'});
 }
});

test('configured executables that fail to start or exit unsuccessfully never publish media', async t => {
 const dir=await ownedDir(t), executable=join(dir,'failing-probe'), image=join(dir,'synthetic.png');
 ff(['-f','lavfi','-i','color=red:size=64x48','-frames:v','1','-update','1',image]);
 for (const [script,code] of [['#!/bin/sh\nexit 23\n','MEDIA_PROCESS_FAILED'],[`#!${join(dir,'missing-interpreter')}\n`,'PROCESS_START_FAILED']]) {
  await writeFile(executable,script,{mode:0o700});
  const root=join(dir,randomUUID()),b=await bridge.createMediaBridge(root,{ffmpegPath:FFMPEG,ffprobePath:executable});
  try {
   await assert.rejects(b.media.importLocal({id:randomUUID(),projectId,filename:'synthetic.png',mimeType:'image/png',bytes:await readFile(image)}),{code});
  } finally {await b.drain();}
  assert.deepEqual(await readdir(join(root,'records')),[]);
  assert.deepEqual(await readdir(join(root,'staging')),[]);
  await assert.rejects(stat(join(root,'.active-operation')),{code:'ENOENT'});
 }
});

test('configured native decode retains the bridge 20-second process bound and is reaped before drain completes', async t => {
 const dir=await ownedDir(t), executable=join(dir,'slow-ffmpeg'), pidFile=join(dir,'native-pid'), image=join(dir,'synthetic.png');
 // Use a finite, owned native source long enough to exceed the unchanged production deadline.
 await writeFile(executable,`#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec ${quote(await realpath(FFMPEG))} -hide_banner -nostdin -v warning -re -f lavfi -i testsrc2=size=64x48:rate=1 -t 30 -threads 1 -f null -\n`,{mode:0o700});
 ff(['-f','lavfi','-i','color=red:size=64x48','-frames:v','1','-update','1',image]);
 const root=join(dir,'store'),b=await bridge.createMediaBridge(root,{ffmpegPath:executable,ffprobePath:FFPROBE});
 const started=Date.now();
 try {
  await assert.rejects(b.media.importLocal({id:randomUUID(),projectId,filename:'synthetic.png',mimeType:'image/png',bytes:await readFile(image)}),{code:'PROCESS_TIMEOUT'});
 } finally {await b.drain();}
 const elapsed=Date.now()-started;
 assert.ok(elapsed>=19000&&elapsed<27000,'process must retain the bridge 20-second bound, not the media package default');
 const pid=Number(await readFile(pidFile,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>1);
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'owned native process must be gone');
 assert.deepEqual(await readdir(join(root,'records')),[]);
 assert.deepEqual(await readdir(join(root,'staging')),[]);
 await assert.rejects(stat(join(root,'.active-operation')),{code:'ENOENT'});
});
