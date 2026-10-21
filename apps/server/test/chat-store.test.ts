import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFileChatStore } from '../src/chat-store.ts';

test('file chat store persists conversations privately and deduplicates request IDs', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'flume-chat-store-')));
  const actorId = randomUUID(), projectId = randomUUID(), requestId = randomUUID();
  const store = await createFileChatStore({ root });
  const conversation = await store.create({ actorId, projectId, title: 'Lighting notes', modelId: 'google/gemini-2.5-flash-lite' });
  const first = await store.beginTurn({ actorId, projectId, conversationId: conversation.id, requestId, content: 'Make it warmer.', fingerprint: 'fingerprint-a', recordedContext: { project: { id: projectId, name: 'Film', brief: 'Warm' }, shot: null, assets: [], disclosure: [] } });
  const replay = await store.beginTurn({ actorId, projectId, conversationId: conversation.id, requestId, content: 'Make it warmer.', fingerprint: 'fingerprint-a', recordedContext: { project: { id: projectId, name: 'Film', brief: 'Warm' }, shot: null, assets: [], disclosure: [] } });
  assert.equal(replay.userMessageId, first.userMessageId); assert.equal(replay.assistantMessageId, first.assistantMessageId); assert.equal(replay.replayState, 'in_progress');
  await assert.rejects(store.beginTurn({ actorId, projectId, conversationId: conversation.id, requestId, content: 'Make it warmer.', fingerprint: 'fingerprint-b', recordedContext: { project: { id: projectId, name: 'Film', brief: 'Changed' }, shot: null, assets: [], disclosure: [] } }), { code: 'CHAT_REQUEST_CONFLICT' });
  await store.finishTurn({ actorId, projectId, conversationId: conversation.id, assistantMessageId: first.assistantMessageId, content: 'Use late-afternoon tungsten bounce.', usage: { promptTokens: 12, completionTokens: 7 } });
  const reopened = await createFileChatStore({ root });
  const saved = await reopened.get({ actorId, projectId, conversationId: conversation.id });
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[1]?.status, 'completed');
  assert.deepEqual(saved.messages[1]?.usage, { promptTokens: 12, completionTokens: 7 });
  const file = path.join(root, actorId, projectId, `${conversation.id}.json`);
  assert.equal((await lstat(file)).mode & 0o077, 0);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projectId, projectId);
});

test('file chat store marks an interrupted streaming turn stopped after restart and rejects unsafe IDs', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'flume-chat-store-')));
  const actorId = randomUUID(), projectId = randomUUID();
  const store = await createFileChatStore({ root });
  const conversation = await store.create({ actorId, projectId, title: 'Interrupted', modelId: 'google/gemini-2.5-flash-lite' });
  const active = await store.beginTurn({ actorId, projectId, conversationId: conversation.id, requestId: randomUUID(), content: 'Continue.', fingerprint: 'active', recordedContext: { project: { id: projectId, name: 'Film', brief: '' }, shot: null, assets: [], disclosure: [] } });
  assert.equal((await store.get({ actorId, projectId, conversationId: conversation.id })).messages.at(-1)?.status, 'streaming', 'reads must not stop this process live turn');
  assert.equal(active.replayState, 'new');
  const reopened = await createFileChatStore({ root });
  const saved = await reopened.get({ actorId, projectId, conversationId: conversation.id });
  assert.equal(saved.messages.at(-1)?.status, 'stopped');
  await assert.rejects(reopened.get({ actorId, projectId, conversationId: '../escape' }), { code: 'INVALID_CHAT_ID' });
});

test('file chat store rejects a symlink root before changing its target', async () => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'flume-chat-symlink-')));
  const target = path.join(parent, 'target');
  await (await import('node:fs/promises')).mkdir(target, { mode: 0o755 });
  const linked = path.join(parent, 'linked'); await symlink(target, linked);
  await assert.rejects(createFileChatStore({ root: linked }), { code: 'INVALID_CHAT_ROOT' });
  assert.equal((await lstat(target)).mode & 0o777, 0o755);
});
