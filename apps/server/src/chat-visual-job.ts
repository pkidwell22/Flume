import {createHash,randomUUID} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {parentPort,workerData} from 'node:worker_threads';
import {cancelMediaProcesses,createMediaStore,MediaError,verifyNativeRgbFrame} from '@flume/media';

type Job={bytes:Uint8Array;mimeType:string;sourceSha256:string;assetId:string;projectId:string;ffmpegPath:string;ffprobePath:string;scratchRoot:string;deadlineAt:number};
const job:Job=workerData;
let child:ChildProcess|undefined,cancelled=false,cancellationDone=Promise.resolve();
const cancel=()=>{if(cancelled)return;cancelled=true;child?.kill('SIGKILL');cancellationDone=cancelMediaProcesses();};
parentPort!.on('message',message=>{if(message==='cancel')cancel();});
const deadlineTimer=setTimeout(cancel,Math.max(1,job.deadlineAt-Date.now()));deadlineTimer.unref();
const fail=(code:string):never=>{throw new MediaError(code);};
const check=()=>{if(cancelled)fail('VISUAL_CANCELLED');if(Date.now()>=job.deadlineAt){cancel();fail('VISUAL_DEADLINE');}};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const diagnostics=[
 /^\[swscaler @ 0x[0-9a-f]+\] No accelerated colorspace conversion found from yuv420p to rgb24\.$/,
 /^\[swscaler @ 0x[0-9a-f]+\] deprecated pixel format used, make sure you did set range correctly$/,
];

async function run(args:string[],cwd:string,stdin?:Buffer,policy:'strict'|'video'|'jpeg'='strict') {
 check();
 await new Promise<void>((resolve,reject)=>{
  const running=child=spawn(job.ffmpegPath,args,{cwd,shell:false,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',TMPDIR:cwd},stdio:[stdin?'pipe':'ignore','ignore','pipe']});
  const stderr:Buffer[]=[];let size=0,settled=false,failure:MediaError|undefined;
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);child=undefined;error?reject(error):resolve();};
  running.stderr!.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){failure??=new MediaError('PROCESS_DIAGNOSTIC_LIMIT');running.kill('SIGKILL');}else stderr.push(chunk);});
  running.once('error',()=>finish(new MediaError('PROCESS_START_FAILED')));
  running.once('close',code=>{
   if(cancelled)return finish(new MediaError('VISUAL_CANCELLED'));
   if(failure)return finish(failure);
   if(code!==0)return finish(new MediaError('MEDIA_PROCESS_FAILED'));
   const lines=Buffer.concat(stderr).toString().trim().split('\n').filter(Boolean);
   const allowed=policy==='video'?[diagnostics[0]]:policy==='jpeg'?[diagnostics[1]]:[];
   if(lines.some(line=>!allowed.some(pattern=>pattern.test(line))))return finish(new MediaError('DECODE_DIAGNOSTIC'));
   finish();
  });
  const timer=setTimeout(()=>{failure??=new MediaError(Date.now()>=job.deadlineAt?'VISUAL_DEADLINE':'PROCESS_TIMEOUT');running.kill('SIGKILL');},Math.min(20_000,Math.max(1,job.deadlineAt-Date.now())));
  if(stdin){running.stdin!.once('error',()=>{});running.stdin!.end(stdin);}
 });
 check();
}

let scratch='';
try{
 if(job.bytes.byteLength<1||job.bytes.byteLength>32*1024*1024)fail('VISUAL_SOURCE_LIMIT');
 if(sha(job.bytes)!==job.sourceSha256)fail('VISUAL_SOURCE_INTEGRITY');
 scratch=await mkdtemp(join(job.scratchRoot,'flume-chat-visual-'));
 check();
 const root=join(scratch,'store');await mkdir(root,{mode:0o700});
 check();
 const store=await createMediaStore({root,ffmpegPath:job.ffmpegPath,ffprobePath:job.ffprobePath,limits:{maxBytes:32*1024*1024,maxFrames:72_000,maxDurationSeconds:60,maxPixels:33_554_432,processTimeoutMs:20_000,ingestTimeoutMs:20_000,maxProcessOutputBytes:32*1024*1024}});
 check();
 const source=await store.importStream({assetId:randomUUID(),projectId:job.projectId,filename:'visual-source',origin:'imported',claimedMime:job.mimeType},(async function*(){yield job.bytes;})());
 check();
 if(source.sha256!==job.sourceSha256)fail('VISUAL_SOURCE_INTEGRITY');
 const inspection=await store.inspect({projectId:job.projectId,assetId:source.id});
 check();
 const count=Math.min(16,inspection.frames.length);
 const indices=count===1?[0]:Array.from({length:count},(_,i)=>Math.round(i*(inspection.frames.length-1)/(count-1)));
 const [timeNum,timeDen]=inspection.timeBase.split('/').map(Number);
 if(!Number.isSafeInteger(timeNum)||!Number.isSafeInteger(timeDen)||timeNum<=0||timeDen<=0)fail('UNKNOWN_TIMESTAMP');
 const input=join(root,'objects',source.sha256);
 const demux=({'image/png':'png_pipe','image/jpeg':'jpeg_pipe','image/webp':'webp_pipe','video/mp4':'mov','video/quicktime':'mov','video/webm':'matroska','video/x-matroska':'matroska'} as Record<string,string>)[source.mimeType];
 if(!demux)fail('UNSUPPORTED_MEDIA_BYTES');
 const images=[];let total=0;
 for(const index of indices){
  const native=join(scratch,`frame-${index}.rgb`),expected=inspection.frames[index];
  await run(['-hide_banner','-nostdin','-v','warning','-xerror','-max_alloc','134217728','-threads','1','-filter_threads','1','-filter_complex_threads','1','-n',
   '-protocol_whitelist','file,pipe','-probesize','5000000','-analyzeduration','10000000','-max_pixels','33554432','-f',demux,
   ...(demux==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[]),'-noautorotate','-i',input,'-map',`0:${inspection.streamIndex}`,'-an','-sn','-dn',
   '-vf',`select=eq(n\\,${index}),format=rgb24`,'-frames:v','1','-fps_mode','passthrough','-c:v','rawvideo','-pix_fmt','rgb24','-f','rawvideo','-fs',String(33_554_432*3+1),native],scratch,undefined,source.mimeType==='image/jpeg'?'jpeg':source.kind==='video'?'video':'strict');
  const nativeBytes=await readFile(native);
  if(nativeBytes.byteLength!==inspection.width*inspection.height*3)fail('VISUAL_NATIVE_SIZE');
  verifyNativeRgbFrame(nativeBytes,expected.rgbSha256);
  const output=join(scratch,`frame-${index}.png`);
  try{await run(['-hide_banner','-nostdin','-v','warning','-xerror','-max_alloc','134217728','-threads','1','-filter_threads','1','-filter_complex_threads','1','-n',
   '-protocol_whitelist','file,pipe','-f','rawvideo','-pixel_format','rgb24','-video_size',`${inspection.width}x${inspection.height}`,'-i','pipe:0','-an','-sn','-dn',
   '-vf','scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgb24','-frames:v','1','-c:v','png','-threads','1','-map_metadata','-1','-update','1','-fs',String(6*1024*1024+1),output],scratch,nativeBytes);}
  finally{await rm(native,{force:true});}
  const bytes=await readFile(output);total+=bytes.byteLength;if(!bytes.byteLength||total>6*1024*1024)fail('VISUAL_OUTPUT_LIMIT');
  check();
  const frame=inspection.frames[index],timestampSeconds=(Number(BigInt(frame.pts)-BigInt(inspection.originPts))*timeNum)/timeDen;
  if(!Number.isFinite(timestampSeconds)||timestampSeconds<0)fail('UNKNOWN_TIMESTAMP');
  images.push({assetId:job.assetId,timestampSeconds,mimeType:'image/png' as const,base64:bytes.toString('base64'),index,sha256:sha(bytes)});
 }
 parentPort!.postMessage({ok:true,inspection,images});
}catch(error){parentPort!.postMessage({ok:false,code:error instanceof MediaError?error.code:'VISUAL_JOB_FAILED'});}
finally{clearTimeout(deadlineTimer);await cancellationDone;if(scratch&&scratch.startsWith(`${job.scratchRoot}/flume-chat-visual-`))await rm(scratch,{recursive:true,force:true});parentPort!.close();}
