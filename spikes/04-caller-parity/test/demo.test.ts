import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { lstat,readFile,mkdtemp,mkdir,copyFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

for(const filename of ['human-session.txt','agent-session.txt','demo.json']) test(`startup collision at ${filename} preserves acquired-resource ownership`,async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'parity-start-'));
  const cleanup:(()=>Promise<unknown>)[]=[()=>rm(directory,{recursive:true,force:true})];
  t.after(async()=>{const errors=[];for(const close of cleanup.reverse()){try{await close();}catch(error){errors.push(error);}}assert.deepEqual(errors,[]);});
  const output=path.join(directory,'output');await mkdir(output);
  await copyFile('output/catalog.json',path.join(output,'catalog.json'));
  const sentinel=`SENTINEL ${filename}`;await writeFile(path.join(output,filename),sentinel,{flag:'wx',mode:0o600});
  const child=fork(new URL('../demo.ts',import.meta.url),[],{cwd:directory,silent:true,execArgv:['--import',new URL('./demo-observe.mjs',import.meta.url).href]});
  let logs='';const observations:any[]=[];
  child.stdout!.on('data',b=>logs+=b);child.stderr!.on('data',b=>logs+=b);child.on('message',m=>observations.push(m));
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve([code,signal])));
  cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;});
  assert.deepEqual(await exit,[1,null]);assert.match(logs,/EEXIST/);assert.doesNotMatch(logs,/READY /);
  // Propagate only the real runner's ownership/cleanup evidence, not key bytes.
  for(const line of logs.split('\n').filter(line=>/^(IDENTITY|CLEANUP) verified:/.test(line)))console.log(line);
  assert.equal(observations.length,2,'both real listeners were acquired before the collision');
  assert(observations.every(o=>o.observation==='owned-listener'));
  for(const owned of observations) {
    assert.throws(()=>process.kill(owned.pgPid,0),{code:'ESRCH'});
    await assert.rejects(lstat(owned.root),{code:'ENOENT'});
    await assert.rejects(fetch(owned.origin+'/health'));
  }
  assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
  for(const file of ['demo.json','human-session.txt','agent-session.txt','demo.lock']) {
    if(file!==filename)await assert.rejects(lstat(path.join(output,file)),{code:'ENOENT'});
  }
  const preserved=await readFile(path.join(output,filename),'utf8').catch(error=>{assert.equal(error.code,'ENOENT');return null;});
  assert.equal(preserved,sentinel,'pre-existing sentinel must survive exclusive-create failure');
});
