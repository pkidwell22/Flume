import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createOllamaChatProvider} from '../src/chat-ollama.ts';
import {createChatService} from '../src/chat-service.ts';
import {createFileChatStore} from '../src/chat-store.ts';

const input:any={modelId:'ollama/kimi-k3',messages:[{role:'user',content:'Describe the action.'}],context:{project:{id:randomUUID(),name:'Film',brief:''},shot:null,assets:[],references:[],disclosure:[]},visualImages:[{assetId:randomUUID(),timestampSeconds:0,mimeType:'image/png',base64:'aGVsbG8='}],maxTokens:64};
const streamed=(chunks:Uint8Array[])=>new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}}),{status:200,headers:{'content-type':'application/x-ndjson'}});
const collect=async(provider:any,value:any=input,signal=new AbortController().signal)=>{const events=[];for await(const event of provider.stream(value,signal))events.push(event);return events;};

test('Ollama sends ordered image pixels, maps the cloud model, and excludes thinking from answer text',async()=>{
 let request:any;
 const body='{"message":{"role":"assistant","thinking":"private","content":"café"},"prompt_eval_count":12,"eval_count":3,"done":false}\n{"message":{"role":"assistant","content":" noir"},"done":true,"prompt_eval_count":12,"eval_count":5}\n';
 const bytes=new TextEncoder().encode(body),split=body.indexOf('é')+1;
 const provider=createOllamaChatProvider({getCredential:async()=> 'fixture-not-logged',fetch:async(_url,init)=>{request=JSON.parse(String(init?.body));return streamed([bytes.slice(0,split),bytes.slice(split)]);}});
 const events=[];for await(const event of provider.stream(input,new AbortController().signal))events.push(event);
 assert.equal(request.model,'kimi-k3');assert.equal(request.stream,true);assert.deepEqual(request.messages.at(-1).images,['aGVsbG8=']);
 assert.equal(request.think,false);
 assert.deepEqual(events,[{type:'text',text:'café'},{type:'usage',promptTokens:12,completionTokens:3},{type:'text',text:' noir'},{type:'usage',promptTokens:12,completionTokens:5}]);
 assert.equal(JSON.stringify(request).includes('private'),false);
});

test('Ollama rejects truncated and explicit error streams without retry',async()=>{
 let calls=0;
 const provider=createOllamaChatProvider({getCredential:async()=> 'fixture',fetch:async()=>{calls++;return streamed([new TextEncoder().encode('{"message":{"content":"partial"},"done":false}\n')]);}});
 await assert.rejects(async()=>{for await(const _ of provider.stream(input,new AbortController().signal)){}},{code:'CHAT_PROVIDER_TRUNCATED'});assert.equal(calls,1);
 const errored=createOllamaChatProvider({getCredential:async()=> 'fixture',fetch:async()=>streamed([new TextEncoder().encode('{"error":"bad request"}\n')])});
 await assert.rejects(async()=>{for await(const _ of errored.stream(input,new AbortController().signal)){}},{code:'CHAT_PROVIDER_ERROR'});
});

test('Ollama proposals use prompt JSON and strict parsing without schema-constrained request fields',async()=>{
 let request:any;
 const provider=createOllamaChatProvider({getCredential:async()=> 'fixture',fetch:async(_url,init)=>{request=JSON.parse(String(init?.body));return streamed([new TextEncoder().encode('{"message":{"content":"{\\"title\\":\\"T\\",\\"prompt\\":\\"P\\",\\"rationale\\":\\"R\\"}"},"done":true}\n')]);}});
 const result=await provider.propose!({modelId:'ollama/kimi-k3',instruction:'Use it',shot:{title:'Old',prompt:'Old prompt',revision:1},referenceSource:null,maxTokens:100},new AbortController().signal);
 assert.deepEqual(result,{title:'T',prompt:'P',rationale:'R'});assert.equal('format' in request,false);assert.equal('tools' in request,false);assert.match(request.messages[0].content,/strict JSON/i);
 assert.equal(request.think,false);
});

test('Ollama enforces its internal model id and bounded complete NDJSON frames',async()=>{
 const requests:any[]=[];
 const provider=createOllamaChatProvider({getCredential:async()=> 'fixture',fetch:async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return streamed([new TextEncoder().encode('{"message":{"content":"ok"},"done":true}')]);}});
 assert.deepEqual(await collect(provider),[{type:'text',text:'ok'}]);
 await assert.rejects(()=>collect(provider,{...input,modelId:'google/gemini-2.5-flash'}),{code:'CHAT_MODEL_UNSUPPORTED'});
 assert.equal(requests.length,1);
 const huge=createOllamaChatProvider({getCredential:async()=> 'fixture',fetch:async()=>streamed([new Uint8Array(300_000).fill(97)])});
 await assert.rejects(()=>collect(huge),{code:'CHAT_STREAM_LIMIT'});
});

test('Ollama rejects malformed frames, negative usage, ignored-only and blank answers',async()=>{
 for(const [body,code] of [
  ['not-json\n','CHAT_PROVIDER_FRAME'],
  ['{"message":{"content":"x"},"prompt_eval_count":-1,"eval_count":2,"done":true}\n','CHAT_PROVIDER_FRAME'],
  ['{"message":{"thinking":"secret","content":""},"done":true}\n','CHAT_EMPTY_RESPONSE'],
  ['{"message":{"content":"   "},"done":true}\n','CHAT_EMPTY_RESPONSE'],
 ] as const){const provider=createOllamaChatProvider({getCredential:async()=> 'fixture',fetch:async()=>streamed([new TextEncoder().encode(body)])});await assert.rejects(()=>collect(provider),{code});}
});

test('Ollama cancels and releases its reader when the consumer closes early',async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new TextEncoder().encode('{"message":{"content":"first"},"done":false}\n'));},cancel(){cancelled=true;}}));
 const provider=createOllamaChatProvider({getCredential:async()=> 'fixture',fetch:async()=>response});
 const iterator=provider.stream(input,new AbortController().signal)[Symbol.asyncIterator]();
 assert.deepEqual(await iterator.next(),{done:false,value:{type:'text',text:'first'}});
 await iterator.return?.();
 assert.equal(cancelled,true);
});

test('service resolves owned pixels for Ollama, persists provenance only, and replays without inference',async()=>{
 const actor={id:randomUUID(),kind:'operator' as const,projectIds:'*' as const},projectId=randomUUID(),assetId=randomUUID();
 const asset={id:assetId,projectId,filename:'clip.mp4',kind:'video',origin:'imported',width:512,height:288,sha256:'a'.repeat(64)},reference={assetId,sourceSha256:'a'.repeat(64),kind:'video' as const,durationSeconds:2,totalFrames:2,sampling:'uniform-frame-index-v1' as const,frames:[{index:0,timestampSeconds:0,sha256:'b'.repeat(64)}],audio:'not-analyzed' as const};
 const store=await createFileChatStore({root:await realpath(await mkdtemp(path.join(tmpdir(),'flume-ollama-service-')))}),conversation=await store.create({actorId:actor.id,projectId,title:'Video',modelId:'ollama/gemma4:31b'});let providerCalls=0,resolverCalls=0,received:any;
 const service=createChatService({store,getWorkspace:async()=>({project:{id:projectId,name:'Film',brief:'',revision:1},shots:[],assets:[asset]}),resolveVisual:async()=>{resolverCalls++;return{reference,images:[{assetId,timestampSeconds:0,mimeType:'image/png',base64:'pixels'}]};},provider:{async *stream(value){providerCalls++;received=value;yield{type:'text' as const,text:'A person crosses.'};}}});
 const request={projectId,conversationId:conversation.id,requestId:randomUUID(),modelId:'ollama/gemma4:31b' as const,content:'What happens?',context:{assetIds:[assetId]}};
 await service.stream(actor,request,new AbortController().signal,()=>{});assert.deepEqual(received.visualImages,[{assetId,timestampSeconds:0,mimeType:'image/png',base64:'pixels'}]);
 const saved=await store.get({actorId:actor.id,projectId,conversationId:conversation.id});assert.deepEqual(saved.messages[1]?.recordedContext?.references,[reference]);assert.equal(JSON.stringify(saved).includes('"base64"'),false);
 await service.stream(actor,request,new AbortController().signal,()=>{});assert.equal(providerCalls,1);assert.equal(resolverCalls,1,'durable replay prevents both resolution and paid inference');
});

test('service claims concurrent visual requests once and cancellation after resolution prevents inference',async()=>{
 const actor={id:randomUUID(),kind:'operator' as const,projectIds:'*' as const},projectId=randomUUID(),assetId=randomUUID(),root=await realpath(await mkdtemp(path.join(tmpdir(),'flume-claim-'))),store=await createFileChatStore({root});
 const conversation=await store.create({actorId:actor.id,projectId,title:'Video',modelId:'ollama/gemma4:31b'}),asset={id:assetId,projectId,filename:'still.png',kind:'image',origin:'imported',width:10,height:10,sha256:'a'.repeat(64)};
 let resolveCalls=0,providerCalls=0;const abort=new AbortController();
 const service=createChatService({store,getWorkspace:async()=>({project:{id:projectId,name:'Film',brief:'',revision:1},shots:[],assets:[asset]}),resolveVisual:async()=>{resolveCalls++;abort.abort();return{reference:{assetId,sourceSha256:'a'.repeat(64),kind:'image',durationSeconds:null,totalFrames:1,sampling:'still-image-v1',frames:[{index:0,timestampSeconds:0,sha256:'b'.repeat(64)}],audio:'not-analyzed'},images:[{assetId,timestampSeconds:0,mimeType:'image/png',base64:'eA=='}]};},provider:{async *stream(){providerCalls++;yield{type:'text' as const,text:'no'};}}});
 const request={projectId,conversationId:conversation.id,requestId:randomUUID(),modelId:'ollama/gemma4:31b' as const,content:'Inspect',context:{assetIds:[assetId]}};
 await Promise.all([service.stream(actor,request,abort.signal,()=>{}),service.stream(actor,request,new AbortController().signal,()=>{})]);
 assert.equal(resolveCalls,1);assert.equal(providerCalls,0);
 const saved=await store.get({actorId:actor.id,projectId,conversationId:conversation.id});assert.equal(saved.messages[1]?.recordedContext?.references.length,1);assert.equal(JSON.stringify(saved).includes('"base64":'),false);
});

test('service rejects duplicate references and aggregate resolved image bytes',async()=>{
 const actor={id:randomUUID(),kind:'operator' as const,projectIds:'*' as const},projectId=randomUUID(),assetId=randomUUID(),store=await createFileChatStore({root:await realpath(await mkdtemp(path.join(tmpdir(),'flume-limits-')))}),asset={id:assetId,projectId,filename:'still.png',kind:'image',origin:'imported',width:10,height:10,sha256:'a'.repeat(64)};
 const conversation=await store.create({actorId:actor.id,projectId,title:'Limits',modelId:'ollama/gemma4:31b'}),service=createChatService({store,getWorkspace:async()=>({project:{id:projectId,name:'Film',brief:'',revision:1},shots:[],assets:[asset]}),resolveVisual:async()=>({reference:{assetId,sourceSha256:'a'.repeat(64),kind:'image',durationSeconds:null,totalFrames:1,sampling:'still-image-v1',frames:[{index:0,timestampSeconds:0,sha256:'b'.repeat(64)}],audio:'not-analyzed'},images:[{assetId,timestampSeconds:0,mimeType:'image/png',base64:'a'.repeat(8_400_000)}]}),provider:{async *stream(){yield{type:'text' as const,text:'no'};}}});
 await assert.rejects(service.stream(actor,{projectId,conversationId:conversation.id,requestId:randomUUID(),modelId:'ollama/gemma4:31b',content:'x',context:{assetIds:[assetId,assetId]}},new AbortController().signal,()=>{}),{code:'CHAT_DUPLICATE_ASSET'});
 await service.stream(actor,{projectId,conversationId:conversation.id,requestId:randomUUID(),modelId:'ollama/gemma4:31b',content:'x',context:{assetIds:[assetId]}},new AbortController().signal,()=>{});
 const saved=await store.get({actorId:actor.id,projectId,conversationId:conversation.id});assert.equal(saved.messages.at(-1)?.status,'error');assert.match(saved.messages.at(-1)?.error??'',/budget/i);
});
