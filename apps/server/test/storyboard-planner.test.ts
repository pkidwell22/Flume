/**
 * Storyboard planner adapter tests.
 *
 * The transport below is a CONTROLLED FIXTURE: a shaped Ollama NDJSON stream served through the
 * real `createOllamaChatProvider` code path. It is evidence about adapter behaviour, never evidence
 * of a live provider, a paid call or real model quality. No network request is made.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createOllamaChatProvider } from '../src/chat-ollama.ts';
import { createChatStoryboardPlanner, type StoryboardPlannerConfiguration } from '../src/storyboard-planner.ts';
import { createConfiguredStoryboardRuntime, createAuthoringRuntime, BLOCKED_STORYBOARD_MESSAGE } from '../src/authoring-runtime.ts';
import { readStoryboardPlannerConfiguration } from '../src/local-configuration.ts';
import { createChatProviderStack, createContainerChat } from '../src/container-chat.ts';
import { createStoryboardProposalService, InMemoryProposalStore, DEFAULT_BOUNDS } from '../src/storyboard-proposals.ts';

const MODEL = 'ollama/kimi-k3';
const FIXTURE_CREDENTIAL = 'fixture-only-not-a-credential';
const encoder = new TextEncoder();

const shot = {
  title: 'Kitchen reveal', direction: 'Push in slowly from the doorway.',
  startDescription: 'Closed door, warm light underneath.', endDescription: 'Door open, cook framed at the stove.',
  durationSeconds: 4, continuityNotes: 'Same red apron as the previous shot.',
};
const validProposal = JSON.stringify({ shots: [shot] });
const frame = (content: string) => JSON.stringify({ message: { content }, done: false }) + '\n';
const doneFrame = JSON.stringify({ done: true }) + '\n';
/** Split a payload across stream frames, as a real token stream would arrive. */
const chunked = (payload: string, size = 40) => {
  const out: string[] = [];
  for (let index = 0; index < payload.length; index += size) out.push(frame(payload.slice(index, index + size)));
  return out;
};

type Transport = { fetch: typeof globalThis.fetch; calls: Array<{ signal: AbortSignal | null }>; aborted: () => boolean };

/** A shaped, cancellable NDJSON body. `end: 'hang'` never closes, so only an abort can end it. */
function shapedTransport(options: { chunks: string[]; end?: 'close' | 'hang'; status?: number }): Transport {
  const calls: Array<{ signal: AbortSignal | null }> = [];
  let inner: ReadableStreamDefaultController<Uint8Array> | null = null;
  let index = 0;
  let aborted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { inner = controller; },
    pull(controller) {
      if (index < options.chunks.length) { controller.enqueue(encoder.encode(options.chunks[index++])); return; }
      if (options.end !== 'hang') { controller.close(); return; }
      return new Promise<void>(() => {});
    },
    cancel() { aborted = true; },
  });
  const fetchImpl = (async (_input: unknown, init: { signal?: AbortSignal }) => {
    const signal = init?.signal ?? null;
    calls.push({ signal });
    if (options.status !== undefined && options.status !== 200) return { ok: false, status: options.status, body: null };
    signal?.addEventListener('abort', () => {
      aborted = true;
      inner?.error(new DOMException('The operation was aborted.', 'AbortError'));
    });
    return { ok: true, status: 200, body: stream };
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls, aborted: () => aborted };
}

function plannerOver(transport: Transport, overrides: Partial<{ maxTokens: number; timeoutMs: number; maxResponseChars: number }> = {}) {
  const provider = createOllamaChatProvider({ getCredential: async () => FIXTURE_CREDENTIAL, fetch: transport.fetch });
  return createChatStoryboardPlanner({
    provider, modelId: MODEL, getCredential: async () => FIXTURE_CREDENTIAL,
    maxTokens: overrides.maxTokens ?? 800, timeoutMs: overrides.timeoutMs ?? 2_000,
    maxResponseChars: overrides.maxResponseChars ?? 20_000,
  });
}

const proposeInput = () => ({ projectId: randomUUID(), brief: 'A cook opens a closed kitchen door at dawn.', bounds: { ...DEFAULT_BOUNDS } });
const actor = () => ({ id: randomUUID(), kind: 'operator' as const, projectIds: '*' as const });

test('planner refuses unregistered models and unbounded options at construction', async () => {
  const transport = shapedTransport({ chunks: [] });
  const provider = createOllamaChatProvider({ getCredential: async () => FIXTURE_CREDENTIAL, fetch: transport.fetch });
  assert.throws(() => createChatStoryboardPlanner({ provider, modelId: 'video/invented-model' as never, getCredential: async () => FIXTURE_CREDENTIAL }), /registered chat model/i);
  assert.throws(() => createChatStoryboardPlanner({ provider, modelId: MODEL, getCredential: async () => FIXTURE_CREDENTIAL, maxTokens: 0 }), /maxTokens/i);
  assert.throws(() => createChatStoryboardPlanner({ provider, modelId: MODEL, getCredential: async () => FIXTURE_CREDENTIAL, maxTokens: 100_000 }), /maxTokens/i);
  assert.throws(() => createChatStoryboardPlanner({ provider, modelId: MODEL, getCredential: async () => FIXTURE_CREDENTIAL, timeoutMs: 10 * 60_000 }), /timeoutMs/i);
  assert.throws(() => createChatStoryboardPlanner({ provider, modelId: MODEL, getCredential: async () => FIXTURE_CREDENTIAL, maxResponseChars: 10 }), /maxResponseChars/i);
});

test('strict JSON from a shaped stream becomes a reviewed proposal with one request and no shot creation', async () => {
  const transport = shapedTransport({ chunks: [...chunked(validProposal), doneFrame] });
  const planner = plannerOver(transport);
  const store = new InMemoryProposalStore();
  let commands = 0;
  const service = createStoryboardProposalService({
    planner, store,
    command: async () => { commands++; throw new Error('proposal must never create a shot'); },
  });
  const proposal = await service.propose(actor(), { projectId: proposeInput().projectId, brief: 'A cook opens a closed kitchen door at dawn.' });
  assert.equal(proposal.status, 'draft');
  assert.equal(proposal.items.length, 1);
  assert.deepEqual(
    { title: proposal.items[0].title, durationSeconds: proposal.items[0].durationSeconds, start: proposal.items[0].startDescription },
    { title: shot.title, durationSeconds: shot.durationSeconds, start: shot.startDescription },
  );
  assert.equal(proposal.provenance.plannerModelId, MODEL);
  assert.equal(proposal.items[0].commandId, null);
  assert.equal(commands, 0, 'proposing must not issue shot.create');
  assert.equal(transport.calls.length, 1, 'exactly one provider request, no retry');
  const body = JSON.stringify(transport.calls.length);
  assert.ok(body.length > 0);
});

test('the planner sends a bounded, tool-free instruction that carries the brief as data', async () => {
  const bodies: string[] = [];
  const inner = shapedTransport({ chunks: [...chunked(validProposal), doneFrame] });
  const capturing: Transport = {
    calls: inner.calls,
    aborted: inner.aborted,
    fetch: (async (input: unknown, init: { body?: string; signal?: AbortSignal }) => {
      bodies.push(String(init?.body ?? ''));
      return (inner.fetch as unknown as (i: unknown, n: unknown) => Promise<unknown>)(input, init);
    }) as unknown as typeof globalThis.fetch,
  };
  const planner = plannerOver(capturing);
  await planner.propose(proposeInput());
  assert.equal(bodies.length, 1);
  const request = JSON.parse(bodies[0]);
  assert.equal(request.stream, true);
  assert.equal(request.options.num_predict, 800);
  const instruction = String(request.messages.at(-1)?.content ?? '');
  assert.match(instruction, /Return only strict JSON/);
  assert.match(instruction, /Never invent tools, shots, approvals, generations or costs/);
  assert.match(instruction, /\{"projectId":"[0-9a-f-]{36}","brief":"A cook opens a closed kitchen door at dawn\."/);
  assert.equal(bodies[0].includes(FIXTURE_CREDENTIAL), false, 'credentials never enter a prompt');
});

test('malformed, fenced and schema-invalid planner replies fail closed without repair or retry', async () => {
  const cases: Array<{ label: string; payload: string; code: string }> = [
    { label: 'prose', payload: 'Here is a storyboard: open on a door.', code: 'PLANNER_MALFORMED' },
    { label: 'fenced', payload: '```json\n' + validProposal + '\n```', code: 'PLANNER_MALFORMED' },
    { label: 'extra key', payload: JSON.stringify({ shots: [{ ...shot, modelId: 'invented/model' }] }), code: 'PLANNER_INVALID' },
    { label: 'out of bounds', payload: JSON.stringify({ shots: [{ ...shot, durationSeconds: 600 }] }), code: 'PLANNER_INVALID' },
  ];
  for (const entry of cases) {
    const transport = shapedTransport({ chunks: [...chunked(entry.payload), doneFrame] });
    const planner = plannerOver(transport);
    await assert.rejects(planner.propose(proposeInput()), (error: { code?: string }) => {
      assert.equal(error.code, entry.code, entry.label);
      return true;
    }, entry.label);
    assert.equal(transport.calls.length, 1, `${entry.label}: one request only`);
  }
});

test('a truncated stream is reported as truncation and never retried', async () => {
  const transport = shapedTransport({ chunks: chunked(validProposal) });
  const planner = plannerOver(transport);
  await assert.rejects(planner.propose(proposeInput()), { code: 'PLANNER_TRUNCATED' });
  assert.equal(transport.calls.length, 1);
});

test('an oversized reply aborts the stream at the configured bound', async () => {
  const transport = shapedTransport({ chunks: [...chunked(validProposal + ' '.repeat(6000), 200), doneFrame] });
  const planner = plannerOver(transport, { maxResponseChars: 2_000 });
  await assert.rejects(planner.propose(proposeInput()), { code: 'PLANNER_TOO_LARGE' });
  assert.equal(transport.calls.length, 1);
});

test('an explicit cancel ends the in-flight proposal instead of waiting for the model', async () => {
  const transport = shapedTransport({ chunks: [frame('{"shots":[')], end: 'hang' });
  const planner = plannerOver(transport, { timeoutMs: 5_000 });
  const pending = planner.propose(proposeInput());
  await new Promise(resolve => setTimeout(resolve, 20));
  planner.cancel();
  await assert.rejects(pending, { code: 'PLANNER_CANCELLED' });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.aborted(), true);
});

test('a hung provider is cut off by the planner timeout', async () => {
  const transport = shapedTransport({ chunks: [frame('{"shots":[')], end: 'hang' });
  const planner = plannerOver(transport, { timeoutMs: 1_000 });
  await assert.rejects(planner.propose(proposeInput()), { code: 'PLANNER_TIMEOUT' });
  assert.equal(transport.calls.length, 1);
});

test('a missing credential fails closed before any provider request and leaks no key', async () => {
  let calls = 0;
  const provider = { stream() { calls++; throw new Error('must not be called'); } };
  const planner = createChatStoryboardPlanner({ provider: provider as never, modelId: MODEL, getCredential: async () => null });
  await assert.rejects(planner.propose(proposeInput()), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, 'PLANNER_NOT_CONFIGURED');
    assert.equal(String(error.message).includes('fixture-only'), false);
    return true;
  });
  assert.equal(calls, 0);
});

test('provider refusals surface as safe planner errors without the key or provider body', async () => {
  const transport = shapedTransport({ chunks: [], status: 401 });
  const planner = plannerOver(transport);
  await assert.rejects(planner.propose(proposeInput()), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, 'PLANNER_PROVIDER_ERROR');
    assert.equal(String(error.message).includes(FIXTURE_CREDENTIAL), false);
    assert.equal(String(error.message).includes('401'), false);
    return true;
  });
  assert.equal(transport.calls.length, 1);
});

test('planner configuration defaults to blocked and validates explicit values', async () => {
  assert.deepEqual(readStoryboardPlannerConfiguration({}), { mode: 'blocked' });
  assert.deepEqual(
    readStoryboardPlannerConfiguration({ FLUME_STORYBOARD_PLANNER_MODEL: MODEL }),
    { mode: 'chat', modelId: MODEL, maxTokens: 1600, timeoutMs: 30_000, maxResponseChars: 48_000 },
  );
  assert.throws(() => readStoryboardPlannerConfiguration({ FLUME_STORYBOARD_PLANNER_MODEL: 'nope' }), /FLUME_STORYBOARD_PLANNER_MODEL/);
  assert.throws(() => readStoryboardPlannerConfiguration({ FLUME_STORYBOARD_PLANNER_MODEL: MODEL, FLUME_STORYBOARD_PLANNER_TIMEOUT_MS: '5' }), /FLUME_STORYBOARD_PLANNER_TIMEOUT_MS/);
  assert.throws(() => readStoryboardPlannerConfiguration({ FLUME_STORYBOARD_PLANNER_MODEL: MODEL, FLUME_STORYBOARD_PLANNER_MAX_TOKENS: '999999' }), /FLUME_STORYBOARD_PLANNER_MAX_TOKENS/);
});

test('the runtime stays explicitly blocked when no planner model is configured', async () => {
  const slice = await createConfiguredStoryboardRuntime({
    store: new InMemoryProposalStore(),
    chat: { provider: { stream() { throw new Error('unused fixture'); } } as never, getCredential: async () => null },
    configuration: { mode: 'blocked' },
    commands: { command: async () => { throw new Error('unused'); } } as never,
  });
  assert.equal(slice.storyboard, null);
  const runtime = createAuthoringRuntime({ service: { capabilities: async () => [] } as never, ...slice });
  const capabilities = await runtime.capabilities();
  assert.deepEqual(capabilities.storyboard, { available: false, blocker: BLOCKED_STORYBOARD_MESSAGE });
  assert.equal(typeof capabilities.storyboard.blocker, 'string');
  assert.doesNotMatch(String(capabilities.storyboard.blocker), /key|token|credential value/i);
});

test('a configured planner is instantiated and exposed as available', async () => {
  const transport = shapedTransport({ chunks: [...chunked(validProposal), doneFrame] });
  const provider = createOllamaChatProvider({ getCredential: async () => FIXTURE_CREDENTIAL, fetch: transport.fetch });
  const store = new InMemoryProposalStore();
  const commands: unknown[] = [];
  const configuration: StoryboardPlannerConfiguration = { mode: 'chat', modelId: MODEL, maxTokens: 800, timeoutMs: 2_000, maxResponseChars: 20_000 };
  const slice = await createConfiguredStoryboardRuntime({
    store, chat: { provider, getCredential: async () => FIXTURE_CREDENTIAL }, configuration,
    commands: { command: async (_actor: unknown, command: unknown) => { commands.push(command); return { commandId: randomUUID() }; } } as never,
  });
  assert.ok(slice.storyboard, 'a configured runtime must not stay null');
  const runtime = createAuthoringRuntime({ service: { capabilities: async () => [] } as never, ...slice });
  assert.deepEqual((await runtime.capabilities()).storyboard, { available: true, blocker: null });
  const proposal = await slice.storyboard!.propose(actor(), { projectId: randomUUID(), brief: 'A cook opens a closed kitchen door at dawn.' });
  assert.equal(proposal.items.length, 1);
  assert.equal(transport.calls.length, 1);
  assert.equal(commands.length, 0, 'proposing must not create shots or generation work');
});

test('a configured planner without a matching credential stays blocked instead of guessing', async () => {
  const slice = await createConfiguredStoryboardRuntime({
    store: new InMemoryProposalStore(),
    chat: { provider: { stream() { throw new Error('unused fixture'); } } as never, getCredential: async () => null },
    configuration: { mode: 'chat', modelId: MODEL, maxTokens: 800, timeoutMs: 2_000, maxResponseChars: 20_000 },
    commands: { command: async () => { throw new Error('unused'); } } as never,
  });
  assert.equal(slice.storyboard, null);
  assert.match(slice.storyboardBlocker, /ollama\/kimi-k3/);
  assert.doesNotMatch(slice.storyboardBlocker, /secret|file|\/Users\//i);
});

test('an unregistered configured planner model is a startup configuration error', async () => {
  await assert.rejects(createConfiguredStoryboardRuntime({
    store: new InMemoryProposalStore(),
    chat: { provider: { stream() { throw new Error('unused fixture'); } } as never, getCredential: async () => 'fixture' },
    configuration: { mode: 'chat', modelId: 'video/invented-model' as never, maxTokens: 800, timeoutMs: 2_000, maxResponseChars: 20_000 },
    commands: { command: async () => { throw new Error('unused'); } } as never,
  }), /registered chat model/i);
});

test('the chat provider stack exposes a registered provider and credential accessor without a chat store', async () => {
  assert.equal(await createContainerChat({ OPENROUTER_API_KEY: 'inline' }, async () => ({ project: null, shots: [], assets: [] })), undefined);
  const stack = await createChatProviderStack({ OPENROUTER_API_KEY: 'fixture-inline-not-logged' }, env => env.OPENROUTER_API_KEY ?? null);
  assert.deepEqual(stack.configuredModels, ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash', 'openai/gpt-4.1-mini']);
  assert.equal(await stack.getCredential('google/gemini-2.5-flash-lite'), 'fixture-inline-not-logged');
  assert.equal(await stack.getCredential('ollama/kimi-k3'), null);
  assert.equal(typeof stack.provider.stream, 'function');
});
