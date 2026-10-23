import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpChatPort} from '../src/ChatPanel.tsx';
test('browser parser failure cancels SSE so the gateway can abort upstream inference',async()=>{
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('event: delta\ndata: invalid-json\n\n'));},cancel(){cancelled=true;}});
 const port=createHttpChatPort(async()=>new Response(body,{status:200,headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(port.stream({projectId:'10000000-0000-4000-8000-000000000001',conversationId:'10000000-0000-4000-8000-000000000002',requestId:'10000000-0000-4000-8000-000000000003',modelId:'ollama/kimi-k3',content:'Fixture',context:{shotId:null,assetIds:[]}},new AbortController().signal,()=>{}));
 assert.equal(cancelled,true);
});
