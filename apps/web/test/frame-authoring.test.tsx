import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FrameAuthoring, safeFrameMediaUrl } from '../src/FrameAuthoring.tsx';
import type {
  FrameAuthoringDraft,
  FrameAuthoringProps,
  FrameInspection,
  FrameModel,
  FrameReview,
  FrameSubmission,
  FrameSourceAsset,
} from '../src/frame-authoring-types.ts';

afterEach(cleanup);

const model: FrameModel = {
  modelId: 'frame-model',
  name: 'Frame Model 2',
  aspectRatios: ['16:9', '9:16'],
  frameRoles: ['first_frame', 'last_frame'],
  availability: 'available',
  blocker: null,
};

const reference: FrameSourceAsset = {
  assetId: 'ref-a',
  filename: 'studio-plate.png',
  width: 1280,
  height: 720,
  mediaUrl: '/api/media/ref-a',
  sha256: 'ref-sha',
};

const inspection: FrameInspection = {
  inspectionId: 'insp-1',
  assetId: 'gen-1',
  mimeType: 'image/png',
  width: 1280,
  height: 720,
  sha256: 'gen-sha',
  mediaUrl: '/api/media/gen-1',
};

function review(overrides: Partial<FrameReview> = {}): FrameReview {
  return {
    reviewId: 'rev-1',
    projectId: 'p',
    shotId: 's',
    expectedRevision: 3,
    role: 'first_frame',
    prompt: 'Cold dawn over the ridge',
    modelId: 'frame-model',
    aspectRatio: '16:9',
    sourceAssetId: null,
    requestHash: 'hash-1',
    status: 'ready',
    blockers: [],
    estimateUsd: 0.42,
    ...overrides,
  };
}

function submission(overrides: Partial<FrameSubmission> = {}): FrameSubmission {
  return {
    attemptId: 'att-1',
    reviewId: 'rev-1',
    shotId: 's',
    status: 'running',
    assetId: null,
    stage: 'rendering',
    progress: 10,
    errorCode: null,
    message: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Calls {
  prepare: FrameAuthoringDraft[];
  generate: Array<{ reviewId: string; limits: { maxAttempts: number; maxCostUsd: string } }>;
  check: string[];
  cancel: string[];
  inspect: string[];
  bind: Array<Record<string, unknown>>;
}

function makeProps(overrides: Partial<FrameAuthoringProps> = {}) {
  const calls: Calls = { prepare: [], generate: [], check: [], cancel: [], inspect: [], bind: [] };
  const props: FrameAuthoringProps = {
    projectId: 'p',
    shotId: 's',
    expectedRevision: 3,
    bindings: { firstFrameAssetId: null, lastFrameAssetId: 'asset-end' },
    models: [model],
    sourceAssets: [reference],
    onPrepareReview: async draft => {
      calls.prepare.push(draft);
      return review({ prompt: draft.prompt, sourceAssetId: draft.sourceAssetId, role: draft.role, expectedRevision: draft.expectedRevision });
    },
    onApproveAndGenerate: async (prepared, limits) => {
      calls.generate.push({ reviewId: prepared.reviewId, limits });
      return submission({ status: 'succeeded', assetId: 'gen-1', progress: 100, stage: 'stored' });
    },
    onCheckSubmission: async attemptId => {
      calls.check.push(attemptId);
      return submission();
    },
    onCancelSubmission: async attemptId => {
      calls.cancel.push(attemptId);
      return submission({ status: 'cancelled', assetId: null });
    },
    onInspectResult: async assetId => {
      calls.inspect.push(assetId);
      return inspection;
    },
    onBindFrame: async input => {
      calls.bind.push(input as unknown as Record<string, unknown>);
      return { assetId: input.assetId, shotId: input.shotId, role: input.role, revision: 4 };
    },
    ...overrides,
  };
  return { calls, props };
}

function draw(calls: Calls) {
  return calls.prepare.length + calls.generate.length + calls.check.length + calls.cancel.length + calls.inspect.length + calls.bind.length;
}

async function settle() {
  await act(async () => {});
}

async function reachReview(overrides: Partial<FrameAuthoringProps> = {}) {
  const harness = makeProps(overrides);
  const view = render(<FrameAuthoring {...harness.props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn over the ridge' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });
  assert.ok(screen.getByRole('heading', { name: 'Review request' }), 'fixture reaches a review');
  return { ...harness, view };
}

async function reachSubmitted(overrides: Partial<FrameAuthoringProps> = {}, result: Partial<FrameSubmission> = {}) {
  const harness = makeProps(overrides);
  const view = render(<FrameAuthoring {...harness.props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn over the ridge' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Approve and generate once' }));
  });
  return { ...harness, view, result };
}

test('rendering, choosing a target, and editing every field dispatch nothing', async () => {
  const { calls, props } = makeProps();
  render(<FrameAuthoring {...props} />);

  assert.ok(screen.getByRole('heading', { name: 'Author a frame' }));
  assert.equal((screen.getByRole('button', { name: 'Prepare review' }) as HTMLButtonElement).disabled, true);

  fireEvent.click(screen.getByRole('radio', { name: 'End frame' }));
  assert.equal((screen.getByRole('radio', { name: 'End frame' }) as HTMLInputElement).checked, true);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn over the ridge' } });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'frame-model' } });
  fireEvent.change(screen.getByLabelText('Aspect ratio'), { target: { value: '9:16' } });
  fireEvent.change(screen.getByLabelText(/Reference image/), { target: { value: 'ref-a' } });

  // Selecting a reference is a reference choice, not a spend and not a binding.
  assert.equal(draw(calls), 0);
  assert.equal(screen.queryByRole('img'), null);
  assert.equal((screen.getByRole('button', { name: 'Prepare review' }) as HTMLButtonElement).disabled, false);
});

test('prepare review sends the frozen draft exactly once and never spends', async () => {
  const { calls, props } = makeProps();
  render(<FrameAuthoring {...props} />);
  fireEvent.click(screen.getByRole('radio', { name: 'End frame' }));
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn over the ridge' } });
  fireEvent.change(screen.getByLabelText('Aspect ratio'), { target: { value: '9:16' } });
  fireEvent.change(screen.getByLabelText(/Reference image/), { target: { value: 'ref-a' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });

  assert.deepEqual(calls.prepare, [{
    projectId: 'p',
    shotId: 's',
    expectedRevision: 3,
    role: 'last_frame',
    prompt: 'Cold dawn over the ridge',
    modelId: 'frame-model',
    aspectRatio: '9:16',
    sourceAssetId: 'ref-a',
  }]);
  assert.equal(calls.generate.length, 0, 'preparing a review is not an approval or a submit');
  assert.match(screen.getByRole('heading', { name: 'Review request' }).closest('section')!.textContent!, /End frame/);
  assert.match(screen.getByRole('heading', { name: 'Review request' }).closest('section')!.textContent!, /studio-plate\.png/);
  assert.equal(screen.queryByRole('button', { name: 'Prepare review' }), null, 'the composed draft is frozen in review');
});

test('an unavailable route is disabled with its reason, and unknown availability is not treated as available', async () => {
  const blocked: FrameModel = { ...model, availability: 'blocked', blocker: 'This account cannot use the frame route.' };
  const { calls, props } = makeProps({ models: [blocked] });
  const view = render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });

  const prepare = screen.getByRole('button', { name: 'Prepare review' }) as HTMLButtonElement;
  const reason = screen.getByText('This account cannot use the frame route.');
  assert.equal(prepare.disabled, true);
  assert.ok(prepare.getAttribute('aria-describedby')?.includes(reason.id), 'the disabled reason is programmatically associated');
  fireEvent.click(prepare);
  await settle();
  assert.equal(calls.prepare.length, 0);

  view.rerender(<FrameAuthoring {...props} models={[{ ...model, availability: 'unknown' }]} />);
  assert.equal((screen.getByRole('button', { name: 'Prepare review' }) as HTMLButtonElement).disabled, true);
  assert.match(screen.getByText(/availability has not been reported/i).textContent!, /not been reported/);

  view.rerender(<FrameAuthoring {...props} models={[{ ...model, frameRoles: ['first_frame'] }]} />);
  fireEvent.click(screen.getByRole('radio', { name: 'End frame' }));
  assert.equal((screen.getByRole('button', { name: 'Prepare review' }) as HTMLButtonElement).disabled, true);
  assert.match(screen.getByText(/cannot generate the end frame/i).textContent!, /cannot generate the end frame/);
});

test('an unquoted price keeps generation disabled instead of counting as zero', async () => {
  const { calls, props } = makeProps({ onPrepareReview: async draft => review({ prompt: draft.prompt, estimateUsd: null }) });
  render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });

  assert.ok(screen.getAllByText(/not quoted/i).length >= 1);
  assert.ok(screen.getAllByText(/Unknown is not free/i).length >= 1);
  assert.equal((screen.getByLabelText('Spending limit (USD)') as HTMLInputElement).disabled, true);
  const generate = screen.getByRole('button', { name: 'Approve and generate once' }) as HTMLButtonElement;
  assert.equal(generate.disabled, true);
  fireEvent.click(generate);
  await settle();
  assert.equal(calls.generate.length, 0);
});

test('approval and generation need the explicit button, happen once, and report real progress', async () => {
  const pending = deferred<FrameSubmission>();
  const { calls, props } = makeProps({ onApproveAndGenerate: async (prepared, limits) => { calls.generate.push({ reviewId: prepared.reviewId, limits }); return pending.promise; } });
  render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });

  const generate = screen.getByRole('button', { name: 'Approve and generate once' }) as HTMLButtonElement;
  assert.equal(generate.disabled, false);
  await act(async () => {
    fireEvent.click(generate);
    fireEvent.click(generate);
  });
  assert.deepEqual(calls.generate, [{ reviewId: 'rev-1', limits: { maxAttempts: 1, maxCostUsd: '0.42' } }]);
  assert.equal(screen.queryByRole('button', { name: 'Inspect returned image' }), null, 'no result before the provider answers');

  await act(async () => {
    pending.resolve(submission({ status: 'running', progress: 40, stage: 'rendering frames' }));
  });
  assert.match(screen.getByRole('heading', { name: 'Generating' }).textContent!, /Generating/);
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '40');
  assert.match(screen.getByText(/rendering frames/).textContent!, /rendering frames/);
  assert.equal(calls.check.length, 0, 'status is checked only when asked');
  assert.equal(calls.inspect.length, 0);
  assert.equal(calls.bind.length, 0);
});

test('the returned image is inspected and bound only through explicit actions, and only the target frame changes', async () => {
  const { calls, props } = makeProps();
  render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Approve and generate once' }));
  });

  assert.match(screen.getByRole('heading', { name: 'Generation finished' }).textContent!, /Generation finished/);
  assert.equal(document.querySelector('[data-frame-result] img'), null, 'an attempt result is not a displayable image');
  assert.equal(calls.bind.length, 0);
  assert.equal(calls.inspect.length, 0, 'inspection is explicit');

  const inspect = screen.getByRole('button', { name: 'Inspect returned image' });
  await act(async () => {
    fireEvent.click(inspect);
  });
  assert.deepEqual(calls.inspect, ['gen-1']);
  const image = document.querySelector('[data-frame-result] img')!;
  assert.equal(image.getAttribute('src'), '/api/media/gen-1');
  assert.match(screen.getByText(/gen-sha/).textContent!, /gen-sha/);
  assert.equal(calls.bind.length, 0, 'inspecting is not binding');

  const bind = screen.getByRole('button', { name: 'Bind to start frame' }) as HTMLButtonElement;
  assert.equal(bind.disabled, false);
  assert.match(screen.getByText(/end frame will not change/i).textContent!, /will not change/i);
  await act(async () => {
    fireEvent.click(bind);
  });
  assert.equal(calls.bind.length, 1);
  assert.deepEqual(calls.bind[0], { projectId: 'p', shotId: 's', role: 'first_frame', assetId: 'gen-1', inspectionId: 'insp-1', expectedRevision: 3 });
  assert.equal('firstFrameAssetId' in calls.bind[0] || 'lastFrameAssetId' in calls.bind[0], false);
  assert.match(screen.getByText(/Bound to start frame at shot revision 4/).textContent!, /Bound to start frame/);
});

test('unknown acceptance is reported without an automatic retry or automatic status check', async () => {
  let checks = 0;
  let generations = 0;
  const { calls, props } = makeProps({
    onApproveAndGenerate: async () => {
      generations += 1;
      return submission({ status: 'acceptance_unknown', assetId: null, progress: null, stage: null });
    },
    onCheckSubmission: async attemptId => {
      checks += 1;
      calls.check.push(attemptId);
      return submission({ status: 'acceptance_unknown', assetId: null, progress: null, stage: null });
    },
  });
  render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Approve and generate once' }));
  });

  const alert = screen.getByRole('alert');
  assert.match(alert.textContent!, /Acceptance unknown/);
  assert.match(alert.textContent!, /may have received/);
  assert.match(screen.getByText(/not retried automatically/i).textContent!, /not retried automatically/);
  assert.equal(screen.queryByRole('button', { name: /retry|try again|generate once/i }), null);
  assert.equal(screen.queryByRole('button', { name: 'Inspect returned image' }), null, 'no inspectable result exists yet');
  assert.equal(calls.check.length, 0, 'mounting or rendering never checks automatically');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check acceptance' }));
  });
  assert.deepEqual(calls.check, ['att-1']);
  assert.equal(generations, 1, 'checking acceptance never resubmits');
});

test('a confirmed failure offers a new review, never a resubmission of the spent review', async () => {
  let generations = 0;
  const { calls, props } = makeProps({
    onApproveAndGenerate: async () => {
      generations += 1;
      return submission({ status: 'failed', assetId: null, errorCode: 'PROVIDER_REJECTED', message: 'The route rejected the request.' });
    },
  });
  render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Approve and generate once' }));
  });

  assert.match(screen.getByRole('alert').textContent!, /Generation failed/);
  assert.match(screen.getByRole('alert').textContent!, /PROVIDER_REJECTED/);
  assert.equal(screen.queryByRole('button', { name: /retry|try again/i }), null);
  assert.equal(screen.queryByRole('button', { name: 'Approve and generate once' }), null);
  assert.equal(document.querySelector('[data-frame-result] img'), null);
  assert.match(screen.getByText(/new approval/i).textContent!, /new approval/);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare a new review' }));
  });
  assert.equal(calls.prepare.length, 1, 'returning to the draft prepares nothing');
  assert.equal(generations, 1);
  assert.equal((screen.getByRole('button', { name: 'Prepare review' }) as HTMLButtonElement).disabled, false);
});

test('a stale shot revision blocks spending and binding until a new review exists', async () => {
  const { calls, props } = makeProps();
  const view = render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });

  view.rerender(<FrameAuthoring {...props} expectedRevision={4} />);
  assert.match(screen.getByRole('alert').textContent!, /out of date/i);
  const generate = screen.getByRole('button', { name: 'Approve and generate once' }) as HTMLButtonElement;
  assert.equal(generate.disabled, true);
  fireEvent.click(generate);
  await settle();
  assert.equal(calls.generate.length, 0);

  // Prepare again against the current revision, generate, inspect, then go stale before binding.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit the draft' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });
  assert.equal(calls.prepare.at(-1)!.expectedRevision, 4);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Approve and generate once' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Inspect returned image' }));
  });
  view.rerender(<FrameAuthoring {...props} expectedRevision={5} />);
  const bind = screen.getByRole('button', { name: 'Bind to start frame' }) as HTMLButtonElement;
  assert.equal(bind.disabled, true);
  fireEvent.click(bind);
  await settle();
  assert.equal(calls.bind.length, 0);
  assert.match(screen.getByRole('alert').textContent!, /shot changed/i);
});

test('cancelling preparation aborts it and ignores the late answer without spending', async () => {
  const pending = deferred<FrameReview>();
  let signal: AbortSignal | null = null;
  const { calls, props } = makeProps({
    onPrepareReview: (draft, options) => {
      calls.prepare.push(draft);
      signal = options?.signal ?? null;
      return pending.promise;
    },
  });
  render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  assert.ok(screen.getByText(/Preparing review/));

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preparation' }));
  });
  assert.equal(signal!.aborted, true);
  await act(async () => {
    pending.resolve(review());
  });
  assert.equal(screen.queryByRole('heading', { name: 'Review request' }), null);
  assert.match(screen.getByRole('status').textContent!, /cancelled/i);
  assert.equal(calls.generate.length, 0);
});

test('cancelling a running generation confirms once, ignores a late success, and never retries', async () => {
  const generation = deferred<FrameSubmission>();
  const pendingCancel = deferred<FrameSubmission>();
  let generations = 0;
  const { calls, props } = makeProps({
    onApproveAndGenerate: () => {
      generations += 1;
      return generation.promise;
    },
    onCancelSubmission: attemptId => {
      calls.cancel.push(attemptId);
      return pendingCancel.promise;
    },
  });
  render(<FrameAuthoring {...props} />);
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve and generate once' }));
  await act(async () => {
    generation.resolve(submission({ status: 'running', progress: 20 }));
  });
  assert.ok(screen.getByRole('heading', { name: 'Generating' }));

  // A double press on cancel must still mean one cancellation request.
  const cancel = screen.getByRole('button', { name: 'Cancel generation' });
  await act(async () => {
    fireEvent.click(cancel);
    fireEvent.click(cancel);
  });
  assert.deepEqual(calls.cancel, ['att-1']);
  await act(async () => {
    pendingCancel.resolve(submission({ status: 'cancelled', assetId: null }));
  });
  assert.match(screen.getByRole('heading', { name: 'Generation cancelled' }).textContent!, /cancelled/i);
  assert.match(screen.getByText(/not retried automatically/i).textContent!, /not retried automatically/i);

  await act(async () => {
    generation.resolve(submission({ status: 'failed', errorCode: 'LATE' }));
  });
  assert.equal(screen.queryByRole('alert'), null, 'a late result must not rewrite a confirmed cancellation');
  assert.equal(screen.queryByRole('button', { name: 'Inspect returned image' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Approve and generate once' }), null);
  assert.equal(generations, 1);
});

test('returned media must come from the owned project media route', () => {
  assert.equal(safeFrameMediaUrl('/api/media/gen-1'), '/api/media/gen-1');
  assert.equal(safeFrameMediaUrl('/api/media/gen-1?rev=2'), '/api/media/gen-1?rev=2');
  for (const bad of ['https://provider.invalid/a.png', '//provider.invalid/api/media/a', 'data:image/png;base64,AA', 'javascript:alert(1)', '/api/commands', null, undefined]) {
    assert.equal(safeFrameMediaUrl(bad), undefined);
  }
});
