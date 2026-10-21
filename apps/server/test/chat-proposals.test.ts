import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatError, createChatService, createFileChatStore } from '../src/index.ts';

const modelId = 'google/gemini-2.5-flash-lite' as const;
const setup = async () => {
  const actor = { id: randomUUID(), kind: 'operator', projectIds: '*' } as const;
  const projectId = randomUUID(), shotId = randomUUID();
  let shot = { id: shotId, projectId, title: 'Doorway', prompt: 'A figure enters', revision: 3, controls: { aspectRatio: '16:9' } };
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'flume-proposals-'))), store = await createFileChatStore({ root });
  const conversation = await store.create({ actorId: actor.id, projectId, title: 'Scene', modelId });
  const commands: any[] = [];
  const service = createChatService({
    store,
    provider: { async *stream() {}, async propose() { return { title: 'Threshold', prompt: 'A silhouette crosses the warm threshold.', rationale: 'Clarifies subject and light.' }; } },
    getWorkspace: async () => ({ project: { id: projectId, name: 'Film', brief: '', revision: 1 }, shots: [shot], assets: [] }),
    command: async (_actor, command) => { commands.push(command); if (command.expectedRevision !== shot.revision) { const error: any = new Error('stale'); error.code = 'REVISION_CONFLICT'; error.currentRevision = shot.revision; throw error; } shot = { ...shot, ...command.patch, revision: shot.revision + 1 }; return { commandId: command.commandId, projectId, resourceId: shotId, revision: shot.revision }; },
  });
  return { actor, projectId, shotId, conversation, root, store, service, commands, getShot: () => shot, setShot: (next: typeof shot) => { shot = next; } };
};

test('proposal freezes server-owned shot identity and applies immutable edits once through shot.update', async () => {
  const x = await setup(), requestId = randomUUID();
  const proposal = await x.service.propose(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, requestId, modelId, shotId: x.shotId, instruction: 'Make the entrance more specific.' });
  assert.deepEqual(proposal.before, { title: 'Doorway', prompt: 'A figure enters', revision: 3 });
  assert.deepEqual(proposal.after, { title: 'Threshold', prompt: 'A silhouette crosses the warm threshold.' });
  assert.equal(proposal.status, 'pending'); assert.equal(proposal.shotId, x.shotId);
  const replay = await x.service.propose(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, requestId, modelId, shotId: x.shotId, instruction: 'Make the entrance more specific.' });
  assert.equal(replay.id, proposal.id);
  await assert.rejects(x.service.propose(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, requestId, modelId, shotId: x.shotId, instruction: 'Different intent.' }), { code: 'CHAT_REQUEST_CONFLICT' });
  const applied = await x.service.applyProposal(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, proposalId: proposal.id });
  assert.equal(applied.status, 'applied'); assert.equal(applied.appliedRevision, 4);
  assert.equal(x.commands.length, 1); assert.deepEqual(x.commands[0].patch, proposal.after);
  const duplicate = await x.service.applyProposal(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, proposalId: proposal.id });
  assert.equal(duplicate.status, 'applied'); assert.equal(x.commands.length, 1);
});

test('proposal apply requires an operator even for an otherwise authorized actor', async () => {
  const x = await setup();
  const proposal = await x.service.propose(x.actor, { projectId:x.projectId, conversationId:x.conversation.id, requestId:randomUUID(), modelId, shotId:x.shotId, instruction:'Reviewed edit' });
  await assert.rejects(x.service.applyProposal({ ...x.actor, kind:'agent' }, { projectId:x.projectId, conversationId:x.conversation.id, proposalId:proposal.id }), { code:'CHAT_OPERATOR_REQUIRED' });
  assert.equal(x.commands.length,0);
});

test('dismiss persists without mutation and stale or cross-scope apply is blocked', async () => {
  const x = await setup();
  const proposal = await x.service.propose(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, requestId: randomUUID(), modelId, shotId: x.shotId, instruction: 'Tighten it.' });
  const dismissed = await x.service.dismissProposal(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, proposalId: proposal.id });
  assert.equal(dismissed.status, 'dismissed'); assert.equal(x.commands.length, 0);
  await assert.rejects(x.service.applyProposal(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, proposalId: proposal.id }), { code: 'CHAT_PROPOSAL_NOT_PENDING' });

  const stale = await x.service.propose(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, requestId: randomUUID(), modelId, shotId: x.shotId, instruction: 'Try again.' });
  x.setShot({ ...x.getShot(), revision: 4, prompt: 'Changed elsewhere' });
  await assert.rejects(x.service.applyProposal(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, proposalId: stale.id }), { code: 'CHAT_PROPOSAL_STALE' });
  const outsider = { ...x.actor, id: randomUUID() };
  await assert.rejects(x.service.applyProposal(outsider, { projectId: x.projectId, conversationId: x.conversation.id, proposalId: stale.id }), { code: 'CHAT_NOT_FOUND' });
});

test('malformed structured provider output is rejected and the failed instruction remains durable', async () => {
  const x = await setup();
  const broken = createChatService({ store: x.store, provider: { async *stream() {}, async propose() { return { title: 'No', prompt: 'No', rationale: 'No', shotId: x.shotId }; } }, getWorkspace: async () => ({ project: { id: x.projectId, name: 'Film', brief: '', revision: 1 }, shots: [x.getShot()], assets: [] }), command: async () => { throw Error('unused'); } });
  await assert.rejects(broken.propose(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, requestId: randomUUID(), modelId, shotId: x.shotId, instruction: 'Please preserve this instruction.' }), { code: 'CHAT_PROPOSAL_INVALID' });
  const saved = await x.store.get({ actorId: x.actor.id, projectId: x.projectId, conversationId: x.conversation.id });
  assert.equal(saved.proposals.at(-1)?.instruction, 'Please preserve this instruction.');
  assert.equal(saved.proposals.at(-1)?.status, 'failed');
});

test('provider failure is persisted honestly without fallback or retry', async () => {
  const x = await setup(); let calls = 0;
  const failed = createChatService({ store: x.store, provider: { async *stream() {}, async propose() { calls++; throw new ChatError('CHAT_PROVIDER_ERROR', 'Provider unavailable.', 502); } }, getWorkspace: async () => ({ project: { id: x.projectId, name: 'Film', brief: '', revision: 1 }, shots: [x.getShot()], assets: [] }), command: async () => { throw Error('unused'); } });
  const input = { projectId: x.projectId, conversationId: x.conversation.id, requestId: randomUUID(), modelId, shotId: x.shotId, instruction: 'Preserve this.' };
  await assert.rejects(failed.propose(x.actor, input), { code: 'CHAT_PROVIDER_ERROR' });
  const replay = await failed.propose(x.actor, input); assert.equal(replay.status, 'failed'); assert.equal(replay.failure, 'Provider unavailable.'); assert.equal(calls, 1);
});

test('concurrent duplicate proposals atomically claim one inference and replays never infer again', async () => {
  const x = await setup(); let calls = 0, release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = createChatService({
    store: x.store,
    provider: { async *stream() {}, async propose() { calls++; entered(); await held; return { title: 'Threshold', prompt: 'A silhouette crosses.', rationale: 'Specific.' }; } },
    getWorkspace: async () => ({ project: { id: x.projectId, name: 'Film', brief: '', revision: 1 }, shots: [x.getShot()], assets: [] }),
  });
  const input = { projectId: x.projectId, conversationId: x.conversation.id, requestId: randomUUID(), modelId, shotId: x.shotId, instruction: 'Make it specific.' };
  const first = service.propose(x.actor, input), duplicate = service.propose(x.actor, input);
  await started; await new Promise(resolve => setTimeout(resolve, 20)); release();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(calls, 1); assert.equal(a.id, b.id);
  assert.ok(['inferring', 'pending'].includes(b.status));
  const replay = await service.propose(x.actor, input); assert.equal(replay.status, 'pending'); assert.equal(calls, 1);
});

test('reopened interrupted inference returns its durable non-actionable state without retry', async () => {
  const x = await setup(), now = new Date().toISOString(), requestId = randomUUID();
  const request = { projectId: x.projectId, conversationId: x.conversation.id, requestId, modelId, shotId: x.shotId, instruction: 'Interrupted' };
  const before = { title: 'Doorway', prompt: 'A figure enters', revision: 3 };
  const requestFingerprint = createHash('sha256').update(JSON.stringify({ ...request, before })).digest('hex');
  await x.store.createProposal({ actorId: x.actor.id, projectId: x.projectId, conversationId: x.conversation.id, proposal: {
    id: randomUUID(), requestId, requestFingerprint, applyCommandId: randomUUID(), actorId: x.actor.id, projectId: x.projectId,
    conversationId: x.conversation.id, shotId: x.shotId, modelId, instruction: 'Interrupted', before,
    after: null, rationale: null, status: 'inferring', failure: 'Proposal inference was interrupted. It was not retried.', appliedRevision: null, createdAt: now, updatedAt: now,
  } as any });
  let calls = 0;
  const reopenedStore = await createFileChatStore({ root: x.root });
  const reopened = createChatService({ store: reopenedStore, provider: { async *stream() {}, async propose() { calls++; throw Error('must not run'); } }, getWorkspace: async () => ({ project: { id: x.projectId, name: 'Film', brief: '', revision: 1 }, shots: [x.getShot()], assets: [] }) });
  const result = await reopened.propose(x.actor, request);
  assert.equal(result.status, 'failed'); assert.match(result.failure ?? '', /server restarted.*not retried/i); assert.equal(calls, 0);
});

test('reconciliation replays the immutable command id and recovers after command success precedes proposal persistence', async () => {
  const x = await setup();
  const proposal = await x.service.propose(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, requestId: randomUUID(), modelId, shotId: x.shotId, instruction: 'Apply once.' });
  const base = x.store; let failAppliedWrite = true, commandCalls = 0; const receipts = new Map<string, any>();
  const store = { ...base, updateProposal: async (input: any) => {
    if (input.patch.status === 'applied' && failAppliedWrite) { failAppliedWrite = false; throw new Error('proposal persistence unavailable'); }
    return base.updateProposal(input);
  } };
  const service = createChatService({ store, provider: { async *stream() {} }, getWorkspace: async () => ({ project: { id: x.projectId, name: 'Film', brief: '', revision: 1 }, shots: [x.getShot()], assets: [] }), command: async (_actor, command) => {
    commandCalls++; const prior = receipts.get(command.commandId); if (prior) return prior;
    const receipt = { commandId: command.commandId, projectId: x.projectId, resourceId: x.shotId, revision: 4 }; receipts.set(command.commandId, receipt); return receipt;
  } });
  await assert.rejects(service.applyProposal(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, proposalId: proposal.id }), /proposal persistence unavailable/);
  const interrupted = await base.get({ actorId: x.actor.id, projectId: x.projectId, conversationId: x.conversation.id }); assert.equal(interrupted.proposals[0]?.status, 'applying');
  const applied = await service.applyProposal(x.actor, { projectId: x.projectId, conversationId: x.conversation.id, proposalId: proposal.id });
  assert.equal(applied.status, 'applied'); assert.equal(commandCalls, 2); assert.equal(receipts.size, 1);
});
