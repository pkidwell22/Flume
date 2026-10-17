import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { startHttp } from '../http.ts';

function watchWorkers(t:any) {
  const pids:number[]=[], fork=childProcess.fork;
  t.mock.method(childProcess,'fork',(...args:any[])=>{
    const child=(fork as any)(...args);pids.push(child.pid);return child;
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  return pids;
}
async function approve(s:any) {
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:1,inspectionId:look.id});
}

test('concurrent identical HTTP submits coalesce the real queue read and worker start',async t=>{
  const {service:s,catalog,cleanup,fresh}=await setup(t);await approve(s);
  const pids=watchWorkers(t);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  let release!:()=>void, firstReady!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}), firstRead=new Promise<void>(r=>{firstReady=r;});
  let submits=0,queueQueries=0,reads=0;
  const wrapped={...s,
    async command(token:string,body:any){
      const result=await s.command(token,body);
      if(body.type==='submit'&&++submits===2) setImmediate(()=>{if(queueQueries<2)release();});
      return result;
    },
    async isQueued(id:string){
      queueQueries++;const queued=await s.isQueued(id); // Actual PG read, not a fake response.
      if(++reads===1)firstReady();if(reads===2)release();await gate;return queued;
    },
  };
  const api=await startHttp(wrapped,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});cleanup.push(()=>api.close());
  const timer=setTimeout(release,8000);t.after(()=>clearTimeout(timer));
  const command={type:'submit',revision:1,commandId:crypto.randomUUID()};
  const post=()=>fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${s.credentials.agent}`,'content-type':'application/json'},body:JSON.stringify(command)});
  const first=post();await firstRead;const second=post();
  const responses=await Promise.all([first,second]);assert(responses.every(r=>r.status===200));
  const receipts=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(receipts[0],receipts[1]);
  await api.idle();
  const state=await (await fetch(api.origin+'/state',{headers:{authorization:`Bearer ${s.credentials.agent}`}})).json();
  assert.deepEqual(state.interruptions,{},'duplicate dispatch must not record a false interruption');
  assert.equal(queueQueries,1,'one in-flight queue observation per attempt');
  assert.equal(pids.length,1,'exactly one real worker process starts');
  assert.equal(state.takes.length,2);assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].available,true);
  assert.equal((await fresh('SELECT sum(reserved_count)::int AS n FROM spike.grants'))[0].n,1);
  for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  // A completed receipt is still readable after editing, without another worker.
  await s.command(s.credentials.human,{type:'edit',revision:1,prompt:'Newer saved plan'});
  assert.deepEqual(await (await post()).json(),receipts[0]);await api.idle();assert.equal(pids.length,1);
});

test('a failed queue read releases the pending start for an exact receipt retry',async t=>{
  const {service:s,catalog,cleanup}=await setup(t);await approve(s);
  const pids=watchWorkers(t),provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  let reads=0;
  const wrapped={...s,async isQueued(id:string){const queued=await s.isQueued(id);if(++reads===1)throw new Error('READ_INTERRUPTED');return queued;}};
  const api=await startHttp(wrapped,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});cleanup.push(()=>api.close());
  const body={type:'submit',revision:1,commandId:crypto.randomUUID()};
  const post=()=>fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${s.credentials.agent}`,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post()).status,500);await api.idle();assert.equal(pids.length,0);
  const retry=await post();assert.equal(retry.status,200,'failed start must not poison future retries');await api.idle();
  assert.equal(reads,2);assert.equal(pids.length,1);assert.equal((await s.read(s.credentials.agent)).takes.length,2);
  for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('closing HTTP waits for a pending queue read without launching a late worker',async t=>{
  const {service:s,catalog,cleanup,fresh}=await setup(t);await approve(s);
  const pids=watchWorkers(t),provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  let release!:()=>void,ready!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}), entered=new Promise<void>(r=>{ready=r;});
  const wrapped={...s,async isQueued(id:string){const queued=await s.isQueued(id);ready();await gate;return queued;}};
  const api=await startHttp(wrapped,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});
  let closed=false;cleanup.push(async()=>{release();if(!closed)await api.close();});
  const response=fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${s.credentials.agent}`,'content-type':'application/json'},
    body:JSON.stringify({type:'submit',revision:1,commandId:crypto.randomUUID()})});void response.catch(()=>{});
  await entered;
  const closing=api.close().then(()=>{closed=true;});release();await closing;await Promise.allSettled([response]);
  assert.equal(pids.length,0,'shutdown must not launch a worker after taking its stop snapshot');
  assert.equal((await fresh('SELECT state FROM pgboss.job'))[0].state,'created','accepted work remains resumable');
  await assert.rejects(fetch(api.origin+'/health'));
});
