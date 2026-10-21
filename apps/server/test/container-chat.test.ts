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
  await seed.createProposal({actorId:actor.id,projectId,conversationId:c.id,proposal:{id:proposalId,actorId:actor.id,projectId,conversationId:c.id,shotId,modelId,requestId:randomUUID(),requestFingerprint:'a'.repeat(64),applyCommandId:randomUUID(),instruction:'Fixture edit',before:{title:'Before',prompt:'Before prompt',revision:1},after:{title:'After',prompt:'After prompt'},rationale:'Fixture',status:'pending',failure:null,appliedRevision:null,createdAt:now,updatedAt:now}});
  const applied=await chat.applyProposal(actor,{projectId,conversationId:c.id,proposalId});assert.equal(applied.status,'applied');assert.equal(applied.appliedRevision,2);assert.equal(commands,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('container text chat is absent by default without reading provider secrets',async()=>{
 assert.equal(await createContainerChat({FLUME_CHAT_API_KEY_FILE:'/does-not-exist'},getWorkspace),undefined);
});
test('explicit container chat requires a dedicated secret file',async()=>{
 await assert.rejects(createContainerChat({FLUME_CHAT_STORE_ROOT:'/unused'},getWorkspace),/FLUME_CHAT_API_KEY_FILE/);
});
test('configured container chat attaches private storage without provider calls',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'flume-container-chat-')));
 try{const file=path.join(root,'key');await writeFile(file,'fixture-only-not-a-credential',{mode:0o600});const chat=await createContainerChat({FLUME_CHAT_STORE_ROOT:path.join(root,'chat'),FLUME_CHAT_API_KEY_FILE:file},getWorkspace);assert.ok(chat);assert.ok(chat.models.includes('google/gemini-2.5-flash-lite'));}finally{await rm(root,{recursive:true,force:true});}
});
