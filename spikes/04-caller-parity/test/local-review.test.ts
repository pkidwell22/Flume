import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { startHttp } from '../http.ts';
import { digest } from '../service.ts';

async function local(t:Parameters<typeof setup>[0],trusted=true) {
  const resources=await setup(t),{service:s,catalog,cleanup}=resources;
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const api=await startHttp(s,{origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'},trusted?'trusted-local-fixture-review':undefined);
  cleanup.push(()=>api.close());
  const post=(body:unknown,headers:Record<string,string>={})=>fetch(api.origin+'/commands',{
    method:'POST',headers:{origin:api.origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
  return {...resources,s,provider,api,post};
}
const bearer=(token:string)=>({authorization:`Bearer ${token}`});
const approval={type:'approve',revision:1,inspectionId:crypto.randomUUID()};
async function denied(response:Response,status:number,message:string) {
  assert.equal(response.status,status,message);
  assert.equal(response.headers.get('set-cookie'),null,'rejection must not issue a session');
}

test('protected default still requires credentials and cannot be enabled by request input',async t=>{
  const {s,api,post}=await local(t,false);
  for(const route of ['/state','/media/first-look','/state?mode=trusted-local-fixture-review'])
    await denied(await fetch(api.origin+route,{headers:{'x-role':'human','x-mode':'trusted-local-fixture-review'}}),401,'default API must reject unauthenticated reads');
  await denied(await post({type:'edit',revision:1,prompt:'unauthenticated'}),401,'default API must reject unauthenticated commands');
  await denied(await fetch(api.origin+'/session',{method:'POST',headers:{origin:api.origin}}),401,'default session endpoint must require a credential');
  const html=await (await fetch(api.origin+'/')).text();assert.match(html,/id="login"/);
  for(const token of ['', 'trusted-local-fixture-review',Symbol('trusted-local-fixture-review')])
    await assert.rejects(s.read(token),/AUTHORIZATION/,'a guessed handle must not resolve a reviewer');
});

test('local review never upgrades bearer or cookie agents, even with their own inspection',async t=>{
  const {s,api,post,fresh}=await local(t);
  for(const route of ['/','/ui.js','/state']) {
    const response=await fetch(api.origin+route);assert.equal(response.headers.get('set-cookie'),null);
    const text=await response.text();
    assert(!Object.values(s.credentials).some(token=>text.includes(token)),'public content must not contain credential values');
  }
  for(const headers of [bearer(s.credentials.agent),{cookie:`flume=${s.credentials.agent}`}]) {
    const state=await (await fetch(api.origin+'/state',{headers})).json();assert.equal(state.canReview,false,'explicit agent must stay agent');
    const inspection=await post({type:'inspect',revision:1,artifact:'first-look'},headers);assert.equal(inspection.status,200);
    await denied(await post({...approval,inspectionId:(await inspection.json()).id},{...headers,'x-role':'human'}),403,'explicit agent must not approve');
  }
  // A bearer takes precedence even when a reviewer cookie accompanies it.
  assert.equal((await (await fetch(api.origin+'/state',{headers:{...bearer(s.credentials.agent),cookie:`flume=${s.credentials.human}`}})).json()).canReview,false);
  assert.equal((await fresh('SELECT count(*)::int AS n FROM spike.grants'))[0].n,0);
});

test('local review rejects malformed or invalid credentials rather than falling back',async t=>{
  const {s,api,post}=await local(t);
  for(const authorization of ['', 'Basic invalid','Bearer invalid',`Bearer ${'0'.repeat(64)}`,`Bearer ${s.credentials.agent}, Bearer ${s.credentials.human}`]) {
    for(const cookie of [undefined,`flume=${s.credentials.human}`]) {
      const headers={authorization,...(cookie===undefined?{}:{cookie})};
      await denied(await fetch(api.origin+'/state',{headers}),401,'malformed authorization must not become reviewer');
      await denied(await post(approval,headers),401,'malformed authorization must not approve');
    }
  }
  for(const cookie of ['flume','flume=','flume=invalid','other=value',`flume=${s.credentials.human}; flume=${s.credentials.agent}`]) {
    await denied(await fetch(api.origin+'/state',{headers:{cookie}}),401,'supplied invalid cookie must not become reviewer');
    await denied(await post(approval,{cookie}),401,'supplied invalid cookie must not approve');
  }
  const status=await new Promise<number>((resolve,reject)=>{
    http.get(api.origin+'/state',{headers:['Host',new URL(api.origin).host,'Authorization',`Bearer ${s.credentials.agent}`,'Authorization',`Bearer ${s.credentials.human}`]},res=>{res.resume();resolve(res.statusCode!);}).on('error',reject);
  });
  assert.equal(status,401,'duplicate authorization headers must not resolve a principal');
});

test('local expiry continuity does not renew or upgrade supplied expired credentials',async t=>{
  const {s,api,post,fresh}=await local(t);
  await fresh("UPDATE parity.sessions SET expires_at=clock_timestamp()-interval '1 second'");
  const snapshot=()=>fresh('SELECT actor_id,project_id,can_review,expires_at FROM parity.sessions ORDER BY actor_id');
  const before=await snapshot();
  for(const token of [s.credentials.human,s.credentials.agent]) {
    await denied(await fetch(api.origin+'/state',{headers:bearer(token)}),401,'supplied expired bearer must stay expired');
    await denied(await fetch(api.origin+'/state',{headers:{cookie:`flume=${token}`}}),401,'supplied expired cookie must stay expired');
  }
  assert.equal((await (await fetch(api.origin+'/state')).json()).canReview,true,'credential-free fixture review survives session expiry');
  assert.equal((await fetch(api.origin+'/media/first-look')).status,200,'fixture media survives session expiry');
  const inspected=await post({type:'inspect',revision:1,artifact:'first-look'});assert.equal(inspected.status,200);
  assert.equal((await post({...approval,inspectionId:(await inspected.json()).id})).status,200);
  assert.deepEqual(await snapshot(),before,'local review must not renew bearer credentials or mint new identities');
  for(const token of [s.credentials.human,s.credentials.agent])await assert.rejects(s.read(token),/AUTHORIZATION/);
  await denied(await fetch(api.origin+'/session',{method:'POST',headers:{origin:api.origin}}),401,'local handle must not be issued as a browser credential');
  await fresh('UPDATE parity.sessions SET project_id=$1 WHERE token_hash=$2',[crypto.randomUUID(),digest(s.credentials.human)]);
  await denied(await fetch(api.origin+'/state'),401,'local handle must retain project membership checking');
});

test('local review retains Host Origin CSP and fixture-only authority boundaries',async t=>{
  const {api,post,fresh,provider,catalog}=await local(t);
  for(const route of ['/','/state','/media/first-look']) {
    await denied(await fetch(api.origin+route,{headers:{origin:'https://untrusted.invalid'}}),403,'cross-origin reads must fail');
    const status=await new Promise<number>((resolve,reject)=>{
      http.get(api.origin+route,{headers:{host:'untrusted.invalid'}},res=>{res.resume();resolve(res.statusCode!);}).on('error',reject);
    });
    assert.equal(status,403,'foreign Host must fail');
  }
  await denied(await post(approval,{origin:'https://untrusted.invalid'}),403,'cross-origin command must fail');
  await denied(await fetch(api.origin+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(approval)}),403,'credential-free POST requires same origin');
  const page=await fetch(api.origin+'/');
  assert.equal(page.headers.get('content-security-policy'),"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  for(const type of ['transfer','spend','authorize'])await denied(await post({type,revision:1}),403,'local review must not confer transfer or spend');
  await denied(await post({type:'submit',revision:1,commandId:crypto.randomUUID(),route:'live/provider'}),400,'non-fixture route input must reject');
  await denied(await post({type:'inspect',revision:1,artifact:'https://untrusted.invalid/media.mp4'}),400,'arbitrary media must reject');
  await denied(await post({type:'submit',revision:1,commandId:crypto.randomUUID()}),409,'explicit first-look approval remains required');
  await denied(await post(approval),409,'approval needs an actor-owned first-look inspection');
  await denied(await post({type:'export',revision:1,selectionRevision:0}),409,'export needs explicit selection');
  const nonfixture=await fetch(provider.origin+'/submit',{method:'POST',headers:{'idempotency-key':crypto.randomUUID(),'x-fixture-account':crypto.randomUUID(),'x-fixture-route':'live/provider'},body:JSON.stringify({profile:'owned-pattern-mp4-v1',continuity:catalog.continuity})});
  assert.equal(nonfixture.status,400,'provider must reject non-fixture routes');assert.equal(provider.submits(),0);assert.equal(provider.jobs.size,0);
  for(const table of ['spike.grants','spike.reviews','spike.attempts','spike.reservations'])assert.equal((await fresh(`SELECT count(*)::int AS n FROM ${table}`))[0].n,0);
  assert.equal((await fresh('SELECT selected_take FROM parity.plans'))[0].selected_take,null);
});
