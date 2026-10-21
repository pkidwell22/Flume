import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,open,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFileChatStore} from '../src/chat-store.ts';

test('list recovery cannot overwrite a concurrently accepted turn', {timeout:5000}, async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'flume-list-recovery-')));
  const actorId=randomUUID(),projectId=randomUUID();
  const old=await createFileChatStore({root});
  const conversation=await old.create({actorId,projectId,title:'Recovery fixture',modelId:'google/gemini-2.5-flash-lite'});
  const scope={actorId,projectId,conversationId:conversation.id};
  await old.beginTurn({...scope,requestId:randomUUID(),content:'Interrupted fixture turn'});
  // The old owner performs no further work: this models a process restart.
  const restarted=await createFileChatStore({root});
  const probe=await open(path.join(root,'prototype-probe'),'wx',0o600);
  const prototype=Object.getPrototypeOf(probe);const original=prototype.readFile;await probe.close();
  let entered!:()=>void,release!:()=>void,armed=true;
  const hasRead=new Promise<void>(r=>{entered=r;});const resume=new Promise<void>(r=>{release=r;});
  t.mock.method(prototype,'readFile',async function(this:any,...args:any[]){
    const data=await original.apply(this,args);
    if(armed){armed=false;entered();await resume;}
    return data;
  });
  const listing=restarted.list({actorId,projectId});await hasRead;
  const requestId=randomUUID();const writing=restarted.beginTurn({...scope,requestId,content:'New accepted turn'});
  // Give an unlocked mutation a chance to commit while listing holds old bytes.
  await Promise.race([writing,new Promise(r=>setTimeout(r,200))]);release();
  await Promise.all([listing,writing]);t.mock.restoreAll();
  const saved=await restarted.get(scope);
  assert.ok(saved.messages.some(m=>m.requestId===requestId),'Recovery must not discard a newly accepted request');
});
