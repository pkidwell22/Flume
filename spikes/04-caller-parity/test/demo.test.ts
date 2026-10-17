import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { lstat,readFile,mkdtemp,mkdir,copyFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import pg from 'pg';

async function openReview(origin:string) {
  const page=await fetch(origin+'/');assert.equal(page.status,200);
  const html=await page.text();
  assert(!/id="(?:login|key)"|human-session\.txt/.test(html),'default demo must not deliver a key-entry form');
  assert.match(html,/Trusted local fixture review/);
  const {document}=parseHTML(html);
  const requests:string[]=[];
  const context=vm.createContext({document,crypto,fetch:(url:string,options:any={})=>{
    requests.push(url);
    assert(!options.headers?.authorization&&!options.headers?.cookie,'UI must not supply credentials');
    return fetch(origin+url,{...options,headers:{...options.headers,origin}});
  }});
  vm.runInContext(await (await fetch(origin+'/ui.js')).text(),context);
  const workflow=document.getElementById('workflow')!;
  for(let i=0;i<200&&workflow.hidden;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(workflow.hidden,false,'opening the default demo must automatically reach review');
  assert.deepEqual(requests,['/state'],'page open must only read state, never approve or submit');
  return {document,context};
}

test('owned demo publishes readiness only after HTTP works and SIGTERM removes its cluster',async t=>{
  assert(existsSync('demo.ts'),'owned demo launcher is missing');
  const child=fork('demo.ts',[],{silent:true});let logs='';
  child.stdout!.on('data',b=>logs+=b);child.stderr!.on('data',b=>logs+=b);
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve([code,signal])));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;
    for(const line of logs.split('\n').filter(line=>/^(IDENTITY|CLEANUP) verified:/.test(line)))console.log(line);
  });
  const ready:any=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`readiness timed out: ${logs}`)),15000);
    child.once('message',m=>{clearTimeout(timer);resolve(m);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(`demo exited: ${logs}`));});
  });
  assert.equal((await fetch(ready.origin+'/health')).status,200);
  const marker=JSON.parse(await readFile('output/demo.json','utf8'));assert.equal(marker.pid,child.pid);assert.equal(marker.origin,ready.origin);
  const mounted=await openReview(ready.origin);
  const state=await (await fetch(ready.origin+'/state')).json();
  assert.equal(state.canReview,true);assert.equal(state.selected_take,null);assert.deepEqual(state.attempts,[]);
  const identity=JSON.parse(logs.match(/IDENTITY verified: (\{[^\n]+\})/)![1]);
  assert.equal(identity.dataDirectory,path.join(ready.root,'d'));
  const db=new pg.Client({host:identity.socketDirectory,port:5432,user:'spike_owner',database:identity.database,ssl:false});
  try {
    await db.connect();
    const {rows:[target]}=await db.query("SELECT current_database() AS database,current_setting('data_directory') AS directory");
    assert.equal(target.database,identity.database);assert.equal(target.directory,identity.dataDirectory);
    for(const table of ['parity.inspections','parity.approvals','spike.reviews','spike.grants','spike.attempts','spike.reservations'])
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0,'page open must not grant or reserve authority');
    const {rows:[actor]}=await db.query("UPDATE parity.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE can_review RETURNING actor_id");
    assert.equal((await fetch(ready.origin+'/state')).status,200,'expired fixture session must not require manual reentry');
    await openReview(ready.origin); // Fresh entry after expiry, not just an existing page.
    const get=(id:string)=>mounted.document.getElementById(id)! as any;
    await get('inspect-look').onclick();assert.equal(get('approve').disabled,false);
    assert.equal((await db.query('SELECT actor_id FROM parity.inspections')).rows[0].actor_id,actor.actor_id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM spike.grants')).rows[0].n,0,'inspection is not approval');
    await get('approve').onclick();assert.match(get('message').textContent,/Plan approved/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM spike.reviews')).rows[0].n,1);
    assert.equal((await db.query('SELECT sum(reserved_count)::int AS n FROM spike.grants')).rows[0].n,0,'approval is not reservation');
    assert.equal((await db.query('SELECT selected_take FROM parity.plans')).rows[0].selected_take,null);
  } finally {await db.end();}
  await assert.rejects(lstat('output/human-session.txt'),{code:'ENOENT'});
  assert((await lstat('output/agent-session.txt')).mode%512===384);
  assert(!/Review key|human-session\.txt/.test(logs),'default demo must not send reviewers to a key file');
  assert(!/[a-f0-9]{64}/.test(logs),'demo logs must not expose credential values');
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
  if(filename==='human-session.txt') {
    const ready:any=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('legacy file blocked automatic entry')),15000);
      child.on('message',(m:any)=>{if(!m.observation){clearTimeout(timer);resolve(m);}});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('legacy file must not block startup'));});
    });
    await openReview(ready.origin);
    child.kill('SIGTERM');assert.deepEqual(await exit,[0,null]);
  } else {
    assert.deepEqual(await exit,[1,null]);assert.match(logs,/EEXIST/);assert.doesNotMatch(logs,/READY /);
  }
  // Propagate only the real runner's ownership/cleanup evidence, not key bytes.
  for(const line of logs.split('\n').filter(line=>/^(IDENTITY|CLEANUP) verified:/.test(line)))console.log(line);
  const listeners=observations.filter(o=>o.observation==='owned-listener');
  assert.equal(listeners.length,2,'both real listeners were acquired');
  for(const owned of listeners) {
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
