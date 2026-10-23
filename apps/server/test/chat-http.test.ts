import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildServer, createChatService, createFileChatStore, ServiceError } from '../src/index.ts';

const headers = { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' };
test('reference frame endpoint accepts only project and first/last selection',async()=>{
 const projectId=randomUUID(),assetId=randomUUID();let received:any;
 const service={health:async()=>({}),extractReferenceFrame:async(_actor:any,input:any)=>{received=input;return{id:randomUUID(),...input};}} as any;
 const app=await buildServer({service,security:{mode:'local-operator',allowedHosts:[headers.host],allowedOrigins:[headers.origin]}});
 const response=await app.inject({method:'POST',url:`/api/assets/${assetId}/frames`,headers,payload:{projectId,frame:'last'}});assert.equal(response.statusCode,200);assert.deepEqual(received,{projectId,assetId,frame:'last'});
 const invalid=await app.inject({method:'POST',url:`/api/assets/${assetId}/frames`,headers,payload:{projectId,frame:'middle'}});assert.equal(invalid.statusCode,400);await app.close();
});
test('chat routes enforce project ownership, stream real provider events, and do not call provider when opened', async () => {
  const projectId = randomUUID(), shotId = randomUUID(), assetId = randomUUID();
  let calls = 0, cancelled = false;
  const workspace = { project: { id: projectId, name: 'Film', brief: 'Warm noir', revision: 1 }, shots: [{ id: shotId, projectId, title: 'Doorway', prompt: 'A figure enters', revision: 3, controls: { modelId: 'm', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: assetId, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 }], assets: [{ id: assetId, projectId, filename: 'owned.png', kind: 'image', origin: 'imported', sha256: 'a'.repeat(64), mediaUrl: `/api/media/${assetId}`, width: 1, height: 1 }], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
  const commandService = { health: async () => ({ store: 'fixture' }), listProjects: async () => [workspace.project], getWorkspace: async (_actor: unknown, id?: string) => { if (id !== projectId) throw new ServiceError('FORBIDDEN','Project access is not granted.',403); return workspace; }, command: async () => { throw new Error('unused'); }, uploadAsset: async () => { throw new Error('unused'); }, readMedia: async () => { throw new Error('unused'); } } as any;
  const store = await createFileChatStore({ root: await realpath(await mkdtemp(path.join(tmpdir(), 'flume-chat-http-'))) });
  const provider = { async *stream(_input: unknown, signal: AbortSignal) { calls++; yield { type: 'text' as const, text: 'Try a ' }; if (signal.aborted) cancelled = true; yield { type: 'text' as const, text: 'warmer key.' }; yield { type: 'usage' as const, promptTokens: 20, completionTokens: 5 }; } };
  const chat = createChatService({ store, provider, getWorkspace: commandService.getWorkspace });
  const app = await buildServer({ service: commandService, chat, security: { mode: 'local-operator', allowedHosts: [headers.host], allowedOrigins: [headers.origin] } });
  const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', headers, payload: { projectId, title: 'Scene', modelId: 'google/gemini-2.5-flash-lite' } });
  assert.equal(created.statusCode, 201, created.body); assert.equal(calls, 0, 'opening chat is free');
  const conversationId = created.json().id;
  const listed = await app.inject({ url: `/api/chat/conversations?projectId=${projectId}`, headers });
  assert.equal(listed.statusCode, 200); assert.equal(calls, 0);
  const browserList = await app.inject({ method: 'POST', url: '/api/chat/conversations/list', headers, payload: { projectId } });
  assert.equal(browserList.statusCode, 200); assert.ok(browserList.json().some((item: any) => item.id === conversationId));
  const originless = await app.inject({ url: `/api/chat/conversations?projectId=${projectId}`, headers: { host: headers.host } });
  assert.deepEqual(originless.json(), [], 'originless clients remain a separate agent identity');
  const response = await app.inject({ method: 'POST', url: `/api/chat/conversations/${conversationId}/messages`, headers, payload: { projectId, requestId: randomUUID(), modelId: 'google/gemini-2.5-flash-lite', content: 'How should I light this?', context: { shotId, assetIds: [assetId] } } });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'] ?? '', /^text\/event-stream/);
  assert.match(response.body, /event: context/); assert.match(response.body, /owned\.png/); assert.match(response.body, /event: delta/); assert.match(response.body, /warmer key/); assert.match(response.body, /event: done/);
  assert.equal(calls, 1); assert.equal(cancelled, false);
  const denied = await app.inject({ method: 'POST', url: '/api/chat/conversations', headers, payload: { projectId: randomUUID(), title: 'No', modelId: 'google/gemini-2.5-flash-lite' } });
  assert.equal(denied.statusCode, 403);
  await app.close();
});

test('chat service bounds history and rejects concurrent distinct paid turns', async () => {
  const projectId = randomUUID(), actor = { id: randomUUID(), projectIds: [projectId] } as any;
  const workspace = { project: { id: projectId, name: 'Film', brief: 'Brief', revision: 1 }, shots: [], assets: [] };
  const store = await createFileChatStore({ root: await realpath(await mkdtemp(path.join(tmpdir(), 'flume-chat-bounds-'))) });
  const conversation = await store.create({ actorId: actor.id, projectId, title: 'Scene', modelId: 'google/gemini-2.5-flash-lite' });
  for (let i = 0; i < 8; i++) { const turn = await store.beginTurn({ actorId: actor.id, projectId, conversationId: conversation.id, requestId: randomUUID(), content: `u${i}`.padEnd(5000, 'u'), fingerprint: `old-${i}`, recordedContext: { project: { id: projectId, name: 'Film', brief: 'Brief' }, shot: null, assets: [], disclosure: [] } }); await store.finishTurn({ actorId: actor.id, projectId, conversationId: conversation.id, assistantMessageId: turn.assistantMessageId, content: `a${i}`.padEnd(5000, 'a'), usage: null }); }
  let release!: () => void, submitted = 0, sentChars = 0; const hold = new Promise<void>(resolve => { release = resolve; });
  const provider = { async *stream(input: any) { submitted++; sentChars = input.messages.reduce((n: number, message: any) => n + message.content.length, 0); await hold; yield { type: 'text' as const, text: 'ok' }; } };
  const chat = createChatService({ store, provider, getWorkspace: async () => workspace });
  const first = chat.stream(actor, { projectId, conversationId: conversation.id, requestId: randomUUID(), modelId: conversation.modelId, content: 'new', context: { assetIds: [] } }, new AbortController().signal, () => {});
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(chat.stream(actor, { projectId, conversationId: conversation.id, requestId: randomUUID(), modelId: conversation.modelId, content: 'distinct', context: { assetIds: [] } }, new AbortController().signal, () => {}), { code: 'CHAT_TURN_IN_PROGRESS' });
  assert.equal(submitted, 1); assert.ok(sentChars <= 32_000); release(); await first;
});

test('OpenRouter parser rejects truncated streams and handles CRLF DONE framing', async () => {
  const { createOpenRouterChatProvider } = await import('../src/chat-service.ts');
  const response = (body: string) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const input: any = { modelId: 'google/gemini-2.5-flash-lite', messages: [], context: { project: { id: randomUUID(), name: 'x', brief: '' }, shot: null, assets: [], disclosure: [] }, maxTokens: 10 };
  const truncated = createOpenRouterChatProvider({ getCredential: async () => 'not-logged', fetch: async () => response('data: {"choices":[{"delta":{"content":"partial"}}]}\n') });
  await assert.rejects(async () => { for await (const _ of truncated.stream(input, new AbortController().signal)) {} }, { code: 'CHAT_PROVIDER_TRUNCATED' });
  const complete = createOpenRouterChatProvider({ getCredential: async () => 'not-logged', fetch: async () => response('data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\ndata: [DONE]\r\n\r\n') });
  const events = []; for await (const event of complete.stream(input, new AbortController().signal)) events.push(event);
  assert.deepEqual(events, [{ type: 'text', text: 'ok' }]);
});
