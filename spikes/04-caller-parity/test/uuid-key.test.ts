import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { z } from 'zod';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { startHttp } from '../http.ts';
import { launchWorker } from '../worker.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function checkpoint(promise:Promise<unknown>) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CHECKPOINT_TIMEOUT')),8000);})]);}
  finally {clearTimeout(timer);}
}
function mixedCase(id:string) {
  let letters=0;return id.replace(/[a-f]/g,c=>letters++%2===0?c.toUpperCase():c);
}
async function approve(s:any) {
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:1,inspectionId:look.id});
}

for(const spelling of ['uppercase','mixed-case'] as const) test(`validated ${spelling} UUID recovers an HTTP-started interrupted worker`,async t=>{
  const {service:s,catalog,cleanup,fresh}=await setup(t);await approve(s);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const children:childProcess.ChildProcess[]=[],intent=deferred(),exited=deferred(),fork=childProcess.fork;
  t.mock.method(childProcess,'fork',(...args:any[])=>{
    if(!children.length)args[1]=[args[1][0],'intent'];
    const child=(fork as any)(...args);children.push(child);
    child.on('message',(m:any)=>{if(m.point==='intent')intent.resolve();});
    if(children.length===1)child.once('exit',()=>exited.resolve());return child;
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  let received:string|undefined;
  const wrapped={...s,async command(token:string,body:any,recover?:Parameters<typeof s.command>[2]){
    if(body.type==='recover')received=body.attemptId;
    return s.command(token,body,recover);
  }};
  const api=await startHttp(wrapped,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});
  cleanup.push(async()=>{await api.close();await assert.rejects(fetch(api.origin+'/health'));});
  const post=(body:any)=>fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${s.credentials.agent}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const accepted=await post({type:'submit',revision:1,commandId:crypto.randomUUID()});assert.equal(accepted.status,200);
  const receipt=await accepted.json();await checkpoint(intent.promise);
  children[0].kill('SIGKILL');await checkpoint(exited.promise);await api.idle();
  assert.equal(children[0].signalCode,'SIGKILL');assert.throws(()=>process.kill(children[0].pid!,0),{code:'ESRCH'});
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'active');
  const id=spelling==='uppercase'?receipt.attemptId.toUpperCase():mixedCase(receipt.attemptId);
  assert(z.uuid().safeParse(id).success);assert.notEqual(id,receipt.attemptId);
  if(spelling==='mixed-case'){assert.match(id,/[A-F]/);assert.match(id,/[a-f]/);}
  const response=await post({type:'recover',revision:1,attemptId:id});assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{attemptId:receipt.attemptId,jobId:receipt.jobId});
  assert.equal(received,id,'only the internal key is canonicalized, not the caller command');
  await api.idle();
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'completed',
    'valid UUID case variants must dispatch recovery of the original job');
  const state=await (await fetch(api.origin+'/state',{headers:{authorization:`Bearer ${s.credentials.agent}`}})).json();
  assert.deepEqual(state.interruptions,{});assert.equal(state.attempts[0].available,true);assert.equal(state.takes.length,2);
  assert.equal(children.length,2,'one interrupted worker and one replacement');
  for(const table of ['spike.attempts','spike.reservations','spike.receipts','pgboss.job','recovery.dispatch'])
    assert.equal((await fresh(`SELECT count(*)::int n FROM ${table}`))[0].n,1);
  assert.equal((await fresh('SELECT sum(reserved_count)::int n FROM spike.grants'))[0].n,1);
  assert.equal((await fresh('SELECT key FROM recovery.dispatch'))[0].key,receipt.attemptId);
  assert.equal(provider.submits(),1);assert.equal(provider.jobs.size,1);
  for(const child of children)assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
});

for(const window of ['queue-read','command-response'] as const) test(`mixed-case recovery shares the canonical caller generation: ${window}`,async t=>{
  const {service:s,e,catalog,cleanup,fresh}=await setup(t);await approve(s);
  const receipt=await s.command(s.credentials.agent,{type:'submit',revision:1,commandId:crypto.randomUUID()});
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const policy={origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'};
  const interrupted=launchWorker(policy,'intent');cleanup.push(()=>interrupted.stop());
  await interrupted.point('intent');await interrupted.stop();
  const captured=deferred(),release=deferred(),arrived=deferred(),activated=deferred(),held=deferred(),releaseResponse=deferred();
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
  const literalIds:string[]=[];
  const wrapped={...s,
    async isQueued(id:string){const queued=await s.isQueued(id);if(++reads===1){assert.equal(queued,true);captured.resolve();await release.promise;}return queued;},
    async command(token:string,body:any,recover?:Parameters<typeof s.command>[2]){
      literalIds.push(body.attemptId);const number=++commands;if(number===2)arrived.resolve();
      const result=await s.command(token,body,recover);
      if(window==='command-response'&&number===1){held.resolve();await releaseResponse.promise;}
      return result;
    },
  };
  const api=await startHttp(wrapped,policy);
  cleanup.push(async()=>{await api.close();await assert.rejects(fetch(api.origin+'/health'));});
  cleanup.push(async()=>{release.resolve();releaseResponse.resolve();});
  const post=(id:string)=>fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${s.credentials.agent}`,'content-type':'application/json'},body:JSON.stringify({type:'recover',revision:1,attemptId:id})});
  const mixed=mixedCase(receipt.attemptId);assert(z.uuid().safeParse(mixed).success);assert.match(mixed,/[A-F]/);assert.match(mixed,/[a-f]/);
  const initial=post(mixed);await checkpoint(captured.promise);
  if(window==='command-response'){release.resolve();await checkpoint(held.promise);await checkpoint(activated.promise);}
  const joined=post(receipt.attemptId);await checkpoint(arrived.promise);release.resolve();
  if(window==='command-response'){await checkpoint(joined);releaseResponse.resolve();}
  const responses=await Promise.all([initial,joined]);assert(responses.every(r=>r.status===200));
  assert.deepEqual(await Promise.all(responses.map(r=>r.json())),[receipt,receipt]);
  assert.deepEqual(literalIds,[mixed,receipt.attemptId]);
  assert.equal(children.length,1,'mixed-case overlap must not replace a newly valid worker');
  await checkpoint(activated.promise);assert.equal(children[0].signalCode,null);process.kill(children[0].pid!,0);
  assert.equal(reactivations,1,'case aliases must join the original recovery generation');
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'active');
  children[0].send({resume:true});await api.idle();
  const state=await (await fetch(api.origin+'/state',{headers:{authorization:`Bearer ${s.credentials.agent}`}})).json();
  assert.deepEqual(state.interruptions,{});assert.equal(state.attempts[0].available,true);assert.equal(state.takes.length,2);
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'completed');
  for(const table of ['spike.attempts','spike.reservations','spike.receipts','pgboss.job','recovery.dispatch'])
    assert.equal((await fresh(`SELECT count(*)::int n FROM ${table}`))[0].n,1);
  assert.equal((await fresh('SELECT sum(reserved_count)::int n FROM spike.grants'))[0].n,1);
  assert.equal((await fresh('SELECT key FROM recovery.dispatch'))[0].key,receipt.attemptId);
  assert.equal(reads,1);assert.equal(provider.submits(),1);assert.equal(provider.jobs.size,1);
  for(const child of children)assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
});

test('malformed recovery UUIDs remain literal STRUCTURE failures without worker or queue effects',async t=>{
  const {service:s,e,catalog,cleanup,fresh}=await setup(t);await approve(s);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const children:childProcess.ChildProcess[]=[],intent=deferred(),fork=childProcess.fork;
  t.mock.method(childProcess,'fork',(...args:any[])=>{
    if(!children.length)args[1]=[args[1][0],'intent'];
    const child=(fork as any)(...args);children.push(child);
    child.on('message',(m:any)=>{if(m.point==='intent')intent.resolve();});return child;
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  let reactivations=0,callbacks=0,received:unknown;
  const fail=e.boss.fail.bind(e.boss);
  t.mock.method(e.boss,'fail',async(...args:any[])=>{reactivations++;return (fail as any)(...args);});
  const wrapped={...s,async command(token:string,body:any,recover?:Parameters<typeof s.command>[2]){
    received=structuredClone(body);
    return s.command(token,body,async(id,reactivate)=>{callbacks++;await recover!(id,reactivate);});
  }};
  const api=await startHttp(wrapped,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});
  cleanup.push(async()=>{await api.close();await assert.rejects(fetch(api.origin+'/health'));});
  const post=(body:any,token=s.credentials.agent)=>fetch(api.origin+'/commands',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const accepted=await post({type:'submit',revision:1,commandId:crypto.randomUUID()});assert.equal(accepted.status,200);
  const receipt=await accepted.json();await checkpoint(intent.promise);
  const snapshot=async()=>Promise.all(['spike.attempts','spike.reservations','spike.receipts','pgboss.job','recovery.lifecycle','recovery.dispatch','recovery.takes']
    .map(table=>fresh(`SELECT * FROM ${table}`)));
  const before=await snapshot(),upper=receipt.attemptId.toUpperCase();
  const malformed=[` ${upper}`,`${upper} `,`{${upper}}`,upper.replaceAll('-',''),`G${upper.slice(1)}`,'',null,42,{value:upper},[]];
  for(const attemptId of malformed) {
    assert.equal(z.uuid().safeParse(attemptId).success,false);
    const body={type:'recover',revision:1,attemptId};
    const response=await post(body);
    assert.equal(response.status,400,'malformed UUID must reject without repairing caller input');
    assert.deepEqual(await response.json(),{error:'STRUCTURE'});assert.deepEqual(received,body);
    await assert.rejects(s.command(s.credentials.agent,body),/STRUCTURE/);
  }
  const valid={type:'recover',revision:1,attemptId:upper};
  for(const attemptId of [upper,` ${upper}`]) {
    const response=await post({...valid,attemptId},'0'.repeat(64));assert.equal(response.status,401);
    assert.deepEqual(await response.json(),{error:'AUTHORIZATION'},'common principal validation still precedes command validation');
  }
  assert.equal((await post({...valid,attemptId:crypto.randomUUID().toUpperCase()})).status,401);
  assert.equal((await post({...valid,revision:2})).status,409);
  assert.equal((await post({...valid,revision:'1'})).status,400);
  assert.equal((await post({...valid,role:'human'})).status,400);
  assert.equal(callbacks,0);assert.equal(reactivations,0);assert.equal(children.length,1);
  assert.equal(children[0].signalCode,null);process.kill(children[0].pid!,0);
  assert.deepEqual(await snapshot(),before,'rejected recovery must not change durable state');
  assert.equal(provider.submits(),0);assert.equal(provider.jobs.size,0);
  const recovered=await post({...valid,attemptId:mixedCase(receipt.attemptId)});assert.equal(recovered.status,200);await api.idle();
  assert.equal(callbacks,1);assert.equal(reactivations,1);assert.equal(children.length,2);
  assert.equal((await fresh('SELECT state FROM pgboss.job WHERE id=$1',[receipt.jobId]))[0].state,'completed');
  assert.equal((await s.read(s.credentials.agent)).takes.length,2);assert.equal(provider.submits(),1);
  for(const child of children)assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
});
