import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpenRouterChatProvider} from '../src/chat-service.ts';
test('OpenRouter parse failures cancel the upstream body instead of only releasing its reader',async()=>{
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: invalid-json\n\n'));},cancel(){cancelled=true;}});
 const provider=createOpenRouterChatProvider({getCredential:async()=> 'fixture-only-not-a-credential',fetch:async()=>new Response(body,{status:200})});
 await assert.rejects(async()=>{for await(const ignored of provider.stream({modelId:'google/gemini-2.5-flash-lite',messages:[{role:'user',content:'Fixture'}],context:{project:{id:'10000000-0000-4000-8000-000000000001',name:'Fixture',brief:''},shot:null,assets:[],disclosure:[]},maxTokens:8},new AbortController().signal)){void ignored;}},{code:'CHAT_PROVIDER_FRAME'});
 assert.equal(cancelled,true);
});
