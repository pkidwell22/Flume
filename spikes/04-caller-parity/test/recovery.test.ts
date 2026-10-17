import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './support.ts';
import { digest } from '../service.ts';
import { startProvider } from '../provider.ts';
import { launchWorker } from '../worker.ts';

test('a human edit revokes pending dispatch authority before any media-provider call',async t=>{
  const {service:s,catalog,fresh,cleanup}=await setup(t);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:1,inspectionId:look.id});
  await s.command(s.credentials.agent,{type:'submit',revision:1,commandId:crypto.randomUUID()});
  await s.command(s.credentials.human,{type:'edit',revision:1,prompt:'Not the approved plan anymore'});
  const worker=launchWorker({origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});
  cleanup.push(()=>worker.stop());assert.equal(await worker.done,'GRANT_UNAVAILABLE');
  assert.equal(provider.submits(),0);assert.equal(provider.jobs.size,0);
  assert.equal((await fresh('SELECT * FROM recovery.takes')).length,0);
  assert.equal((await fresh('SELECT * FROM spike.reservations')).length,1);
  assert.equal((await fresh('SELECT * FROM spike.attempts')).length,1);
});

for(const checkpoint of ['reply','bytes']) test(`SIGKILL at ${checkpoint} resumes the same attempt into real media, never auto-selects`,async t=>{
  const {service:s,e,catalog,fresh,cleanup}=await setup(t);
  const providerModule=await import('../provider.ts').catch(()=>null);
  assert(providerModule?.startProvider,'owned media provider is missing');
  const provider=await providerModule.startProvider(catalog); cleanup.push(()=>provider.close());
  const workerModule=await import('../worker.ts').catch(()=>null);
  assert(workerModule?.launchWorker,'recovery worker adapter is missing');
  const policy={origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'};
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:1,inspectionId:look.id});
  const receipt=await s.command(s.credentials.agent,{type:'submit',revision:1,commandId:crypto.randomUUID()});
  const worker=workerModule.launchWorker(policy,checkpoint); cleanup.push(()=>worker.stop());
  await worker.point(checkpoint);
  assert.equal((await fresh('SELECT count(*)::int n FROM recovery.takes'))[0].n,0);
  if(checkpoint==='bytes') assert.equal((await fresh('SELECT published FROM recovery.imports'))[0].published,false);
  else assert.equal((await fresh('SELECT * FROM recovery.observations')).length,0);
  await worker.stop();
  assert.throws(()=>process.kill(worker.pid,0),{code:'ESRCH'});
  await s.command(s.credentials.human,{type:'recover',revision:1,attemptId:receipt.attemptId});
  const resumed=workerModule.launchWorker(policy); cleanup.push(()=>resumed.stop());
  assert.equal(await resumed.done,'ready');
  const takes=await fresh('SELECT * FROM recovery.takes ORDER BY output_id');
  assert.equal(takes.length,2);
  assert.equal(provider.jobs.size,1);
  assert.equal(provider.submits(),1);
  assert.equal((await fresh('SELECT count(*)::int n FROM spike.attempts'))[0].n,1);
  assert.equal((await fresh('SELECT count(*)::int n FROM spike.reservations'))[0].n,1);
  assert.equal((await fresh('SELECT count(*)::int n FROM pgboss.job'))[0].n,1);
  assert.equal((await s.read(s.credentials.human)).selected_take,null);
  await assert.rejects(s.command(s.credentials.human,{type:'select',revision:1,selectionRevision:0,takeId:takes[1].id,inspectionId:look.id}),/INSPECTION_REQUIRED/);
  for(const take of takes) {
    const output=catalog.outputs.find((o:any)=>o.id===take.output_id);
    assert.equal(take.sha256,output.sha256);
    assert.equal(digest(await readFile(path.join(s.storage,`${take.sha256}.simulation`))),take.sha256);
  }
  const inspection=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:takes[1].id});
  assert.equal(inspection.probe.frames,6);
  await assert.rejects(s.command(s.credentials.agent,{type:'select',revision:1,selectionRevision:0,takeId:takes[1].id,inspectionId:inspection.id}),/INSPECTION_REQUIRED/);
  const selected=await s.command(s.credentials.human,{type:'select',revision:1,selectionRevision:0,takeId:takes[1].id,inspectionId:inspection.id});
  assert.equal(selected.selected_take,takes[1].id); assert.equal(selected.selection_revision,1);
  await assert.rejects(s.command(s.credentials.human,{type:'select',revision:1,selectionRevision:0,takeId:takes[1].id,inspectionId:inspection.id}),/SELECTION_CONFLICT/);
  assert.equal((await fresh('SELECT selected_take FROM parity.plans'))[0].selected_take,takes[1].id);
  assert.deepEqual(JSON.parse((await fresh('SELECT request FROM spike.attempts'))[0].request.envelope.body).continuity,catalog.continuity);
});
