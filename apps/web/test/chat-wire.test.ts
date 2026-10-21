import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createHttpChatPort} from '../src/ChatPanel.tsx';
test('chat sends its JSON request with the declared JSON content type',async()=>{
 const port=createHttpChatPort(async(_url,init)=>{
  assert.equal(new Headers(init?.headers).get('content-type'),'application/json');
  assert.equal(JSON.parse(String(init?.body)).content,'Wire fixture');
  assert.equal(Object.hasOwn(JSON.parse(String(init?.body)),'conversationId'),false,'Route identity must not violate the strict message body schema');
  return new Response('event: done\ndata: {"status":"completed","content":"Fixture","usage":null}\n\n',{headers:{'content-type':'text/event-stream'}});
 });
 await port.stream({projectId:randomUUID(),conversationId:randomUUID(),requestId:randomUUID(),modelId:'google/gemini-2.5-flash-lite',content:'Wire fixture',context:{shotId:null,assetIds:[]}},new AbortController().signal,()=>{});
});
