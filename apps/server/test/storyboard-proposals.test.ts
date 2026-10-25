/**
 * Storyboard-to-shot proposal service tests.
 *
 * CONTROLLED FIXTURES: the planner and the command port below are deterministic stand-ins.
 * They are NOT live-provider or live-database evidence. The command port reproduces the real
 * `flume.command_receipts` contract (same commandId + same fingerprint replays the same receipt),
 * which is what makes resume-without-duplicates observable here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  InMemoryProposalStore,
  StoryboardProposalError,
  createStoryboardProposalService,
  stableCommandId,
  toPlanCuts,
} from '../src/storyboard-proposals.ts';

const projectId = randomUUID();
const operator = { id: randomUUID(), kind: 'operator' as const, projectIds: '*' as const };
const agent = { id: randomUUID(), kind: 'agent' as const, projectIds: [projectId] as string[] };

const shotList = () => ({
  shots: [
    { title: 'Threshold', direction: 'Slow push through the doorway.', startDescription: 'Empty hallway at dusk.', endDescription: 'A silhouette fills the frame.', durationSeconds: 4, continuityNotes: 'Warm practical light from the left.' },
    { title: 'Kitchen', direction: 'Handheld follow.', startDescription: 'Kettle steam curls.', endDescription: 'A hand reaches the mug.', durationSeconds: 3, continuityNotes: '' },
    { title: 'Window', direction: 'Static wide.', startDescription: 'Rain on glass.', endDescription: 'Streetlight blooms.', durationSeconds: 5, continuityNotes: 'Same rain as the previous cut.' },
  ],
});

type Any = any;

/** Deterministic command port standing in for service.command + the receipts table. */
function receiptPort(options: { failAt?: number; mode?: 'definite' | 'unknown'; onCall?: (n: number) => Promise<void> | void } = {}) {
  const commands: Any[] = [];
  const receipts = new Map<string, Any>();
  const shots: string[] = [];
  const port = async (_actor: Any, command: Any) => {
    commands.push(command);
    const call = commands.length;
    await options.onCall?.(call);
    const replayed = receipts.get(command.commandId);
    if (replayed) return replayed;
    if (options.failAt === call && options.mode === 'definite') {
      // A definite refusal leaves no shot and no receipt behind.
      const error: Any = new Error('The shot was refused by the project scope guard.');
      error.code = 'SHOT_SCOPE';
      error.status = 422;
      throw error;
    }
    const shotId = randomUUID();
    const receipt = { commandId: command.commandId, projectId: command.projectId, resourceId: shotId, revision: 1 };
    shots.push(shotId);
    receipts.set(command.commandId, receipt);
    if (options.failAt === call && options.mode === 'unknown') {
      // The real write succeeded; the response was lost. Only the receipts table knows.
      throw new Error('socket hang up');
    }
    return receipt;
  };
  return { port, commands, shots, receipts };
}

const service = (plannerRaw: unknown, port: Any, store = new InMemoryProposalStore()) => createStoryboardProposalService({
  planner: { modelId: 'fixture/planner-1', propose: async () => plannerRaw },
  command: port,
  store,
});

test('malformed planner JSON is rejected without creating a proposal or shots', async () => {
  const { port, commands, shots } = receiptPort();
  const store = new InMemoryProposalStore();
  const svc = service('{"shots": [{"title": "Doorway", "direction": ', port, store);

  await assert.rejects(svc.propose(operator, { projectId, brief: 'A door opens.' }), (error: Any) => {
    assert.ok(error instanceof StoryboardProposalError);
    assert.equal(error.code, 'PLANNER_MALFORMED');
    assert.equal(error.status, 422);
    return true;
  });
  assert.equal(commands.length, 0);
  assert.equal(shots.length, 0);
  assert.deepEqual(await store.list(projectId), []);
});

test('planner output outside the shot contract is rejected with field issues and creates nothing', async () => {
  const overCount = { shots: Array.from({ length: 13 }, (_, i) => ({ ...shotList().shots[0], title: `Cut ${i}` })) };
  const tooLong = { shots: [{ ...shotList().shots[0], durationSeconds: 61 }] };
  const spendy = { shots: [{ ...shotList().shots[0], generate: true, maxCostUsd: '5.00' }] };

  for (const [raw, path] of [[overCount, 'shots'], [tooLong, 'shots.0.durationSeconds'], [spendy, 'shots.0']] as const) {
    const { port } = receiptPort();
    const svc = service(raw, port);
    await assert.rejects(svc.propose(operator, { projectId, brief: 'A door opens.' }), (error: Any) => {
      assert.equal(error.code, 'PLANNER_INVALID');
      assert.equal(error.status, 422);
      assert.ok(error.details.issues.some((issue: Any) => issue.path === path || issue.path.startsWith(`${path}.`)), `expected an issue on ${path}`);
      return true;
    });
  }
});

test('a proposal is an editable draft: no command is issued and provenance is recorded', async () => {
  const { port, commands } = receiptPort();
  const svc = service(shotList(), port);

  const draft = await svc.propose(agent, { projectId, brief: 'Three cuts of a house at dusk.' });

  assert.equal(draft.status, 'draft');
  assert.equal(draft.revision, 0);
  assert.equal(draft.items.length, 3);
  assert.deepEqual(draft.items.map(item => item.title), ['Threshold', 'Kitchen', 'Window']);
  assert.deepEqual(draft.items.map(item => item.state), ['pending', 'pending', 'pending']);
  assert.equal(draft.items[0].continuityNotes, 'Warm practical light from the left.');
  assert.equal(draft.provenance.plannerModelId, 'fixture/planner-1');
  assert.match(draft.provenance.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(commands.length, 0, 'proposing must never create shots');
  assert.deepEqual(draft.items.map(item => item.shotId), [null, null, null]);
});

test('operator edits are bounded, revision-checked and leave the stored draft intact when refused', async () => {
  const { port, commands } = receiptPort();
  const store = new InMemoryProposalStore();
  const svc = service(shotList(), port, store);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });
  const edited = draft.items.map((item, index) => ({ itemId: item.itemId, title: index === 0 ? 'The Threshold' : item.title, direction: item.direction, startDescription: item.startDescription, endDescription: item.endDescription, durationSeconds: item.durationSeconds, continuityNotes: item.continuityNotes }));

  const revised = await svc.revise(operator, { projectId, proposalId: draft.id, expectedRevision: 0, items: edited });
  assert.equal(revised.revision, 1);
  assert.equal(revised.items[0].title, 'The Threshold');

  const tooLong = edited.map((item, index) => index === 1 ? { ...item, durationSeconds: 90 } : item);
  await assert.rejects(svc.revise(operator, { projectId, proposalId: draft.id, expectedRevision: 1, items: tooLong }), (error: Any) => {
    assert.equal(error.code, 'PROPOSAL_INVALID_EDIT');
    assert.ok(error.details.issues.some((issue: Any) => issue.path === 'items.1.durationSeconds'));
    return true;
  });
  // adding or removing cuts through an edit is refused, so application can never diverge from review
  await assert.rejects(svc.revise(operator, { projectId, proposalId: draft.id, expectedRevision: 1, items: edited.slice(0, 2) }), (error: Any) => {
    assert.equal(error.code, 'PROPOSAL_INVALID_EDIT');
    return true;
  });
  await assert.rejects(svc.revise(operator, { projectId, proposalId: draft.id, expectedRevision: 0, items: edited }), (error: Any) => {
    assert.equal(error.code, 'REVISION_CONFLICT');
    assert.equal(error.currentRevision, 1);
    return true;
  });

  const stored = await store.load(projectId, draft.id);
  assert.equal(stored?.revision, 1);
  assert.equal(stored?.items[0].title, 'The Threshold');
  assert.equal(commands.length, 0);
});

test('an agent actor cannot accept its own proposal and nothing is created', async () => {
  const { port, commands, shots } = receiptPort();
  const svc = service(shotList(), port);
  const draft = await svc.propose(agent, { projectId, brief: 'House at dusk.' });

  await assert.rejects(svc.accept(agent, { projectId, proposalId: draft.id, expectedRevision: 0 }), (error: Any) => {
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(commands.length, 0);
  assert.equal(shots.length, 0);
  assert.equal((await svc.read(operator, { projectId, proposalId: draft.id })).status, 'draft');
});

test('acceptance requires the reviewed revision and an explicit operator', async () => {
  const { port, commands } = receiptPort();
  const svc = service(shotList(), port);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });

  await assert.rejects(svc.accept(operator, { projectId, proposalId: draft.id, expectedRevision: 4 }), (error: Any) => {
    assert.equal(error.code, 'REVISION_CONFLICT');
    assert.equal(error.currentRevision, 0);
    return true;
  });
  assert.equal(commands.length, 0);
  await assert.rejects(svc.resume(operator, { projectId, proposalId: draft.id }), (error: Any) => {
    assert.equal(error.code, 'PROPOSAL_STATE');
    return true;
  });
});

test('acceptance creates shots through shot.create only, with deterministic command ids', async () => {
  const { port, commands, shots } = receiptPort();
  const svc = service(shotList(), port);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });
  const accepted = await svc.accept(operator, { projectId, proposalId: draft.id, expectedRevision: 0 });

  assert.equal(accepted.status, 'applied');
  assert.equal(accepted.items.filter(item => item.state === 'created').length, 3);
  assert.equal(new Set(accepted.items.map(item => item.shotId)).size, 3);
  assert.equal(shots.length, 3);
  assert.deepEqual(commands.map(command => command.type), ['shot.create', 'shot.create', 'shot.create']);
  for (const [index, command] of commands.entries()) {
    assert.equal(command.projectId, projectId);
    assert.equal(command.commandId, stableCommandId(draft.id, accepted.items[index].itemId));
    // the shot prompt is authored prose, never a provider request
    assert.ok(command.prompt.includes(accepted.items[index].direction));
    assert.ok(command.prompt.includes(`Start: ${accepted.items[index].startDescription}`));
    assert.ok(command.prompt.includes(`End: ${accepted.items[index].endDescription}`));
  }
  assert.equal(accepted.failure, null);

  // reviewed content is frozen: no silent divergence between what was accepted and what exists
  await assert.rejects(svc.revise(operator, { projectId, proposalId: draft.id, expectedRevision: accepted.revision, items: accepted.items.map(item => ({ itemId: item.itemId, title: item.title, direction: item.direction, startDescription: item.startDescription, endDescription: item.endDescription, durationSeconds: item.durationSeconds, continuityNotes: item.continuityNotes })) }), (error: Any) => {
    assert.equal(error.code, 'PROPOSAL_STATE');
    return true;
  });
});

test('accepted shots map to plan cuts for the existing cut engine without writing them here', async () => {
  const { port, commands } = receiptPort();
  const svc = service(shotList(), port);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });
  const accepted = await svc.accept(operator, { projectId, proposalId: draft.id, expectedRevision: 0 });

  const cuts = toPlanCuts(accepted);
  assert.deepEqual(cuts, accepted.items.map(item => ({ shotId: item.shotId, durationMs: item.durationSeconds * 1000 })));
  assert.deepEqual(cuts.map(cut => cut.durationMs), [4000, 3000, 5000]);
  assert.equal(commands.every(command => command.type === 'shot.create'), true, 'no cut, pin or approval command may be issued by this service');
  // nothing in the proposal record pretends to be an applied cut
  assert.equal('planRevision' in accepted, false);
});

test('a definite rejection mid-application reports real partial progress and resume creates no duplicates', async () => {
  const { port, commands, shots } = receiptPort({ failAt: 2, mode: 'definite' });
  const store = new InMemoryProposalStore();
  const svc = service(shotList(), port, store);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });

  const first = await svc.accept(operator, { projectId, proposalId: draft.id, expectedRevision: 0 });
  assert.equal(first.status, 'partial');
  assert.deepEqual(first.items.map(item => item.state), ['created', 'failed', 'pending']);
  assert.equal(first.failure?.itemId, first.items[1].itemId);
  assert.equal(first.failure?.code, 'SHOT_SCOPE');
  assert.equal(shots.length, 1);
  assert.equal(commands.length, 2);

  // A fresh service instance over the same durable store models a restart between attempts.
  const resumed = createStoryboardProposalService({
    planner: { modelId: 'fixture/planner-1', propose: async () => shotList() },
    command: port,
    store,
  });
  const second = await resumed.resume(operator, { projectId, proposalId: draft.id });
  assert.deepEqual(second.items.map(item => item.state), ['created', 'failed', 'created']);
  assert.equal(second.status, 'partial', 'the refused cut is left visible instead of being silently retried');
  assert.equal(second.provenance.plannerModelId, 'fixture/planner-1');
  assert.equal(shots.length, 2, 'resume must not re-create a shot that already exists');
  assert.equal(new Set(second.items.filter(item => item.shotId).map(item => item.shotId)).size, 2);

  // An explicit retry is available, and an already-created cut is never issued twice.
  const retried = await resumed.resume(operator, { projectId, proposalId: draft.id, retryFailed: true });
  assert.equal(retried.status, 'applied');
  assert.equal(shots.length, 3);
  assert.equal(commands.filter(command => command.commandId === second.items[0].commandId).length, 1);
});

test('an unknown command outcome is reported without auto-retry and resume replays the same command id', async () => {
  const { port, commands, shots, receipts } = receiptPort({ failAt: 1, mode: 'unknown' });
  const svc = service(shotList(), port);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });

  const accepted = await svc.accept(operator, { projectId, proposalId: draft.id, expectedRevision: 0 });
  assert.equal(accepted.status, 'unknown');
  assert.equal(accepted.failure?.code, 'COMMAND_OUTCOME_UNKNOWN');
  assert.equal(accepted.items[0].state, 'unknown');
  assert.equal(commands.length, 1, 'an unknown outcome must not be retried automatically');
  assert.equal(accepted.items[0].shotId, null, 'the service must not invent an unconfirmed shot id');

  const resumed = await svc.resume(operator, { projectId, proposalId: draft.id });
  assert.equal(commands.length, 4, 'resume re-issues only the unresolved cut and continues');
  assert.equal(commands[1].commandId, commands[0].commandId);
  assert.equal(receipts.size, 3);
  assert.equal(shots.length, 3, 'the replayed command returns the original receipt instead of a new shot');
  assert.equal(resumed.status, 'applied');
  assert.equal(new Set(resumed.items.map(item => item.shotId)).size, 3);
});

test('cancellation before acceptance creates nothing and refuses later acceptance', async () => {
  const { port, commands } = receiptPort();
  const svc = service(shotList(), port);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });

  const cancelled = await svc.cancel(operator, { projectId, proposalId: draft.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(commands.length, 0);
  await assert.rejects(svc.accept(operator, { projectId, proposalId: draft.id, expectedRevision: 0 }), (error: Any) => {
    assert.equal(error.code, 'PROPOSAL_STATE');
    return true;
  });
  assert.equal(commands.length, 0);
});

test('cancellation during application stops after the in-flight shot and reports what exists', async () => {
  let target = '';
  const { port, commands, shots } = receiptPort({ onCall: async call => { if (call === 1) await svc.cancel(operator, { projectId, proposalId: target }); } });
  const svc = service(shotList(), port);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });
  target = draft.id;

  const accepted = await svc.accept(operator, { projectId, proposalId: draft.id, expectedRevision: 0 });
  assert.equal(accepted.status, 'cancelled');
  assert.deepEqual(accepted.items.map(item => item.state), ['created', 'pending', 'pending']);
  assert.equal(commands.length, 1, 'no shot may be created after cancellation was observed');
  assert.equal(shots.length, 1);
  await assert.rejects(svc.resume(operator, { projectId, proposalId: draft.id }), (error: Any) => {
    assert.equal(error.code, 'PROPOSAL_STATE');
    return true;
  });
});

test('the service refuses a proposal from another project and an unowned actor', async () => {
  const { port } = receiptPort();
  const svc = service(shotList(), port);
  const draft = await svc.propose(operator, { projectId, brief: 'House at dusk.' });

  await assert.rejects(svc.read(operator, { projectId: randomUUID(), proposalId: draft.id }), (error: Any) => {
    assert.equal(error.code, 'PROPOSAL_NOT_FOUND');
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(svc.read({ id: randomUUID(), kind: 'agent', projectIds: [randomUUID()] }, { projectId, proposalId: draft.id }), (error: Any) => {
    assert.equal(error.code, 'FORBIDDEN');
    return true;
  });
});
