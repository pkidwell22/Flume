// Cross-boundary regression, not a native UI or live provider-generation test.
import { assertLiteral, capability, compilationPrompt, controls, dom, framePng,
  literalPrompt, prose, reorderedPrompt } from './prompt-review-regression.support.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createBrowserClient } from '@flume/client';
import { migrate } from '@flume/database';
import type { Command, Workspace } from '@flume/domain';
import { compileVideoRequest, ProviderValidationError } from '@flume/providers';
import { isCompiledRequest } from '../../../../packages/providers/src/compile.ts';
import type { ResolvedFrames } from '@flume/providers';
import { buildServer } from '../../../server/src/http.ts';
import { createCommandService } from '../../../server/src/service.ts';
import { hash, sha256 } from '../../../server/src/contracts.ts';
import { verifyReview } from '../../../server/src/generation.ts';
import type { ProviderPort } from '../../../server/src/ports.ts';
import { ownedPostgres } from '../../../../packages/database/test/owned-postgres.ts';
import { FlumeApp } from '../../src/App.tsx';
import { workspaceComponents } from '../../src/composition.ts';
import { WorkspaceController } from '../../src/controller.ts';
import type { FlumePort } from '../../src/types.ts';

const keys = (value: object) => Object.keys(value).sort();
const command = <T extends object>(value: T) => ({ ...value, commandId: randomUUID() });
const revisionError = (error: unknown, code: string) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code;
// Controller predicates, not DOM polling: keep React's act environment active while HTTP completes.
async function waitFor(check: () => void, { timeout }: { timeout: number }) {
  const deadline = Date.now() + timeout;
  while (true) {
    try { check(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

test('literal ordered direction crosses the real editor, client, HTTP, SQL review and compiler', { timeout: 60_000 }, async () => {
  const db = await ownedPostgres();
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let observer: pg.Pool | undefined;
  const nativeFetch = globalThis.fetch;
  let forbiddenFetches = 0;
  // Fail closed for accidental network access. Only the explicit owned-origin transport below uses fetch.
  globalThis.fetch = async () => { forbiddenFetches++; throw new Error('Unexpected network/provider call'); };
  try {
    await migrate(db.pool);
    observer = new pg.Pool(db.config);
    assert.equal((await observer.query('select current_database() as name')).rows[0].name, 'flume_test');
    const firstId = randomUUID(), lastId = randomUUID();
    const bindings = { firstFrameAssetId: firstId, lastFrameAssetId: lastId };
    const frames: ResolvedFrames = {
      firstFrame: { assetId: firstId, url: `data:image/png;base64,${framePng.first}` },
      lastFrame: { assetId: lastId, url: `data:image/png;base64,${framePng.last}` },
    };
    const preparations: Parameters<ProviderPort['prepare']>[0][] = [];
    const provider: ProviderPort = {
      async capabilities() {
        return [{ modelId: capability.modelId, name: capability.name,
          durations: [...capability.durations], resolutions: [...capability.resolutions],
          frameRoles: ['first', 'last'], seedSupported: true, availability: 'unknown', blocker: null }];
      },
      async prepare(input) {
        preparations.push(structuredClone(input));
        // Real compiler, synthetic catalog/resolved media seam. No discovery, credential or upload call.
        const compiled = compileVideoRequest({ ...input.shot, prompt: compilationPrompt(input.shot.prompt) }, capability, frames);
        return { envelope: { provider: compiled.provider, modelId: compiled.modelId,
          body: compiled.bodyJson, bodySha256: compiled.bodySha256 }, estimatedCostUsd: null,
          blockers: [{ code: 'TEST_NO_PROVIDER', message: 'Compile-only regression. No provider or worker is attached.' }] };
      },
    };
    const service = createCommandService({ pool: db.pool, provider, workerAvailable: false,
      queue: { async enqueue() { assert.fail('This regression must never enqueue work'); } } });
    const security = { mode: 'local-operator' as const, allowedHosts: [] as string[], allowedOrigins: [] as string[] };
    app = await buildServer({ service, security });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const address = new URL(origin);
    assert.ok(!['4310', '4311'].includes(address.port), 'Only a newly assigned owned HTTP port may be used');
    security.allowedHosts.push(address.host); security.allowedOrigins.push(origin);
    dom.reconfigure({ url: origin + '/' });
    const writes: Array<{ body: string; value: Record<string, any> }> = [];
    const workspaceReplies: Workspace[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin, 'Never connect to a live API or provider');
      assert.ok(['/api/projects', '/api/workspace', '/api/commands'].includes(url.pathname));
      if (init?.method === 'POST') {
        assert.equal(typeof init.body, 'string');
        writes.push({ body: init.body as string, value: JSON.parse(init.body as string) });
      }
      const response = await nativeFetch(url, { ...init, headers: { ...init?.headers, origin } });
      if (url.pathname === '/api/workspace' && response.ok) workspaceReplies.push(await response.clone().json() as Workspace);
      return response;
    };
    const client = createBrowserClient({ fetch: transport });
    const project = await client.command(command({ type: 'project.create' as const, name: 'Literal direction regression', brief: '' }));
    const projectId = project.projectId;
    const created = await client.command(command({ type: 'shot.create' as const, projectId, title: 'One', prompt: 'Before explicit edit' }));
    const shotId = created.resourceId!;
    // Last inserted first: reading array order cannot accidentally stand in for frame-role identity.
    for (const [id, label, png] of [[lastId, 'last', framePng.last], [firstId, 'first', framePng.first]] as const) {
      const bytes = Buffer.from(png, 'base64');
      await db.pool.query(`INSERT INTO flume.assets
        (id,project_id,filename,kind,origin,sha256,storage_key,mime_type,byte_size,width,height)
        VALUES ($1,$2,$3,'image','sample',$4,$5,'image/png',$6,1,1)`,
      [id, projectId, `${label}-fixture.png`, sha256(bytes), `private-regression-storage/${label}`, bytes.length]);
    }
    const port: FlumePort = { listProjects: () => client.listProjects(), getWorkspace: id => client.getWorkspace(id),
      command: body => client.command(body), uploadAsset: async () => { throw new Error('No upload is exercised'); } };
    let controller = new WorkspaceController(port);
    await controller.start(projectId);
    assert.equal(controller.getSnapshot().phase, 'ready');
    assert.deepEqual(controller.getSnapshot().workspace!.assets.map(asset => asset.id), [lastId, firstId]);
    let view = render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
    const prompt = () => screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });
    // Current ModelPicker is a button/dialog, not the historical native select.
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('option', { name: capability.name }));
    assert.equal((screen.getByRole('button', { name: 'Model' }) as HTMLButtonElement).value, controls.modelId);
    change('Duration (seconds)', '4'); change('Resolution', '720p');
    change('Seed (optional)', '0');
    // Exercise explicit false rather than depending on the initial checkbox default.
    fireEvent.click(screen.getByLabelText('Generate audio')); fireEvent.click(screen.getByLabelText('Generate audio'));
    change('Start frame image', firstId); change('End frame image', lastId);
    change('Prompt', prose);
    // This is a deliberate textarea edit; no claim about a camera-quick-insert widget.
    change('Prompt', literalPrompt);
    assertLiteral(prompt().value, 'editor draft');
    assert.equal((screen.getByLabelText('Generate audio') as HTMLInputElement).checked, false);
    assert.equal((screen.getByLabelText('Seed (optional)') as HTMLInputElement).value, '0');
    assert.ok(document.querySelector('[data-prompt-mark]') === null, 'Prompt markup must not create DOM elements');
    assert.equal(writes.length, 2, 'Editing alone must not write or prepare');
    assert.equal(controller.getSnapshot().dirtyShotIds.has(shotId), true);
    assert.equal((screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled, true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => assert.equal(controller.getSnapshot().workspace!.shots[0]!.revision, 2), { timeout: 10_000 });
    });
    assert.equal(controller.getSnapshot().error, null);
    assertLiteral(prompt().value, 'editor after authoritative save/readback');
    const save = writes.find(item => item.value.type === 'shot.update')!;
    assert.ok(save);
    assertLiteral(save.value.patch.prompt, 'client JSON POST');
    assert.equal(save.body, JSON.stringify(save.value), 'No unobserved alternate serialized command');
    assert.deepEqual(keys(save.value.patch), ['bindings', 'controls', 'prompt', 'title']);
    assert.deepEqual(save.value.patch.controls, controls);
    assert.deepEqual(save.value.patch.bindings, bindings);
    assert.equal(save.value.expectedRevision, 1);
    const persisted = (await observer.query("SELECT *, encode(convert_to(prompt,'UTF8'),'hex') AS prompt_hex FROM flume.shots WHERE id=$1", [shotId])).rows[0];
    assertLiteral(persisted.prompt, 'independent SQL save readback');
    assert.equal(persisted.prompt_hex, Buffer.from(literalPrompt, 'utf8').toString('hex'));
    assert.deepEqual(persisted.controls, controls); assert.deepEqual(persisted.bindings, bindings);
    const saved = (await client.getWorkspace(projectId)).shots[0]!;
    assertLiteral(saved.prompt, 'validated client GET');
    assert.deepEqual(saved.controls, controls); assert.deepEqual(saved.bindings, bindings);
    // A fresh editor/controller must obtain its value from the HTTP/SQL read, not the old draft buffer.
    view.unmount(); controller = new WorkspaceController(port); await controller.start(projectId);
    view = render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
    assertLiteral(prompt().value, 'fresh editor readback');
    assert.equal((screen.getByLabelText('Start frame image') as HTMLSelectElement).value, firstId);
    assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, lastId);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review generation' }));
      await waitFor(() => assert.ok(controller.getSnapshot().reviewId), { timeout: 10_000 });
    });
    assert.equal(controller.getSnapshot().error, null);
    assert.equal(preparations.length, 1);
    assertLiteral(preparations[0]!.shot.prompt, 'command service preparation input');
    assert.deepEqual(preparations[0]!.shot.controls, controls); assert.deepEqual(preparations[0]!.shot.bindings, bindings);
    const prepare = writes.filter(item => item.value.type === 'generation.prepare');
    assert.equal(prepare.length, 1);
    assert.deepEqual(keys(prepare[0]!.value), ['commandId', 'expectedRevision', 'projectId', 'shotId', 'type']);
    assert.equal(prepare[0]!.value.expectedRevision, 2, 'Prepare uses the accepted save revision, not draft text');
    const reviewId = controller.getSnapshot().reviewId!;
    const row = (await observer.query('SELECT * FROM flume.reviews WHERE id=$1', [reviewId])).rows[0];
    assertLiteral(row.snapshot.prompt, 'persisted exact review snapshot');
    assert.deepEqual(row.snapshot.controls, controls); assert.deepEqual(row.snapshot.bindings, bindings);
    assert.deepEqual(row.snapshot.assets.slice().sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)),
      [{ id: firstId, sha256: sha256(Buffer.from(framePng.first, 'base64')) }, { id: lastId, sha256: sha256(Buffer.from(framePng.last, 'base64')) }].sort((a, b) => a.id.localeCompare(b.id)));
    const body = JSON.parse(row.envelope.body);
    // The negative runner must fail HERE for trim/reorder, not merely because setup failed.
    assertLiteral(body.prompt, 'compiled provider envelope');
    const expectedBody = { model: controls.modelId, prompt: literalPrompt, duration: 4, resolution: '720p',
      aspect_ratio: '16:9', generate_audio: false, seed: 0,
      frame_images: [
        { type: 'image_url', image_url: { url: frames.firstFrame!.url }, frame_type: 'first_frame' },
        { type: 'image_url', image_url: { url: frames.lastFrame!.url }, frame_type: 'last_frame' },
      ] };
    assert.deepEqual(body, expectedBody, 'Only implemented provider fields and exact first/end identity may be compiled');
    assert.deepEqual(row.envelope, { provider: 'openrouter', modelId: controls.modelId,
      body: JSON.stringify(expectedBody), bodySha256: sha256(JSON.stringify(expectedBody)) });
    assert.equal(isCompiledRequest({ provider: row.envelope.provider, modelId: row.envelope.modelId,
      body, bodyJson: row.envelope.body, bodySha256: row.envelope.bodySha256 }), true);
    verifyReview(row);
    assert.equal(row.request_hash, hash({ snapshot: row.snapshot, envelope: row.envelope }));
    const projected = workspaceReplies.at(-1)!.reviews.find(review => review.id === reviewId)!;
    assert.ok(projected, 'Observe the real HTTP projection before client parsing');
    assertLiteral(projected.prompt, 'redacted HTTP review projection');
    assert.deepEqual(projected.controls, controls); assert.deepEqual(projected.bindings, bindings);
    assert.deepEqual(keys(projected), ['approved', 'bindings', 'blockers', 'controls', 'estimatedCostUsd', 'id', 'projectId', 'prompt', 'requestHash', 'shotId', 'shotRevision']);
    assert.equal(projected.shotRevision, 2); assert.equal(projected.requestHash, row.request_hash);
    assert.equal(projected.approved, false); assert.equal(projected.estimatedCostUsd, null);
    assert.deepEqual(controller.getSnapshot().workspace!.reviews.find(review => review.id === reviewId), projected);
    assert.doesNotMatch(JSON.stringify(workspaceReplies.at(-1)), /private-regression-storage|data:image|bodySha256|"envelope"|"storageKey"/);
    const reviewPrompt = screen.getByTestId('fl-review-prompt');
    assertLiteral(reviewPrompt.textContent, 'rendered review textContent');
    assert.equal(reviewPrompt.children.length, 0, 'Literal tags and entities must remain a text node');
    assert.ok(document.querySelector('[data-prompt-mark]') === null, 'No prompt HTML interpretation anywhere in the app');
    const dialog = screen.getByRole('dialog', { name: 'Review generation' });
    assert.equal(within(dialog).getByRole('img', { name: 'Start frame: first-fixture.png' }).getAttribute('src'), `/api/media/${firstId}`);
    assert.equal(within(dialog).getByRole('img', { name: 'End frame: last-fixture.png' }).getAttribute('src'), `/api/media/${lastId}`);
    const displayed = (label: string) => [...dialog.querySelectorAll('dt')].find(node => node.textContent === label)!.nextElementSibling!.textContent;
    assert.equal(displayed('Seed'), '0'); assert.equal(displayed('Audio'), 'Off');
    assert.equal((within(dialog).getByRole('button', { name: 'Generate once' }) as HTMLButtonElement).disabled, true);

    // A changed literal command cannot replay the old save receipt under the same command identity.
    const alteredSave = { ...save.value, patch: { ...save.value.patch, prompt: reorderedPrompt } } as Command;
    await assert.rejects(client.command(alteredSave), error => revisionError(error, 'COMMAND_CONFLICT'));
    assertLiteral((await client.getWorkspace(projectId)).shots[0]!.prompt, 'readback after rejected altered replay');
    await assert.rejects(client.command(command({ type: 'generation.prepare' as const, projectId, shotId, expectedRevision: 1 })),
      error => revisionError(error, 'REVISION_CONFLICT'));
    assert.equal(preparations.length, 1, 'Stale preparation must not reach the compiler');

    // Actual review-integrity boundary: neither snapshot nor self-consistently rehashed body may change.
    for (const changed of [literalPrompt.trim(), reorderedPrompt]) {
      const changedBody = JSON.stringify({ ...body, prompt: changed });
      assert.notEqual(sha256(changedBody), row.envelope.bodySha256);
      const changedEnvelope = { ...row.envelope, body: changedBody, bodySha256: sha256(changedBody) };
      for (const tampered of [
        { ...row, snapshot: { ...row.snapshot, prompt: changed } },
        { ...row, envelope: changedEnvelope },
        { ...row, snapshot: { ...row.snapshot, prompt: changed }, envelope: changedEnvelope },
      ]) assert.throws(() => verifyReview(tampered), error => revisionError(error, 'REVIEW_INTEGRITY'));
    }
    // Camera/lens metadata must fail the client AND the actual server contract, never be silently stripped.
    for (const patch of [{ controls: { cameraMovement: ['Dolly in', 'Pan left'] } }, { camera: { lens: '35mm' } }]) {
      const invalid = command({ type: 'shot.update' as const, projectId, shotId, expectedRevision: 2, patch });
      const before: number = writes.length;
      await assert.rejects(client.command(invalid as unknown as Command), error => revisionError(error, 'invalid_command'));
      assert.equal(writes.length, before, 'Invalid client intent must not dispatch');
      const response = await transport(new URL('/api/commands', origin), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalid) });
      assert.equal(response.status, 400); assert.equal((await response.json() as { code: string }).code, 'INVALID_COMMAND');
    }
    const finalShot = (await observer.query('SELECT prompt,controls,bindings,revision FROM flume.shots WHERE id=$1', [shotId])).rows[0];
    assertLiteral(finalShot.prompt, 'final independent readback');
    assert.deepEqual(finalShot.controls, controls); assert.deepEqual(finalShot.bindings, bindings); assert.equal(finalShot.revision, 2);
    assert.deepEqual((await observer.query(`SELECT
      (SELECT count(*)::int FROM flume.reviews) AS reviews,
      (SELECT count(*)::int FROM flume.approvals) AS approvals,
      (SELECT count(*)::int FROM flume.attempts) AS attempts,
      (SELECT count(*)::int FROM flume.reservations) AS reservations,
      (SELECT count(*)::int FROM flume.outbox) AS outbox`)).rows[0],
    { reviews: 1, approvals: 0, attempts: 0, reservations: 0, outbox: 0 });
    assert.equal(forbiddenFetches, 0);
    assert.equal(writes.filter(item => ['generation.approve', 'generation.submit'].includes(item.value.type)).length, 0);
    view.unmount();
  } finally {
    globalThis.fetch = nativeFetch;
    try { cleanup(); }
    finally {
      try { await app?.close(); }
      finally { try { await observer?.end(); } finally { await db.close(); } }
    }
  }
});

test('the actual compiler rejects unsupported camera controls and swapped explicit asset roles', () => {
  const frames: ResolvedFrames = { firstFrame: { assetId: 'first', url: `data:image/png;base64,${framePng.first}` },
    lastFrame: { assetId: 'last', url: `data:image/png;base64,${framePng.last}` } };
  const intent = { prompt: literalPrompt, controls, bindings: { firstFrameAssetId: 'first', lastFrameAssetId: 'last' } };
  const before = structuredClone(intent);
  for (const extra of [{ cameraMovement: ['Dolly in', 'Pan left'] }, { lens: '35mm' }]) {
    assert.throws(() => compileVideoRequest({ ...intent, controls: { ...controls, ...extra } }, capability, frames),
      (error: unknown) => error instanceof ProviderValidationError && error.issues.some(issue => issue.field === `controls.${Object.keys(extra)[0]}`));
  }
  assert.throws(() => compileVideoRequest(intent, capability, { firstFrame: frames.lastFrame, lastFrame: frames.firstFrame }),
    (error: unknown) => error instanceof ProviderValidationError && error.issues.filter(issue => issue.code === 'frame_binding_mismatch').length === 2);
  const compiled = compileVideoRequest(intent, capability, frames);
  const injectedBody = { ...compiled.body, camera: { movement: ['Dolly in', 'Pan left'] } };
  const injectedJson = JSON.stringify(injectedBody);
  assert.equal(isCompiledRequest({ ...compiled, body: injectedBody, bodyJson: injectedJson, bodySha256: sha256(injectedJson) }), false);
  assert.deepEqual(intent, before, 'Rejected input must not mutate the draft');
});
