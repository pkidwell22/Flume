import '../../../packages/shot-editor/test/setup.ts';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FlumeApp } from '../src/App.tsx';
import { WorkspaceController } from '../src/controller.ts';
import { createReferenceProvenanceApi, referenceReadKey } from '../src/reference-provenance.ts';
import { workspaceComponents } from '../src/composition.ts';
import type { Command, Workspace } from '../src/types.ts';
import type { ReferenceProvenancePort, ReferenceReceipt } from '../src/reference-provenance.ts';

// Real controller + real composition + the shipped TakeReview, with fixture HTTP only.
Object.assign(globalThis, { React });
afterEach(cleanup);

const PROJECT = '5a1f5c1e-0000-4000-8000-000000000001';
const PROJECT_B = '5a1f5c1e-0000-4000-8000-000000000011';
const SHOT = '5a1f5c1e-0000-4000-8000-000000000002';
const SHOT_B = '5a1f5c1e-0000-4000-8000-000000000012';
const ATTEMPT_1 = '5a1f5c1e-0000-4000-8000-000000000003';
const ATTEMPT_2 = '5a1f5c1e-0000-4000-8000-000000000004';
const TAKE_1 = '5a1f5c1e-0000-4000-8000-000000000005';
const TAKE_2 = '5a1f5c1e-0000-4000-8000-000000000006';
const ASSET_1 = '5a1f5c1e-0000-4000-8000-000000000007';
const ASSET_2 = '5a1f5c1e-0000-4000-8000-000000000008';
const REF_FIRST = '5a1f5c1e-0000-4000-8000-000000000009';
const REF_LAST = '5a1f5c1e-0000-4000-8000-00000000000a';
const SHA_1 = '1'.repeat(64), SHA_2 = '2'.repeat(64);

const controls = { modelId: 'acme/video-1', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false };
const video = (id: string): Workspace['assets'][number] => ({ id, projectId: PROJECT, filename: `${id}.mp4`, kind: 'video', origin: 'generated', sha256: 'e'.repeat(64), mediaUrl: `/api/media/${id}`, width: 640, height: 360, durationSeconds: 4 });
function workspace(): Workspace {
  return {
    project: { id: PROJECT, name: 'Ridge', brief: '', revision: 1 },
    shots: [{ id: SHOT, projectId: PROJECT, title: 'The opening', prompt: 'A ridge at dawn', revision: 1, selectionRevision: 0, selectedTakeId: null, controls, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } }],
    assets: [video(ASSET_1), video(ASSET_2)],
    takes: [
      { id: TAKE_1, projectId: PROJECT, shotId: SHOT, attemptId: ATTEMPT_1, assetId: ASSET_1, createdAt: '2026-01-01T00:00:00Z' },
      { id: TAKE_2, projectId: PROJECT, shotId: SHOT, attemptId: ATTEMPT_2, assetId: ASSET_2, createdAt: '2026-01-02T00:00:00Z' },
    ],
    attempts: [], reviews: [], exports: [], capabilities: [],
  };
}
function receipt(attemptId: string, references: Array<{ role: 'first_frame' | 'last_frame'; assetId: string | null; sha256: string | null }>, status: 'recorded' | 'partial' | 'unknown' = 'recorded') {
  return { attemptId, reviewId: '5a1f5c1e-0000-4000-8000-000000000020', projectId: PROJECT, shotId: SHOT, shotRevision: 1, requestHash: 'c'.repeat(64), recordedAt: '2026-05-01T10:00:00.000Z', status, references };
}

/** Fixture HTTP: every call is recorded and answered only when the test says so. */
function serve() {
  const calls: Array<{ path: string; method: string; credentials?: string; cache?: string }> = [];
  const pending: Array<{ path: string; respond: (body: unknown, status?: number) => void }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', credentials: init?.credentials, cache: init?.cache });
    return await new Promise<Response>(resolve => {
      pending.push({ path: `${url.pathname}${url.search}`, respond: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) });
    });
  }) as unknown as typeof fetch;
  return { calls, pending, fetcher };
}

async function mount(options: { workspace?: Workspace; other?: Workspace; fetcher: typeof fetch } = { fetcher: serve().fetcher }) {
  const commands: Command[] = [];
  const current = options.workspace ?? workspace();
  const other = options.other;
  const controller = new WorkspaceController({
    listProjects: async () => [current.project!, ...(other?.project ? [other.project] : [])],
    getWorkspace: async (projectId?: string) => structuredClone(other && projectId === other.project?.id ? other : current),
    command: async command => { commands.push(command); throw new Error('Looking must not command'); },
    uploadAsset: async () => { throw new Error('Looking must not upload'); },
  }, null, null, null, createReferenceProvenanceApi(options.fetcher));
  await controller.openProject(PROJECT);
  const view = render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  fireEvent.click(screen.getByRole('button', { name: /^Takes/ }));
  return { controller, commands, view };
}
const flush = async () => { await act(async () => {}); };
const disclosures = () => screen.getAllByRole('button', { name: 'Recorded inputs' });
const regionFor = (index: number) => screen.getAllByRole('region', { name: 'Recorded inputs' })[index]!;

test('the shipped app requests recorded inputs only when a take disclosure is opened', async () => {
  const http = serve();
  const { commands } = await mount({ fetcher: http.fetcher });
  assert.equal(http.calls.length, 0, 'opening the takes view performs no provenance request');
  assert.equal(disclosures().length, 2, 'each take offers the recorded-inputs disclosure');
  fireEvent.click(disclosures()[0]!);
  await flush();
  assert.deepEqual(http.calls, [{ path: `/api/attempts/${ATTEMPT_1}/provenance?projectId=${PROJECT}`, method: 'GET', credentials: 'same-origin', cache: 'no-store' }]);
  assert.equal(commands.length, 0, 'a read is not a command');
  await act(async () => { http.pending[0]!.respond(receipt(ATTEMPT_1, [
    { role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 },
    { role: 'last_frame', assetId: REF_LAST, sha256: SHA_2 },
  ])); });
  await flush();
  const region = regionFor(0);
  assert.match(region.textContent ?? '', /First frame/);
  assert.match(region.textContent ?? '', new RegExp(REF_FIRST));
  assert.match(region.textContent ?? '', new RegExp(SHA_1));
  assert.match(region.textContent ?? '', /not a new verification/);
  assert.equal(commands.length, 0, 'reading history inspects, selects and exports nothing');
});

test('a failed read retries the read only, and an unknown record stays visibly unknown', async () => {
  const http = serve();
  const { commands } = await mount({ fetcher: http.fetcher });
  fireEvent.click(disclosures()[0]!);
  await flush();
  await act(async () => { http.pending[0]!.respond({ code: 'PROVENANCE_NOT_FOUND', message: 'No recorded reference history is available for this attempt.' }, 404); });
  await flush();
  assert.match(regionFor(0).textContent ?? '', /No recorded reference history/);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await flush();
  assert.equal(http.calls.length, 2, 'the retry re-reads the same generation');
  assert.equal(http.calls[1]!.path, http.calls[0]!.path);
  await act(async () => { http.pending[1]!.respond(receipt(ATTEMPT_1, [], 'unknown')); });
  await flush();
  assert.match(regionFor(0).textContent ?? '', /Not recorded/);
  assert.doesNotMatch(regionFor(0).textContent ?? '', /No references were bound/);
  assert.equal(commands.length, 0);
});

test('out-of-order answers stay with their own take', async () => {
  const http = serve();
  await mount({ fetcher: http.fetcher });
  fireEvent.click(disclosures()[0]!);
  await flush();
  fireEvent.click(disclosures()[1]!);
  await flush();
  assert.deepEqual(http.calls.map(call => call.path), [
    `/api/attempts/${ATTEMPT_1}/provenance?projectId=${PROJECT}`,
    `/api/attempts/${ATTEMPT_2}/provenance?projectId=${PROJECT}`,
  ]);
  // The second read answers first, then the first read answers late.
  await act(async () => { http.pending[1]!.respond(receipt(ATTEMPT_2, [{ role: 'last_frame', assetId: REF_LAST, sha256: SHA_2 }])); });
  await flush();
  await act(async () => { http.pending[0]!.respond(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }])); });
  await flush();
  const [first, second] = [regionFor(0).textContent ?? '', regionFor(1).textContent ?? ''];
  assert.match(first, new RegExp(SHA_1), 'take one keeps its own digest');
  assert.doesNotMatch(first, new RegExp(SHA_2), 'take one never shows the other attempt');
  assert.match(second, new RegExp(SHA_2), 'take two keeps its own digest');
  assert.doesNotMatch(second, new RegExp(SHA_1), 'take two never shows the other attempt');
});

test('a project change discards the in-flight read instead of showing another project’s inputs', async () => {
  const http = serve();
  const other: Workspace = { project: { id: PROJECT_B, name: 'Other', brief: '', revision: 1 }, shots: [{ id: SHOT_B, projectId: PROJECT_B, title: 'Elsewhere', prompt: '', revision: 1, selectionRevision: 0, selectedTakeId: null, controls, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } }], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
  const { controller } = await mount({ fetcher: http.fetcher, other });
  fireEvent.click(disclosures()[0]!);
  await flush();
  await act(async () => { await controller.openProject(PROJECT_B); });
  await act(async () => { http.pending[0]!.respond(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }])); });
  await flush();
  assert.doesNotMatch(document.body.textContent ?? '', new RegExp(SHA_1), 'the superseded receipt is never rendered');
  const snapshot = controller.getSnapshot() as unknown as { references?: Record<string, { phase: string }> };
  assert.equal(snapshot.references?.[referenceReadKey(PROJECT, ATTEMPT_1)], undefined, 'nothing is stored for the left project');
});

test('a receipt describing another generation is refused, not displayed', async () => {
  const http = serve();
  const { commands } = await mount({ fetcher: http.fetcher });
  fireEvent.click(disclosures()[0]!);
  await flush();
  await act(async () => { http.pending[0]!.respond(receipt(ATTEMPT_2, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }])); });
  await flush();
  assert.match(regionFor(0).textContent ?? '', /different generation/);
  assert.doesNotMatch(regionFor(0).textContent ?? '', new RegExp(SHA_1));
  assert.equal(commands.length, 0);
});

test('a reload reads the recorded history again from the server', async () => {
  const first = serve();
  const mounted = await mount({ fetcher: first.fetcher });
  fireEvent.click(disclosures()[0]!);
  await flush();
  await act(async () => { first.pending[0]!.respond(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }])); });
  await flush();
  assert.equal(first.calls.length, 1);
  mounted.view.unmount();

  const second = serve();
  await mount({ fetcher: second.fetcher });
  assert.equal(second.calls.length, 0, 'a reload shows nothing until the disclosure is opened');
  fireEvent.click(disclosures()[0]!);
  await flush();
  assert.equal(second.calls.length, 1, 'the read is authorized again, not replayed from a client cache');
  await act(async () => { second.pending[0]!.respond(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }])); });
  await flush();
  assert.match(regionFor(0).textContent ?? '', new RegExp(SHA_1));
});

// ---- Recorded-history request ownership and navigation (03 repair) ----

/** A read port whose answers the test settles explicitly, so reply order is deterministic. */
function deferredReads() {
  const pending: Array<{ resolve: (value: ReferenceReceipt) => void; reject: (error: Error) => void }> = [];
  const port: ReferenceProvenancePort = {
    async read() { return await new Promise<ReferenceReceipt>((resolve, reject) => { pending.push({ resolve, reject }); }); },
  };
  return { pending, port };
}

/** The same fixture API `mount` uses, without a rendered app. */
function bareController(workspaces: Workspace[], provenance: ReferenceProvenancePort | null = null) {
  const commands: Command[] = [];
  const controller = new WorkspaceController({
    listProjects: async () => workspaces.map(item => item.project!),
    getWorkspace: async (projectId?: string) => structuredClone(workspaces.find(item => item.project?.id === projectId) ?? workspaces[0]!),
    command: async command => { commands.push(command); throw new Error('Looking must not command'); },
    uploadAsset: async () => { throw new Error('Looking must not upload'); },
  }, null, null, null, provenance);
  return { controller, commands };
}

function otherWorkspace(): Workspace {
  return {
    project: { id: PROJECT_B, name: 'Other', brief: '', revision: 1 },
    shots: [{ id: SHOT_B, projectId: PROJECT_B, title: 'Elsewhere', prompt: '', revision: 1, selectionRevision: 0, selectedTakeId: null, controls, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } }],
    assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [],
  };
}

const referencePhase = (controller: WorkspaceController, projectId: string, attemptId: string) =>
  controller.getSnapshot().references?.[referenceReadKey(projectId, attemptId)]?.phase ?? null;

test('A to B to A: a late superseded success cannot delete the newer ready receipt', async () => {
  const { pending, port } = deferredReads();
  const { controller, commands } = bareController([workspace(), otherWorkspace()], port);
  await controller.openProject(PROJECT);
  const first = controller.readReferenceReceipt(PROJECT, ATTEMPT_1);
  await controller.openProject(PROJECT_B);
  await controller.openProject(PROJECT);
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), null,
    'returning to a project must not keep a loading label for a read whose answer will be discarded');
  const second = controller.readReferenceReceipt(PROJECT, ATTEMPT_1);
  assert.equal(pending.length, 2, 'the fresh read is its own request');
  pending[1]!.resolve(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }]));
  await second;
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), 'ready');
  pending[0]!.resolve(receipt(ATTEMPT_1, [{ role: 'last_frame', assetId: REF_LAST, sha256: SHA_2 }]));
  await first;
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), 'ready', 'an old navigation epoch has no authority to delete newer state');
  assert.equal(commands.length, 0, 'reading recorded history never commands');
});

test('A to B to A: a late superseded rejection cannot delete the newer ready receipt', async () => {
  const { pending, port } = deferredReads();
  const { controller, commands } = bareController([workspace(), otherWorkspace()], port);
  await controller.openProject(PROJECT);
  const first = controller.readReferenceReceipt(PROJECT, ATTEMPT_1);
  await controller.openProject(PROJECT_B);
  await controller.openProject(PROJECT);
  const second = controller.readReferenceReceipt(PROJECT, ATTEMPT_1);
  pending[1]!.resolve(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }]));
  await second;
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), 'ready');
  pending[0]!.reject(new Error('the superseded read failed late'));
  await first;
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), 'ready', 'a stale failure cannot erase the newer receipt');
  assert.equal(commands.length, 0);
});

test('a superseded navigation does not suppress a fresh read or strand the open disclosure', async () => {
  const http = serve();
  const { controller, commands } = await mount({ fetcher: http.fetcher, other: otherWorkspace() });
  fireEvent.click(disclosures()[0]!);
  await flush();
  assert.equal(http.calls.length, 1);
  await act(async () => { await controller.openProject(PROJECT_B); });
  await act(async () => { await controller.openProject(PROJECT); });
  fireEvent.click(disclosures()[0]!);
  await flush();
  assert.equal(http.calls.length, 2, 'a stale loading state must not suppress the fresh read');
  await act(async () => { http.pending[1]!.respond(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }])); });
  await flush();
  assert.match(regionFor(0).textContent ?? '', new RegExp(SHA_1));
  await act(async () => { http.pending[0]!.respond(receipt(ATTEMPT_1, [{ role: 'last_frame', assetId: REF_LAST, sha256: SHA_2 }])); });
  await flush();
  const body = regionFor(0).textContent ?? '';
  assert.match(body, new RegExp(SHA_1), 'the newest receipt stays authoritative');
  assert.doesNotMatch(body, new RegExp(SHA_2), 'the superseded receipt is never shown');
  assert.doesNotMatch(body, /Reading the recorded review/, 'the disclosure cannot end up claiming a read that will never finish');
  assert.equal(commands.length, 0);
});

test('two takes that share one attempt read it once and share one authoritative receipt', async () => {
  const shared: Workspace = workspace();
  shared.takes = shared.takes.map(take => ({ ...take, attemptId: ATTEMPT_1 }));
  const http = serve();
  const { commands } = await mount({ workspace: shared, fetcher: http.fetcher });
  fireEvent.click(disclosures()[0]!);
  await flush();
  fireEvent.click(disclosures()[1]!);
  await flush();
  assert.equal(http.calls.length, 1, 'the second disclosure reuses the read already in flight for that generation');
  await act(async () => { http.pending[0]!.respond(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }])); });
  await flush();
  assert.match(regionFor(0).textContent ?? '', new RegExp(SHA_1));
  assert.match(regionFor(1).textContent ?? '', new RegExp(SHA_1));
  assert.equal(commands.length, 0);
});

test('cancelled navigation drops the stranded loading state without touching draft protection', async () => {
  const { pending, port } = deferredReads();
  const { controller, commands } = bareController([workspace(), otherWorkspace()], port);
  await controller.openProject(PROJECT);
  controller.markDirty(SHOT);
  const first = controller.readReferenceReceipt(PROJECT, ATTEMPT_1);
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), 'loading');
  controller.cancelPendingNavigation();
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), null, 'a cancelled navigation cannot leave a stranded loading claim');
  assert.equal(controller.getSnapshot().dirtyShotIds.has(SHOT), true, 'draft protection is untouched');
  assert.equal(controller.selectShot(SHOT), false, 'a dirty draft still blocks a shot change');
  const second = controller.readReferenceReceipt(PROJECT, ATTEMPT_1);
  pending[1]!.resolve(receipt(ATTEMPT_1, [{ role: 'first_frame', assetId: REF_FIRST, sha256: SHA_1 }]));
  await second;
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), 'ready', 'a superseded read does not poison the next one');
  pending[0]!.resolve(receipt(ATTEMPT_1, []));
  await first;
  assert.equal(referencePhase(controller, PROJECT, ATTEMPT_1), 'ready');
  assert.equal(commands.length, 0);
});
