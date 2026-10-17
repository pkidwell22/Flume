// Local owned-media receipt protocol, not a live model/provider adapter.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { digest, type Catalog } from './service.ts';
import { hash } from '../01-approved-attempt/dist/src/contracts.js';
import { inspectVideo } from './media.ts';
export async function startProvider(catalog:Catalog) {
  const bytes=await Promise.all(catalog.outputs.map(async o=>{
    const b=await readFile(o.path); assert.equal(digest(b),o.sha256); assert(b.length<=4096);
    await inspectVideo(o.path,o.sha256); return b;
  }));
  type Job={id:string;key:string;account:string;route:string;body:string};
  const jobs=new Map<string,Job>(); let submits=0;
  const server=http.createServer(async(req,res)=>{
    const send=(v:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
    try {
      let body=''; for await(const chunk of req){body+=chunk; assert(Buffer.byteLength(body)<=32768);}
      const key=z.uuid().parse(req.headers['idempotency-key']);
      const account=z.uuid().parse(req.headers['x-fixture-account']);
      const route=z.literal('fixture/video-v1').parse(req.headers['x-fixture-route']);
      const url=new URL(req.url!,'http://127.0.0.1');
      let job=[...jobs.values()].find(j=>j.key===key&&j.account===account&&j.route===route);
      if(req.method==='POST'&&url.pathname==='/submit') {
        submits++;
        const plan=JSON.parse(body); assert.equal(plan.profile,'owned-pattern-mp4-v1');
        assert.equal(hash(plan.continuity),hash(catalog.continuity));
        if(job&&job.body!==body){send({error:'BODY_CONFLICT'},409);return;}
        if(!job){job={id:randomUUID(),key,account,route,body};jobs.set(job.id,job);}
      } else if(url.pathname.startsWith('/jobs/')) {
        job=jobs.get(url.pathname.split('/')[2]);
        if(job&&(job.key!==key||job.account!==account||job.route!==route)) job=undefined;
        const output=url.pathname.match(/^\/jobs\/[a-f0-9-]+\/outputs\/([01])$/);
        if(job&&output&&req.method==='GET') {
          const b=bytes[Number(output[1])];res.writeHead(200,{'content-type':'video/mp4','content-length':b.length});res.end(b);return;
        }
        if(!/^\/jobs\/[a-f0-9-]+$/.test(url.pathname)) {send(null,404);return;}
      } else if(url.pathname!=='/lookup'||req.method!=='GET') {send(null,404);return;}
      if(!job){send(null,404);return;}
      send({version:1,id:job.id,key,account,route,state:'succeeded',outputs:catalog.outputs.map((o,i)=>({
        id:`output-${i}`,path:`/jobs/${job!.id}/outputs/${i}`,sha256:o.sha256,size:bytes[i].length}))});
    } catch {send({error:'OWNED_FIXTURE_ONLY'},400);}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert(address&&typeof address==='object');
  return {origin:`http://127.0.0.1:${address.port}`,jobs,submits:()=>submits,
    async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));assert.equal(server.listening,false);}};
}
