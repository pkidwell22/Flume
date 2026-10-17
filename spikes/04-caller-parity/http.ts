import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { createService } from './service.ts';
import { launchWorker } from './worker.ts';
import type { Policy } from '../01-approved-attempt/dist/recovery/engine.js';
type Service=Awaited<ReturnType<typeof createService>>;
export async function startHttp(service:Service,policy:Policy) {
  const tasks=new Set<Promise<unknown>>(), workers=new Map<string,ReturnType<typeof launchWorker>>();
  const failures=new Map<string,string>(), starts=new Map<string,Promise<void>>(), generations=new Map<string,number>();let origin='',closing=false;
  const recoveries=new Map<string,{generation:number;callers:number}>();
  function ensureWorker(id:string,recovery?:{generation:number;reactivate:()=>Promise<void>}) {
    const pending=starts.get(id);if(pending&&!recovery)return pending;
    // A replay joins the decision; recovery queues a new decision after it.
    // Reserve the whole stop/reactivate/read/start operation before any await.
    const start=(pending?.catch(()=>{})??Promise.resolve()).then(async()=>{
      if(closing)return;
      if(recovery){
        // A worker started since this request arrived already satisfies its
        // recovery intent. Do not fail/retry or kill that newer activation.
        if((generations.get(id)??0)!==recovery.generation)return;
        await workers.get(id)?.stop();await recovery.reactivate();
      }
      if(!workers.has(id)&&await service.isQueued(id)&&!closing) {
        failures.delete(id);const worker=launchWorker(policy);workers.set(id,worker);
        generations.set(id,(generations.get(id)??0)+1);
        track(worker.done.finally(()=>{if(workers.get(id)===worker)workers.delete(id);}),id);
      }
    }).finally(()=>{if(starts.get(id)===start)starts.delete(id);tasks.delete(start);});
    starts.set(id,start);tasks.add(start);return start;
  }
  function track(task:Promise<unknown>,id:string) {
    tasks.add(task);void task.catch(()=>failures.set(id,'Interrupted; resume this attempt, not a new submission.')).finally(()=>tasks.delete(task));
  }
  const server=http.createServer(async(req,res)=>{
    const send=(value:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if(req.headers.host!==new URL(origin).host) {send({error:'AUTHORIZATION'},403);return;}
      if(req.headers.origin&&req.headers.origin!==origin) {send({error:'AUTHORIZATION'},403);return;}
      const url=new URL(req.url!,origin);
      const bearer=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('flume='))?.slice(6);
      const token=bearer??cookie??'';
      if(req.method==='POST'&&!token) throw new Error('AUTHORIZATION');
      if(req.method==='POST'&&!bearer&&req.headers.origin!==origin) {send({error:'AUTHORIZATION'},403);return;}
      if(req.method==='GET'&&url.pathname==='/health'){send({ready:true});return;}
      const staticFiles:Record<string,[string,string]>={'/':['index.html','text/html'],'/ui.js':['ui.js','text/javascript'],'/ui.css':['ui.css','text/css']};
      if(req.method==='GET'&&staticFiles[url.pathname]) {
        const [file,type]=staticFiles[url.pathname];res.setHeader('content-type',type);res.end(await readFile(new URL(`./ui/${file}`,import.meta.url)));return;
      }
      if(req.method==='POST'&&url.pathname==='/session') {
        await service.read(token);res.setHeader('set-cookie',`flume=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);send({signedIn:true});return;
      }
      if(req.method==='GET'&&url.pathname==='/state') {send({...await service.read(token),interruptions:Object.fromEntries(failures)});return;}
      if(req.method==='GET'&&url.pathname.startsWith('/media/')) {
        const {bytes,type}=await service.media(token,decodeURIComponent(url.pathname.slice(7)));
        res.setHeader('content-type',type);res.setHeader('accept-ranges','bytes');
        if(req.headers.range) {
          const m=req.headers.range.match(/^bytes=(\d+)-(\d*)$/);const start=Number(m?.[1]),end=m?.[2]?Number(m[2]):bytes.length-1;
          if(!m||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=bytes.length) {res.writeHead(416,{'content-range':`bytes */${bytes.length}`});res.end();return;}
          res.writeHead(206,{'content-range':`bytes ${start}-${end}/${bytes.length}`,'content-length':end-start+1});res.end(bytes.subarray(start,end+1));return;
        }
        res.setHeader('content-length',bytes.length);res.end(bytes);return;
      }
      if(req.method==='POST'&&url.pathname==='/commands') {
        if(req.headers['content-type']!=='application/json') throw new Error('STRUCTURE');
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>8192) throw new Error('STRUCTURE');}
        let command:any;try{command=JSON.parse(body);}catch{throw new Error('STRUCTURE');}
        let result;
        if(command?.type==='recover'&&z.uuid().safeParse(command.attemptId).success) {
          // Validate before deriving the internal key; preserve the literal
          // command for common service validation and authorization below.
          const id=command.attemptId.toLowerCase();
          // Retain the arrival generation through command completion, not just
          // worker launch: another request may arrive during advisory unlock.
          const group=recoveries.get(id)??{generation:generations.get(id)??0,callers:0};
          group.callers++;recoveries.set(id,group);
          try {result=await service.command(token,command,(id,reactivate)=>ensureWorker(id,{generation:group.generation,reactivate}));}
          finally {if(--group.callers===0)recoveries.delete(id);}
        } else result=await service.command(token,command);
        if(command.type==='submit')await ensureWorker(result.attemptId);
        if(command.type==='export') track(service.renderExport(result.id),result.id);
        send(result);return;
      }
      send({error:'NOT_FOUND'},404);
    } catch(error) {
      const message=(error as Error).message;
      const status=message==='AUTHORIZATION'?401:['CAPABILITY','AUTHORIZATION_DENIED'].includes(message)?403:message==='STRUCTURE'?400:
        /CONFLICT|REVIEW|INSPECTION|SELECTION|GRANT|OWNED_MEDIA/.test(message)?409:500;
      // Never serialize SQL, filesystem paths, credentials, or subprocess logs.
      send({error:status===500?'INTERNAL':message},status);
    }
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert(address&&typeof address==='object');origin=`http://127.0.0.1:${address.port}`;
  return {origin,async idle(){while(tasks.size) await Promise.allSettled([...tasks]);},async close(){
    closing=true;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await Promise.allSettled([...starts.values()]);
    await Promise.all([...workers.values()].map(w=>w.stop()));await Promise.allSettled([...tasks]);assert.equal(server.listening,false);
  }};
}
