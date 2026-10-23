import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createContainerChat} from '../src/container-chat.ts';
const getWorkspace=async()=>({project:null,shots:[],assets:[]});

test('container chat routes Apply through the supplied command service without inference',async t=>{
 const {randomUUID}=await import('node:crypto');const {createFileChatStore}=await import('../src/chat-store.ts');
 t.mock.method(globalThis,'fetch',()=>{throw new Error('Apply must not call a model');});
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'flume-container-apply-')));
 try{
  const actor={id:randomUUID(),kind:'operator' as const,projectIds:'*' as const},projectId=randomUUID(),shotId=randomUUID();
  const file=path.join(root,'key'),chatRoot=path.join(root,'chat');await writeFile(file,'fixture-only-not-a-credential',{mode:0o600});
  const workspace={project:{id:projectId,name:'Fixture',brief:'',revision:1},shots:[{id:shotId,projectId,title:'Before',prompt:'Before prompt',revision:1,controls:{aspectRatio:'16:9'}}],assets:[]};let commands=0;
  const chat=await (createContainerChat as any)({FLUME_CHAT_STORE_ROOT:chatRoot,FLUME_CHAT_API_KEY_FILE:file},async()=>workspace,async(_actor:any,command:any)=>{commands++;assert.equal(command.type,'shot.update');return{commandId:command.commandId,projectId,resourceId:shotId,revision:2};});
  const seed=await createFileChatStore({root:chatRoot}),modelId='google/gemini-2.5-flash-lite' as const;
  const c=await seed.create({actorId:actor.id,projectId,title:'Fixture',modelId}),now=new Date().toISOString(),proposalId=randomUUID();
  await seed.createProposal({actorId:actor.id,projectId,conversationId:c.id,proposal:{id:proposalId,actorId:actor.id,projectId,conversationId:c.id,shotId,modelId,requestId:randomUUID(),requestFingerprint:'a'.repeat(64),applyCommandId:randomUUID(),instruction:'Fixture edit',referenceSource:null,before:{title:'Before',prompt:'Before prompt',revision:1},after:{title:'After',prompt:'After prompt'},rationale:'Fixture',status:'pending',failure:null,appliedRevision:null,createdAt:now,updatedAt:now}});
  const applied=await chat.applyProposal(actor,{projectId,conversationId:c.id,proposalId});assert.equal(applied.status,'applied');assert.equal(applied.appliedRevision,2);assert.equal(commands,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('container text chat is absent by default without reading provider secrets',async()=>{
 assert.equal(await createContainerChat({FLUME_CHAT_API_KEY_FILE:'/does-not-exist'},getWorkspace),undefined);
});
test('explicit container chat requires a dedicated secret file',async()=>{
 await assert.rejects(createContainerChat({FLUME_CHAT_STORE_ROOT:'/unused'},getWorkspace),/FLUME_CHAT_API_KEY_FILE/);
});
test('configured container chat advertises only configured provider models',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'flume-container-chat-')));
 try{const file=path.join(root,'key');await writeFile(file,'fixture-only-not-a-credential',{mode:0o600});const chat=await createContainerChat({FLUME_CHAT_STORE_ROOT:path.join(root,'chat'),FLUME_OLLAMA_API_KEY_FILE:file},getWorkspace);assert.ok(chat);assert.deepEqual(chat.models,['ollama/kimi-k3','ollama/gemma4:31b']);}finally{await rm(root,{recursive:true,force:true});}
});

test('container chat ignores inherited inline credentials and remains secret-file-only',async()=>{
 await assert.rejects(createContainerChat({FLUME_CHAT_STORE_ROOT:'/unused',OPENROUTER_API_KEY:'inline-must-not-be-used'},getWorkspace),/secret file|required/i);
});

test('standalone credential resolver preserves the legacy OPENROUTER_API_KEY path',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'flume-standalone-chat-')));
 try{
  const chat=await createContainerChat({FLUME_CHAT_STORE_ROOT:path.join(root,'chat'),OPENROUTER_API_KEY:'fixture-inline-not-logged'},getWorkspace,undefined,undefined,env=>env.OPENROUTER_API_KEY??null);
  assert.ok(chat);assert.deepEqual(chat.models,['google/gemini-2.5-flash-lite','google/gemini-2.5-flash','openai/gpt-4.1-mini']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('legacy-only container defaults new chats to an enabled model while disabled saved chats remain read-only',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'flume-container-legacy-'))),projectId=(await import('node:crypto')).randomUUID(),shotId=(await import('node:crypto')).randomUUID();
 try{const file=path.join(root,'key'),chatRoot=path.join(root,'chat');await writeFile(file,'fixture-only-not-a-credential',{mode:0o600});const chat=await createContainerChat({FLUME_CHAT_STORE_ROOT:chatRoot,FLUME_CHAT_API_KEY_FILE:file},async()=>({project:{id:projectId,name:'Film',brief:'',revision:1},shots:[{id:shotId,projectId,title:'Shot',prompt:'Prompt',revision:1,controls:{aspectRatio:'16:9'}}],assets:[]}));assert.ok(chat);assert.equal(chat.models.includes('ollama/gemma4:31b'),false);const actor={id:(await import('node:crypto')).randomUUID(),kind:'operator' as const,projectIds:'*' as const};const conversation=await chat.create(actor,{projectId,title:'Legacy'});assert.equal(conversation.modelId,'google/gemini-2.5-flash-lite');await assert.rejects(chat.create(actor,{projectId,title:'Disabled',modelId:'ollama/gemma4:31b'}),{code:'CHAT_MODEL_DISABLED'});const seed=await (await import('../src/chat-store.ts')).createFileChatStore({root:chatRoot}),saved=await seed.create({actorId:actor.id,projectId,title:'Saved Ollama',modelId:'ollama/gemma4:31b'});assert.equal((await chat.get(actor,projectId,saved.id)).id,saved.id);await assert.rejects(chat.stream(actor,{projectId,conversationId:saved.id,requestId:(await import('node:crypto')).randomUUID(),modelId:'ollama/gemma4:31b',content:'No inference',context:{assetIds:[]}},new AbortController().signal,()=>{}),{code:'CHAT_MODEL_DISABLED'});await assert.rejects(chat.propose(actor,{projectId,conversationId:saved.id,requestId:(await import('node:crypto')).randomUUID(),modelId:'ollama/gemma4:31b',shotId,instruction:'No inference'}),{code:'CHAT_MODEL_DISABLED'});}finally{await rm(root,{recursive:true,force:true});}
});
