import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { hash } from '../01-approved-attempt/dist/src/contracts.js';
import type { Experiment } from '../01-approved-attempt/dist/src/database.js';
import { digest,inspectVideo } from './media.ts';
export async function render(e:Experiment,storage:string,id:string,onInputHeld?:(child:ChildProcess)=>Promise<void>) {
  const {rows:[job]}=await e.pool.query("UPDATE parity.exports SET status='running' WHERE id=$1 AND status='queued' RETURNING *",[id]);
  if(!job) throw new Error('EXPORT_NOT_QUEUED');
  assert.equal(hash(job.snapshot),job.snapshot_hash);
  const input=path.join(storage,`${job.snapshot.take.sha256}.simulation`);
  const output=path.join(storage,`export-${id}.mp4`);
  try {
    await inspectVideo(input,job.snapshot.take.sha256);
    // Freeze bytes before starting I/O. A bounded pipe also gives tests a real
    // FFmpeg/input barrier; a tiny stream-copy may emit ONLY progress=end.
    const bytes=await readFile(input);assert.equal(digest(bytes),job.snapshot.take.sha256);
    const child=spawn('/opt/homebrew/bin/ffmpeg',['-hide_banner','-nostdin','-v','warning','-xerror','-n',
      '-i','pipe:0','-map','0:v:0','-c','copy','-map_metadata','-1','-movflags','+faststart',output],{stdio:['pipe','ignore','pipe']});
    let stderr='';child.stderr.on('data',b=>{stderr+=b;});
    const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    void exited.catch(()=>{});
    const feed=new Promise<void>((resolve,reject)=>{
      child.stdin.on('error',reject);
      child.once('error',reject);
      child.once('spawn',()=>{void (async()=>{
        child.stdin.write(bytes.subarray(0,32));
        await onInputHeld?.(child); // Test-only: EOF and media payload still withheld.
        child.stdin.end(bytes.subarray(32));
      })().then(resolve,reject);});
    });
    const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    try {
      await feed;const status=await exited;assert.equal(status,0);assert.equal(stderr,'');
    } finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');await exited.catch(()=>{});}
    const sha256=digest(await readFile(output));await inspectVideo(output,sha256);
    return (await e.pool.query("UPDATE parity.exports SET status='complete',output_sha256=$2 WHERE id=$1 RETURNING *",[id,sha256])).rows[0];
  } catch(error) {
    await rm(output,{force:true});await e.pool.query("UPDATE parity.exports SET status='failed' WHERE id=$1",[id]);throw error;
  }
}
