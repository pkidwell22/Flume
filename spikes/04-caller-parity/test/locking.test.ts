import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { launchWorker } from '../worker.ts';

// Observe the real pg protocol; gates delay delivery of a terminal statement,
// never synthesize a query result. No production scheduling hooks are needed.
function terminalGate(pool:any, terminal:'BEGIN'|'COMMIT'|'ROLLBACK') {
  let enter!:(value:{pid:number})=>void, release!:()=>void;
  const entered=new Promise<{pid:number}>(resolve=>{enter=resolve;}), resume=new Promise<void>(resolve=>{release=resolve;});
  const seen=new WeakSet(), releases:{pid:number;status:string}[]=[];
  let armed=true, owner:number|undefined;
  pool.on('acquire',(client:any)=>{
    if(seen.has(client))return;seen.add(client);
    let status='I';
    client.connection.on('readyForQuery',(message:any)=>{status=message.status;});
    const query=client.query, releaseEvents=(error:any,released:any)=>{
      if(released===client) releases.push({pid:client.processID,status});
    };
    pool.on('release',releaseEvents);
    client.once('end',()=>pool.off('release',releaseEvents));
    client.query=function(...args:any[]) {
      const text=typeof args[0]==='string'?args[0]:args[0].text;
      if(text.includes('SELECT pg_advisory_lock(')) owner=client.processID;
      if(armed&&text.trim().toUpperCase()===terminal){
        armed=false;enter({pid:client.processID});
        return resume.then(()=>query.apply(client,args));
      }
      return query.apply(client,args);
    };
  });
  return {entered,resume:release,releases,owner:()=>owner};
}
async function until(check:()=>Promise<boolean>) {
  for(let i=0;i<200;i++){if(await check())return;await delay(10);}
  assert.fail('database interleaving was not reached');
}
async function approved(s:any) {
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:1,inspectionId:look.id});
}

for(const kind of ['edit','selection'] as const) test(`overlapping human/agent ${kind} retains client and lock through COMMIT`,async t=>{
  const {service:s,e,fresh,catalog,cleanup}=await setup(t);
  let human:any={type:'edit',revision:1,prompt:'Human winner'}, agent:any={...human,prompt:'Agent loser'};
  if(kind==='selection') {
    await approved(s);
    await s.command(s.credentials.agent,{type:'submit',revision:1,commandId:crypto.randomUUID()});
    const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
    const worker=launchWorker({origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});cleanup.push(()=>worker.stop());await worker.done;
    const takes=(await s.read(s.credentials.human)).takes;
    const h=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:takes[0].id});
    const a=await s.command(s.credentials.agent,{type:'inspect',revision:1,artifact:takes[1].id});
    human={type:'select',revision:1,selectionRevision:0,takeId:takes[0].id,inspectionId:h.id};
    agent={...human,takeId:takes[1].id,inspectionId:a.id};
  }
  const gate=terminalGate(e.pool,'COMMIT');
  const first=s.command(s.credentials.human,human);
  const {pid}=await gate.entered;
  // The first write is real but invisible until COMMIT, on an independent PG session.
  const [before]=await fresh('SELECT revision FROM spike.drafts');assert.equal(before.revision,1);
  let secondDone=false;
  const second=s.command(s.credentials.agent,agent).finally(()=>{secondDone=true;});void second.catch(()=>{});
  let held=false, releasedActive=false, blocked=false;
  try {
    await until(async()=> secondDone || (await fresh('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).length>0);
    held=(await fresh("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted",[pid])).length===1;
    releasedActive=gate.releases.some(r=>r.pid===pid&&r.status!=='I');
    blocked=(await fresh('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).length>0;
  } finally {gate.resume();}
  const results=await Promise.allSettled([first,second]);
  assert.equal(held,true,'shot advisory lock must remain held until COMMIT');
  assert.equal(releasedActive,false,'pool must not receive a client with an active transaction');
  assert.equal(blocked,true,'the overlapping caller must wait on the first PG session');
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
  assert.match((results[1] as PromiseRejectedResult).reason.message,kind==='edit'?/REVISION_CONFLICT/:/SELECTION_CONFLICT/);
  const saved=await s.read(s.credentials.human);
  if(kind==='edit'){assert.equal(saved.prompt,human.prompt);assert.equal(saved.revision,2);}
  else {assert.equal(saved.selected_take,human.takeId);assert.equal(saved.selection_revision,1);}
  assert(gate.releases.every(r=>r.status==='I'),'every released client is transaction-idle');
});

for(const kind of ['approve','submit','rollback'] as const) test(`${kind} retains adapter lock through its terminal transaction`,async t=>{
  const {service:s,e,fresh}=await setup(t);
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  if(kind==='submit')await s.command(s.credentials.human,{type:'approve',revision:1,inspectionId:look.id});
  if(kind==='rollback')await e.pool.query(`CREATE FUNCTION parity.reject_edit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'TEST_ROLLBACK'; END $$;
    CREATE TRIGGER reject_edit BEFORE UPDATE ON spike.drafts FOR EACH ROW EXECUTE FUNCTION parity.reject_edit()`);
  const gate=terminalGate(e.pool,kind==='rollback'?'ROLLBACK':'COMMIT');
  const body=kind==='submit'?{type:'submit',revision:1,commandId:crypto.randomUUID()}:
    kind==='approve'?{type:'approve',revision:1,inspectionId:look.id}:{type:'edit',revision:1,prompt:'Must roll back'};
  const operation=s.command(s.credentials.human,body);void operation.catch(()=>{});
  const {pid}=await gate.entered;
  let locks:any[], releasedActive:boolean;
  try {
    locks=await fresh("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted",[gate.owner()]);
    releasedActive=gate.releases.some(r=>r.status!=='I');
    const [activity]=await fresh('SELECT state FROM pg_stat_activity WHERE pid=$1',[pid]);
    assert.equal(activity.state,kind==='rollback'?'idle in transaction (aborted)':'idle in transaction');
  } finally {gate.resume();}
  const outcome=await Promise.allSettled([operation]);
  assert.equal(locks!.length,1,'adapter advisory lock must remain held through the terminal statement');
  assert.equal(releasedActive!,false,'pool must not receive an active transaction');
  assert.equal(outcome[0].status,kind==='rollback'?'rejected':'fulfilled');
  if(kind==='rollback') {
    assert.match((outcome[0] as PromiseRejectedResult).reason.message,/TEST_ROLLBACK/);
    assert.equal((await fresh('SELECT revision FROM spike.drafts'))[0].revision,1);
  }
  assert(gate.releases.every(r=>r.status==='I'));
});

for(const kind of ['edit','selection'] as const) test(`${kind} compare-and-set rejects a revision moved outside the adapter lock`,async t=>{
  const {service:s,e,fresh,catalog,cleanup}=await setup(t);
  let body:any={type:'edit',revision:1,prompt:'Must not overwrite'};
  if(kind==='selection') {
    await approved(s);await s.command(s.credentials.agent,{type:'submit',revision:1,commandId:crypto.randomUUID()});
    const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
    const worker=launchWorker({origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});cleanup.push(()=>worker.stop());await worker.done;
    const take=(await s.read(s.credentials.human)).takes[0];
    const inspected=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:take.id});
    body={type:'select',revision:1,selectionRevision:0,takeId:take.id,inspectionId:inspected.id};
  }
  const gate=terminalGate(e.pool,'BEGIN');
  const operation=s.command(s.credentials.human,body);void operation.catch(()=>{});
  await gate.entered; // Validation has read the old revision; mutate via independent SQL.
  try {
    if(kind==='edit')await fresh("UPDATE spike.drafts SET prompt='External winner',revision=revision+1");
    else await fresh('UPDATE parity.plans SET selection_revision=selection_revision+1');
  } finally {gate.resume();}
  await assert.rejects(operation,kind==='edit'?/REVISION_CONFLICT/:/SELECTION_CONFLICT/);
  const saved=await s.read(s.credentials.human);
  if(kind==='edit'){assert.equal(saved.revision,2);assert.equal(saved.prompt,'External winner');}
  else {assert.equal(saved.selection_revision,1);assert.equal(saved.selected_take,null);}
});
