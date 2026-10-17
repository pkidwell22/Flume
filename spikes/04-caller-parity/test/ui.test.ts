// DOM logic + real HTTP. This is not browser rendering/playback evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { startHttp } from '../http.ts';

test('trusted local editor preserves its own revision and blocks review of unsaved text',async t=>{
  const {service:s,catalog,cleanup,fresh}=await setup(t);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const api=await startHttp(s,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'},'trusted-local-fixture-review');cleanup.push(()=>api.close());
  const {document}=parseHTML(await (await fetch(api.origin+'/')).text());
  assert.equal(document.getElementById('login'),null);
  const context=vm.createContext({document,crypto,fetch:(url:string,options:any={})=>fetch(api.origin+url,{
    ...options,headers:{...options.headers,origin:api.origin}})});
  vm.runInContext(await (await fetch(api.origin+'/ui.js')).text(),context);
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

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
for(const mode of ['typing','newer-server-revision','lost-response'] as const) test(`save response preserves editor buffer and base revision: ${mode}`,async t=>{
  const {service:s,catalog,cleanup}=await setup(t);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const api=await startHttp(s,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});cleanup.push(()=>api.close());
  const {document}=parseHTML(await readFile('ui/index.html','utf8'));
  const posted=deferred(),releasePost=deferred(),loaded=deferred(),releaseGet=deferred();
  let defer=false;
  const context=vm.createContext({document,crypto,fetch:async(url:string,options:any={})=>{
    const response=await fetch(api.origin+url,{...options,headers:{...options.headers,authorization:`Bearer ${s.credentials.human}`}});
    if(defer&&url==='/commands'){
      posted.resolve();await releasePost.promise;
      if(mode==='lost-response')throw new Error('NETWORK_LOST_AFTER_COMMIT');
    }
    if(defer&&url==='/state'){loaded.resolve();await releaseGet.promise;}
    return response;
  }});
  vm.runInContext(await readFile('ui/ui.js','utf8'),context);await vm.runInContext('refresh()',context);
  const get=(id:string)=>document.getElementById(id)! as any;
  const type=(value:string)=>{get('prompt').value=value;get('prompt').dispatchEvent(new document.defaultView!.Event('input'));};
  type('A submitted');defer=true;
  const saving=get('edit').onsubmit({preventDefault(){}});await posted.promise;
  assert.equal((await s.read(s.credentials.human)).prompt,'A submitted','the POST really committed');
  type('B typed during POST');
  if(mode==='newer-server-revision')await s.command(s.credentials.agent,{type:'edit',revision:2,prompt:'Agent revision 3'});
  releasePost.resolve();
  if(mode!=='lost-response') {
    await loaded.promise;
    assert.equal(get('prompt').value,'B typed during POST','POST success must preserve text typed before its response');
    type('C typed during GET');releaseGet.resolve();
  }
  await saving;defer=false;
  assert.equal(get('prompt').value,mode==='lost-response'?'B typed during POST':'C typed during GET','newer editor input must survive save completion');
  assert.equal(get('approve').disabled,true);assert.equal(get('submit').disabled,true);
  assert.equal(get('inspect-look').disabled,true);
  if(mode==='lost-response') {
    assert.match(get('message').textContent,/may be unknown/,'a lost response cannot imply the write did not commit');
    assert.equal(vm.runInContext('editorRevision',context),1);
  } else {
    assert.equal(vm.runInContext('editorRevision',context),2,'editor base is the saved response, not a later GET revision');
    if(mode==='newer-server-revision')await vm.runInContext('refresh(false)',context);
    await get('edit').onsubmit({preventDefault(){}});
    if(mode==='newer-server-revision') {
      assert.match(get('message').textContent,/REVISION_CONFLICT/);assert.equal((await s.read(s.credentials.human)).prompt,'Agent revision 3');
    } else {
      assert.equal((await s.read(s.credentials.human)).prompt,'C typed during GET');
      assert.equal((await s.read(s.credentials.human)).revision,3);assert.equal(get('submit').disabled,false);
    }
  }
});
