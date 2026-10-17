import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { digest } from '../service.ts';
const exec=promisify(execFile);

test('HTTP human cookie and headless bearer adapter reach the same real service and media',async t=>{
  const {service:s,catalog,fresh,cleanup,cluster}=await setup(t);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const module=await import('../http.ts').catch(()=>null);assert(module?.startHttp,'HTTP adapter missing');
  const api=await module.startHttp(s,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});
  cleanup.push(()=>api.close());
  const post=(token:string,body:unknown,headers:Record<string,string>={})=>fetch(api.origin+'/commands',{
    method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(api.origin+'/health')).status,200);
  const ui=await (await fetch(api.origin+'/')).text();assert.match(ui,/<h1>Flume/);assert.match(ui,/id="prompt"/);
  assert.match(await (await fetch(api.origin+'/ui.js')).text(),/\/commands/);
  assert.equal((await post('',{type:'edit',revision:1,prompt:'forge'},{'x-role':'human'})).status,401);
  for(const token of [s.credentials.human,s.credentials.agent]) {
    assert.equal((await post(token,{type:'edit',revision:1,prompt:'x',approval:true})).status,400);
    assert.equal((await post(token,{type:'transfer',revision:1})).status,403);
    assert.equal((await post(token,{type:'submit',revision:1,commandId:crypto.randomUUID()})).status,409);
  }
  assert.equal((await post(s.credentials.agent,{type:'approve',revision:1,inspectionId:crypto.randomUUID()},{'x-role':'human'})).status,403);
  assert.equal((await post(s.credentials.human,{type:'edit',revision:1,prompt:'cross-site'},{origin:'https://untrusted.invalid'})).status,403);
  const login=await fetch(api.origin+'/session',{method:'POST',headers:{authorization:`Bearer ${s.credentials.human}`}});
  const cookie=login.headers.get('set-cookie')!.split(';')[0];assert(cookie);assert.match(login.headers.get('set-cookie')!,/HttpOnly/);
  const human=async(body:unknown)=>{
    const r=await fetch(api.origin+'/commands',{method:'POST',headers:{cookie,origin:api.origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(r.status,200,await r.clone().text());return r.json();
  };
  const edited=await human({type:'edit',revision:1,prompt:'Human HTTP draft'});assert.equal(edited.revision,2);
  const stale=await post(s.credentials.agent,{type:'edit',revision:1,prompt:'stale'});assert.equal(stale.status,409);
  assert.equal((await fresh('SELECT prompt FROM spike.drafts'))[0].prompt,'Human HTTP draft');
  const cred=path.join(cluster.root,'agent-key');await writeFile(cred,s.credentials.agent,{mode:0o600});
  const cli=await exec(process.execPath,['agent.ts',api.origin,cred,'read']);
  assert.equal(JSON.parse(cli.stdout).revision,2);
  const look=await human({type:'inspect',revision:2,artifact:'first-look'});
  await human({type:'approve',revision:2,inspectionId:look.id});
  const commandFile=path.join(cluster.root,'command.json');await writeFile(commandFile,JSON.stringify({type:'submit',revision:2,commandId:crypto.randomUUID()}));
  const submitted=await exec(process.execPath,['agent.ts',api.origin,cred,commandFile]);assert(JSON.parse(submitted.stdout).attemptId);
  await api.idle();
  const replay=await exec(process.execPath,['agent.ts',api.origin,cred,commandFile]);
  assert.deepEqual(JSON.parse(replay.stdout),JSON.parse(submitted.stdout));await api.idle();
  assert.deepEqual((await (await fetch(api.origin+'/state',{headers:{cookie}})).json()).interruptions,{});
  const state=await (await fetch(api.origin+'/state',{headers:{cookie}})).json();
  assert.equal(state.takes.length,2);assert.equal(state.selected_take,null);
  const id=state.takes[0].id;
  const inspected=await human({type:'inspect',revision:2,artifact:id});
  await human({type:'select',revision:2,selectionRevision:0,takeId:id,inspectionId:inspected.id});
  const media=await fetch(api.origin+`/media/${id}`,{headers:{cookie}});
  assert.equal(media.headers.get('content-type'),'video/mp4');assert.equal(digest(new Uint8Array(await media.arrayBuffer())),state.takes[0].sha256);
  const range=await fetch(api.origin+`/media/${id}`,{headers:{cookie,range:'bytes=0-31'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,32);
  assert.equal((await fetch(api.origin+`/media/${id}`,{headers:{cookie,range:'bytes=999999-'}})).status,416);
  assert.equal((await fetch(api.origin+'/media/..%2f..%2fpackage.json',{headers:{cookie}})).status,400);
  const exported=await human({type:'export',revision:2,selectionRevision:1});await api.idle();
  const [row]=await fresh('SELECT * FROM parity.exports WHERE id=$1',[exported.id]);assert.equal(row.status,'complete');assert.equal(row.stale,false);
  assert.equal((await fetch(api.origin+`/media/export-${exported.id}`,{headers:{cookie}})).status,200);
});
