import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { lstat,readFile } from 'node:fs/promises';

test('owned demo publishes readiness only after HTTP works and SIGTERM removes its cluster',async t=>{
  assert(existsSync('demo.ts'),'owned demo launcher is missing');
  const child=fork('demo.ts',[],{silent:true});let logs='';
  child.stdout!.on('data',b=>logs+=b);child.stderr!.on('data',b=>logs+=b);
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve([code,signal])));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;});
  const ready:any=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`readiness timed out: ${logs}`)),15000);
    child.once('message',m=>{clearTimeout(timer);resolve(m);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(`demo exited: ${logs}`));});
  });
  assert.equal((await fetch(ready.origin+'/health')).status,200);
  const marker=JSON.parse(await readFile('output/demo.json','utf8'));assert.equal(marker.pid,child.pid);assert.equal(marker.origin,ready.origin);
  assert((await lstat('output/human-session.txt')).mode%512===384);
  child.kill('SIGTERM');assert.deepEqual(await exit,[0,null]);
  assert.throws(()=>process.kill(ready.pgPid,0),{code:'ESRCH'});
  assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
  await assert.rejects(lstat(ready.root),{code:'ENOENT'});
  await assert.rejects(fetch(ready.origin+'/health'));
  for(const file of ['demo.json','human-session.txt','agent-session.txt','demo.lock']) await assert.rejects(lstat(`output/${file}`),{code:'ENOENT'});
});
