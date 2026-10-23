import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import {MediaError} from '@flume/media';
import { z } from 'zod';
import { ServiceError,actorSchema,uuid,type Actor } from './contracts.ts';
import type { createCommandService } from './service.ts';
import { ChatError,CreateChatSchema,ProposalActionSchema,ProposeShotEditSchema,RenameChatSchema,SendChatSchema } from './chat-contracts.ts';
import type { ChatService } from './chat-service.ts';
export type SecurityOptions={mode:'protected'|'local-operator';allowedHosts:string[];allowedOrigins:string[]};
export type ServerOptions={service:ReturnType<typeof createCommandService>;chat?:ChatService;security?:SecurityOptions;authenticate?:(request:FastifyRequest)=>Promise<Actor|null>};
const operatorId='10000000-0000-4000-8000-000000000001',agentId='10000000-0000-4000-8000-000000000002';
export async function buildServer({service,chat,security={mode:'protected',allowedHosts:['127.0.0.1:4310','localhost:4310'],allowedOrigins:['http://127.0.0.1:4310','http://localhost:4310']},authenticate}:ServerOptions){
 const app=Fastify({logger:false,trustProxy:false,bodyLimit:1_048_576,requestTimeout:30_000});
 const actors=new WeakMap<FastifyRequest,Actor>();
 await app.register(multipart,{limits:{fileSize:32*1024*1024,files:1,fields:1,parts:2,fieldSize:100}});
 app.setErrorHandler((error,request,reply)=>{
  if(error instanceof ServiceError)return reply.code(error.status).send({code:error.code,message:error.message,...(error.currentRevision===undefined?{}:{currentRevision:error.currentRevision}),...(error.details===undefined?{}:{details:error.details})});
  if(error instanceof ChatError)return reply.code(error.status).send({code:error.code,message:error.message});
  if(error instanceof MediaError)return reply.code(error.code==='MEDIA_BUSY'?409:/LIMIT/.test(error.code)?413:422).send({code:error.code,message:error.code==='MEDIA_BUSY'?'Owned media is busy. Wait for the current operation; no new media was published.':'The media could not be verified. Check its format, dimensions and integrity.'});
  if(error instanceof z.ZodError)return reply.code(400).send({code:'INVALID_COMMAND',message:'The request does not match the strict API contract.',details:error.issues.map(i=>({path:i.path,code:i.code,message:i.message}))});
  const status=(error as {statusCode?:number}).statusCode;
  if(status&&status>=400&&status<500)return reply.code(status).send({code:status===413?'IMPORT_LIMIT':'INVALID_REQUEST',message:status===413?'The request exceeds the allowed size.':'The request could not be parsed.'});
  return reply.code(500).send({code:'INTERNAL_ERROR',message:'The request could not be completed.'});
 });
 app.addHook('onRequest',async(request,reply)=>{
  const host=request.headers.host,origin=request.headers.origin;
  if(!host||!security.allowedHosts.includes(host))throw new ServiceError('HOST_DENIED','This Host is not allowed.',403);
  if(origin&&!security.allowedOrigins.includes(origin))throw new ServiceError('ORIGIN_DENIED','This Origin is not allowed.',403);
  reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store');
  if(origin){reply.header('Access-Control-Allow-Origin',origin).header('Vary','Origin');}
  if(request.method==='OPTIONS')return reply.header('Access-Control-Allow-Methods','GET,HEAD,POST,OPTIONS').header('Access-Control-Allow-Headers','Content-Type,X-Flume-Client,Authorization').code(204).send();
  if(request.url.split('?')[0]==='/api/health')return;
  let actor:Actor|null=null;
  if(security.mode==='local-operator'){
   if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip))throw new ServiceError('LOCAL_ONLY','Local operator mode accepts loopback connections only.',403);
   // This is an explicit local convenience, NOT human identity or production auth.
   // Originless clients and clients declaring agent are always downgraded.
   const operator=Boolean(origin)&&request.headers['x-flume-client']!=='agent';
   actor={id:operator?operatorId:agentId,kind:operator?'operator':'agent',projectIds:'*'};
  }else if(authenticate)actor=await authenticate(request);
  if(!actor)throw new ServiceError('AUTHENTICATION_REQUIRED','Protected mode needs a server-configured identity provider.',401);
  actors.set(request,actorSchema.parse(actor));
 });
 const actor=(r:FastifyRequest)=>actors.get(r)!;
 app.get('/api/health',async()=>({...await service.health(),authorityMode:security.mode}));
 app.get('/api/projects',async request=>service.listProjects(actor(request)));
 app.get('/api/chat/models',async()=>({models:chat?.models??[]}));
 // Browser POST queries carry Origin; GETs intentionally retain originless-agent semantics.
 app.post('/api/chat/conversations/list',async request=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);const {projectId}=z.strictObject({projectId:uuid}).parse(request.body);return chat.list(actor(request),projectId);});
 app.get('/api/chat/conversations',async request=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);const {projectId}=z.strictObject({projectId:uuid}).parse(request.query);return chat.list(actor(request),projectId);});
 app.post('/api/chat/conversations',async(request,reply)=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);return reply.code(201).send(await chat.create(actor(request),CreateChatSchema.parse(request.body)));});
 app.get('/api/chat/conversations/:conversationId',async request=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);const {conversationId}=z.strictObject({conversationId:uuid}).parse(request.params),{projectId}=z.strictObject({projectId:uuid}).parse(request.query);return chat.get(actor(request),projectId,conversationId);});
 app.post('/api/chat/conversations/:conversationId/rename',async request=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);const {conversationId}=z.strictObject({conversationId:uuid}).parse(request.params);return chat.rename(actor(request),{conversationId,...RenameChatSchema.parse(request.body)});});
 app.post('/api/chat/conversations/:conversationId/shot-edit-proposals',async(request,reply)=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);const {conversationId}=z.strictObject({conversationId:uuid}).parse(request.params);return reply.code(201).send(await chat.propose(actor(request),{conversationId,...ProposeShotEditSchema.parse(request.body)}));});
 app.post('/api/chat/conversations/:conversationId/shot-edit-proposals/:proposalId/apply',async request=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);const {conversationId,proposalId}=z.strictObject({conversationId:uuid,proposalId:uuid}).parse(request.params);return chat.applyProposal(actor(request),{conversationId,proposalId,...ProposalActionSchema.parse(request.body)});});
 app.post('/api/chat/conversations/:conversationId/shot-edit-proposals/:proposalId/dismiss',async request=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);const {conversationId,proposalId}=z.strictObject({conversationId:uuid,proposalId:uuid}).parse(request.params);return chat.dismissProposal(actor(request),{conversationId,proposalId,...ProposalActionSchema.parse(request.body)});});
 app.post('/api/chat/conversations/:conversationId/messages',async(request,reply)=>{if(!chat)throw new ChatError('CHAT_NOT_CONFIGURED','Chat storage is not configured.',503);const {conversationId}=z.strictObject({conversationId:uuid}).parse(request.params),input=SendChatSchema.parse(request.body);reply.hijack();reply.raw.statusCode=200;reply.raw.setHeader('Content-Type','text/event-stream; charset=utf-8');reply.raw.setHeader('Cache-Control','no-store');reply.raw.setHeader('X-Accel-Buffering','no');const abort=new AbortController();request.raw.once('aborted',()=>abort.abort());reply.raw.once('close',()=>{if(!reply.raw.writableEnded)abort.abort();});const emit=(event:string,data:unknown)=>{if(!reply.raw.destroyed)reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};try{await chat.stream(actor(request),{conversationId,...input},abort.signal,emit);}catch(error){emit('error',{message:error instanceof ChatError?error.message:'Chat request failed.',usage:null});}finally{if(!reply.raw.destroyed)reply.raw.end();}});
 app.get('/api/workspace',async request=>{
  const query=z.strictObject({projectId:uuid.optional()}).parse(request.query);
  return service.getWorkspace(actor(request),query.projectId);
 });
 app.post('/api/commands',async request=>service.command(actor(request),request.body));
 app.post('/api/assets',async(request,reply)=>{
  let projectId:string|undefined,file:{filename:string;mimeType:string;bytes:Uint8Array}|undefined;
  for await(const part of request.parts()){
   if(part.type==='file'){
    if(part.fieldname!=='file'||file)throw new ServiceError('INVALID_UPLOAD','Provide one file field.',400);
    const bytes=await part.toBuffer();if(part.file.truncated)throw new ServiceError('IMPORT_LIMIT','The file is too large.',413);
    file={filename:part.filename,mimeType:part.mimetype,bytes};
   }else{
    if(part.fieldname!=='projectId'||projectId!==undefined||typeof part.value!=='string')throw new ServiceError('INVALID_UPLOAD','Provide one projectId field.',400);
    projectId=part.value;
   }
  }
  if(!file||!projectId)throw new ServiceError('INVALID_UPLOAD','Both projectId and file are required.',400);
  return reply.code(201).send(await service.uploadAsset(actor(request),{...file,projectId}));
 });
 app.post('/api/assets/:assetId/frames',async request=>{
  const {assetId}=z.strictObject({assetId:uuid}).parse(request.params),input=z.strictObject({projectId:uuid,frame:z.enum(['first','last'])}).parse(request.body);
  const extraction=(service as unknown as {extractReferenceFrame(actor:Actor,input:{projectId:string;assetId:string;frame:'first'|'last'}):Promise<unknown>}).extractReferenceFrame;
  if(typeof extraction!=='function')throw new ServiceError('REFERENCE_FRAME_UNAVAILABLE','Reference frame extraction is not configured.',503);
  return extraction.call(service,actor(request),{...input,assetId});
 });
 app.get('/api/media/:assetId',async(request,reply)=>{
  const {assetId}=z.strictObject({assetId:uuid}).parse(request.params);
  const media=await service.readMedia(actor(request),assetId),size=media.bytes.length,etag=`"${media.sha256}"`;
  reply.type(media.mimeType).header('Accept-Ranges','bytes').header('ETag',etag).header('Cache-Control','private, no-cache');
  if(request.headers['if-none-match']===etag)return reply.code(304).send();
  const range=request.headers.range;
  if(range&&(!request.headers['if-range']||request.headers['if-range']===etag)){
   const parsed=/^bytes=(\d*)-(\d*)$/.exec(range);
   let start=0,end=size-1;
   if(!parsed||(!parsed[1]&&!parsed[2]))return reply.header('Content-Range',`bytes */${size}`).code(416).send();
   if(!parsed[1]){const suffix=Number(parsed[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return reply.header('Content-Range',`bytes */${size}`).code(416).send();start=Math.max(0,size-suffix);}
   else {start=Number(parsed[1]);end=parsed[2]?Math.min(Number(parsed[2]),size-1):size-1;}
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return reply.header('Content-Range',`bytes */${size}`).code(416).send();
   return reply.header('Content-Range',`bytes ${start}-${end}/${size}`).header('Content-Length',end-start+1).code(206).send(media.bytes.subarray(start,end+1));
  }
  return reply.header('Content-Length',size).send(media.bytes);
 });
 return app;
}
