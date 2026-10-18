import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';

/** Owned loopback-only transport fixture. No provider endpoint can be reached, even on RED. */
export async function controlledProvider(t:TestContext,initial:unknown){
 const requests:{method:string;url:string;authorization:string|undefined;body:string}[]=[];
 let catalog=initial,status=200;
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({method:req.method!,url:req.url!,authorization:req.headers.authorization,body});
  res.setHeader('content-type','application/json');
  if(req.url==='/api/v1/videos/models'){res.statusCode=status;res.end(JSON.stringify(catalog));}
  else if(req.method==='POST'&&req.url==='/api/v1/videos')res.end(JSON.stringify({id:'synthetic-wiring-job',model:JSON.parse(body).model}));
  else {res.statusCode=404;res.end('{}');}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const baseUrl=`http://127.0.0.1:${(server.address() as any).port}/api/v1`;
 const realFetch=globalThis.fetch;let unexpected=0;
 globalThis.fetch=async(input,init)=>{
  if(!String(input).startsWith(baseUrl+'/')){unexpected++;throw Error('Unconfigured outbound request disabled');}
  return realFetch(input,init);
 };
 t.after(async()=>{globalThis.fetch=realFetch;const closed=new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));server.closeAllConnections();await closed;assert.equal(server.listening,false);assert.equal(unexpected,0,'only the owned local transport may be used');});
 return {requests,transport:{baseUrl,allowLoopbackHttpForTests:true as const},setCatalog(value:unknown,httpStatus=200){catalog=value;status=httpStatus;}};
}
