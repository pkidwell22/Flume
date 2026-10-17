import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { startHttp } from '../http.ts';
import { launchWorker } from '../worker.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('mixed recovery cannot lose intent behind a false replay observation',async t=>{
  const {service:s,catalog,cleanup,fresh}=await setup(t);await approve(s);
  const command={type:'submit',revision:1,commandId:crypto.randomUUID()};
  const receipt=await s.command(s.credentials.agent,command);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const policy={origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'};
  const interrupted=launchWorker(policy,'intent');cleanup.push(()=>interrupted.stop());
  await interrupted.point('intent');await interrupted.stop();
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'active');
  const pids=watchWorkers(t),captured=deferred(),release=deferred(),recovered=deferred();
  let reads=0;
  const wrapped={...s,
    async isQueued(id:string){
      const queued=await s.isQueued(id);
      if(++reads===1){assert.equal(queued,false);captured.resolve();await release.promise;}
      return queued;
    },
    async command(token:Parameters<typeof s.command>[0],body:any,recover?:Parameters<typeof s.command>[2]){
      return s.command(token,body,async(id,reactivate)=>{
        const result=recover!(id,reactivate);recovered.resolve();return result;
      });
    },
  };
  const api=await startHttp(wrapped,policy);cleanup.push(()=>api.close());cleanup.push(async()=>release.resolve());
  const deadline=setTimeout(()=>release.resolve(),8000);t.after(()=>clearTimeout(deadline));
  const post=(body:any)=>fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${s.credentials.agent}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const replay=post(command);await captured.promise;
  const recovery=post({type:'recover',revision:1,attemptId:receipt.attemptId});await recovered.promise;
  // The recovery callback has reserved the dispatch boundary, but must not
  // mutate the job until the older observation is consumed. No timed sleep.
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'active',
    'reactivation must wait for the older queue decision');
  release.resolve();
  const responses=await Promise.all([replay,recovery]);assert(responses.every(r=>r.status===200));
  await api.idle();
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'completed',
    'explicit recovery must complete the same job without another command');
  const state=await s.read(s.credentials.agent);
  assert.equal(state.attempts[0].available,true);assert.equal(state.takes.length,2);
  assert.equal(reads,2,'recovery needs a fresh observation after the held false read');
  assert.equal(pids.length,1,'only one replacement worker starts');
  for(const table of ['spike.attempts','spike.reservations','spike.receipts','pgboss.job','recovery.dispatch'])
    assert.equal((await fresh(`SELECT count(*)::int n FROM ${table}`))[0].n,1);
  assert.equal((await fresh('SELECT key FROM recovery.dispatch'))[0].key,receipt.attemptId);
  assert.equal(provider.submits(),1);assert.equal(provider.jobs.size,1);
  for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

for(const first of ['replay','recover','recover-response'] as const) test(`overlapping recovery joins a newly valid worker: ${first}`,async t=>{
  const {service:s,e,catalog,cleanup,fresh}=await setup(t);await approve(s);
  const command={type:'submit',revision:1,commandId:crypto.randomUUID()};
  const receipt=await s.command(s.credentials.agent,command);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const policy={origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'};
  if(first!=='replay') {
    const interrupted=launchWorker(policy,'intent');cleanup.push(()=>interrupted.stop());
    await interrupted.point('intent');await interrupted.stop();
  }
  const captured=deferred(),release=deferred(),secondArrived=deferred(),activated=deferred(),responseHeld=deferred(),releaseResponse=deferred();
  const children:childProcess.ChildProcess[]=[],fork=childProcess.fork;
  t.mock.method(childProcess,'fork',(...args:any[])=>{
    if(!children.length)args[1]=[args[1][0],'after-fetch'];
    const child=(fork as any)(...args);children.push(child);
    child.on('message',(m:any)=>{if(m.point==='after-fetch')activated.resolve();});return child;
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  let reads=0,commands=0,reactivations=0;
  const fail=e.boss.fail.bind(e.boss);
  t.mock.method(e.boss,'fail',async(...args:any[])=>{reactivations++;return (fail as any)(...args);});
  const wrapped={...s,
    async isQueued(id:string){const queued=await s.isQueued(id);if(++reads===1){assert.equal(queued,true);captured.resolve();await release.promise;}return queued;},
    async command(token:Parameters<typeof s.command>[0],body:any,recover?:Parameters<typeof s.command>[2]){
      const number=++commands;if(number===2)secondArrived.resolve();
      const result=await s.command(token,body,recover);
      if(first==='recover-response'&&number===1){responseHeld.resolve();await releaseResponse.promise;}
      return result;
    },
  };
  const api=await startHttp(wrapped,policy);cleanup.push(()=>api.close());cleanup.push(async()=>{release.resolve();releaseResponse.resolve();});
  const deadline=setTimeout(()=>release.resolve(),8000);t.after(()=>clearTimeout(deadline));
  const post=(body:any)=>fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${s.credentials.agent}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const recovery={type:'recover',revision:1,attemptId:receipt.attemptId};
  const initial=post(first==='replay'?command:recovery);await captured.promise;
  if(first==='recover-response'){release.resolve();await responseHeld.promise;await activated.promise;}
  const joined=post(recovery);await secondArrived.promise;release.resolve();
  if(first==='recover-response'){await joined;releaseResponse.resolve();}
  const responses=await Promise.all([initial,joined]);assert(responses.every(r=>r.status===200));
  assert.equal(children.length,1,'overlapping recovery must not replace a newly valid worker');
  await activated.promise;
  assert.equal(children[0].signalCode,null,'the new activation must not be killed');
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'active');
  assert.equal(reactivations,first!=='replay'?1:0,'joining recovery must not invalidate the new activation');
  children[0].send({resume:true});await api.idle();
  const state=await (await fetch(api.origin+'/state',{headers:{authorization:`Bearer ${s.credentials.agent}`}})).json();
  assert.deepEqual(state.interruptions,{});assert.equal(state.attempts[0].available,true);assert.equal(state.takes.length,2);
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'completed');
  assert.equal((await fresh('SELECT sum(reserved_count)::int n FROM spike.grants'))[0].n,1);
  assert.equal(reads,1);assert.equal(provider.submits(),1);assert.equal(provider.jobs.size,1);
  for(const child of children)assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
});

test('recovery stops the previously owned worker before reactivating its job',async t=>{
  const {service:s,e,catalog,cleanup,fresh}=await setup(t);await approve(s);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const children:childProcess.ChildProcess[]=[],intent=deferred(),fork=childProcess.fork;
  t.mock.method(childProcess,'fork',(...args:any[])=>{
    if(!children.length)args[1]=[args[1][0],'intent'];
    const child=(fork as any)(...args);children.push(child);
    child.on('message',(m:any)=>{if(m.point==='intent')intent.resolve();});return child;
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  let reactivations=0,aliveAtReactivation=false;
  const fail=e.boss.fail.bind(e.boss);
  t.mock.method(e.boss,'fail',async(...args:any[])=>{
    try{process.kill(children[0].pid!,0);aliveAtReactivation=true;}catch(error){assert.equal((error as NodeJS.ErrnoException).code,'ESRCH');}
    reactivations++;return (fail as any)(...args);
  });
  const api=await startHttp(s,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});cleanup.push(()=>api.close());
  const post=(body:any)=>fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${s.credentials.agent}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const receipt=await (await post({type:'submit',revision:1,commandId:crypto.randomUUID()})).json();await intent.promise;
  // An unvalidated recovery must not be able to reach the worker owner callback.
  assert.equal((await post({type:'recover',revision:2,attemptId:receipt.attemptId})).status,409);
  assert.equal((await post({type:'recover',revision:1,attemptId:crypto.randomUUID()})).status,401);
  assert.equal((await post({type:'recover',revision:1,attemptId:receipt.attemptId,role:'human'})).status,400);
  assert.equal(reactivations,0);assert.equal(children[0].signalCode,null);process.kill(children[0].pid!,0);
  assert.equal((await post({type:'recover',revision:1,attemptId:receipt.attemptId})).status,200);
  assert.equal(aliveAtReactivation,false,'old worker must exit before queue reactivation');
  await api.idle();
  assert.equal(reactivations,1);assert.equal(children.length,2);
  const state=await s.read(s.credentials.agent);assert.equal(state.attempts[0].available,true);assert.equal(state.takes.length,2);
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'completed');
  assert.equal((await fresh('SELECT key FROM recovery.dispatch'))[0].key,receipt.attemptId);
  assert.equal(provider.submits(),1);assert.equal(provider.jobs.size,1);
  for(const child of children)assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
});

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
    async command(token:Parameters<typeof s.command>[0],body:any){
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
