// DOM logic + real HTTP. This is not browser rendering/playback evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { startHttp } from '../http.ts';

test('human editor preserves its own revision and blocks review of unsaved text',async t=>{
  const {service:s,catalog,cleanup,fresh}=await setup(t);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const api=await startHttp(s,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});cleanup.push(()=>api.close());
  const {document}=parseHTML(await readFile('ui/index.html','utf8'));
  const context=vm.createContext({document,crypto,fetch:(url:string,options:any={})=>fetch(api.origin+url,{
    ...options,headers:{...options.headers,authorization:`Bearer ${s.credentials.human}`}})});
  vm.runInContext(await readFile('ui/ui.js','utf8'),context);
  await vm.runInContext('refresh()',context);
  const get=(id:string)=>document.getElementById(id)! as any;
  await get('inspect-look').onclick();assert.equal(get('approve').disabled,false);
  get('prompt').value='Unsaved human direction';
  get('prompt').dispatchEvent(new document.defaultView!.Event('input'));
  assert.equal(get('approve').disabled,true,'unsaved text cannot be approved as the saved plan');
  assert.equal(get('submit').disabled,true);
  await s.command(s.credentials.agent,{type:'edit',revision:1,prompt:'Agent edit on server'});
  // A non-editor refresh (e.g. an async inspection/result return) must NOT move
  // the editor's base revision or silently turn old text into a current write.
  await vm.runInContext('refresh(false)',context);
  assert.equal(get('prompt').value,'Unsaved human direction');
  await get('edit').onsubmit({preventDefault(){}});
  // The edit handler returns its real command/response promise.
  assert.match(get('message').textContent,/REVISION_CONFLICT/);
  assert.equal(get('prompt').value,'Unsaved human direction');
  assert.equal((await s.read(s.credentials.agent)).prompt,'Agent edit on server');
  await get('refresh').onclick();
  await get('inspect-look').onclick();await get('approve').onclick();await get('submit').onclick();
  await api.idle();await get('refresh').onclick();
  const take=(await s.read(s.credentials.human)).takes[0];
  get('prompt').value='Review the imported take for the next plan';
  await get('edit').onsubmit({preventDefault(){}});
  const inspect=[...document.querySelectorAll('button')].find(b=>b.textContent==='Inspect this take')! as any;
  await inspect.onclick();
  assert.equal(get('look').src,`/media/${take.id}`,'the visible review candidate must be the inspected actual take');
  await get('approve').onclick();
  assert.match(get('message').textContent,/Plan approved/);
  const [review]=await fresh('SELECT request FROM spike.reviews WHERE draft_revision=3');
  assert.equal(JSON.parse(review.request.envelope.body).firstLook.artifact,take.id);
  assert.equal(JSON.parse(review.request.envelope.body).firstLook.sha256,take.sha256);
  await get('inspect-look').onclick();
  assert.equal(get('look').src,'/media/first-look');
});
