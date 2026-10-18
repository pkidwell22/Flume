import { createHash, randomUUID } from 'node:crypto';
import type { Activation, AttemptState, DeliveryResult, Issue, Lease, ProviderReceipt,
  PhaseQueue, WorkerDependencies, WorkerOptions, WorkerTransaction } from './ports.js';

const issue = (code: string, message: string): Issue => ({ code, message });
function hold(s: AttemptState, status: 'blocked' | 'failed' | 'acceptance_unknown', error: Issue,
  recoverPhase: AttemptState['recoverPhase'] = null) {
  const privacyHold = error.code === 'zdr-violation-by-account';
  s.phase = 'hold'; s.status = privacyHold ? 'blocked' : status; s.issue = error; s.recoverPhase = privacyHold ? null : recoverPhase;
}
function matches(receipt: ProviderReceipt, s: AttemptState): boolean {
  return !!receipt && receipt.provider === s.request.provider && receipt.scope === s.request.scope &&
    receipt.modelId === s.request.modelId && typeof receipt.providerJobId === 'string' &&
    receipt.providerJobId.length > 0 && receipt.providerJobId.length <= 512 &&
    (!s.receipt || receipt.providerJobId === s.receipt.providerJobId);
}
async function save(tx: WorkerTransaction, s: AttemptState) {
  const expectedVersion = s.version; s.version++; await tx.saveAttempt(s, expectedVersion);
}
function limits(options: WorkerOptions) {
  const values = { operationTimeoutMs: options.operationTimeoutMs ?? 30000, pollDelaySeconds: options.pollDelaySeconds ?? 5,
    maxPolls: options.maxPolls ?? 120, maxOutputs: options.maxOutputs ?? 4 };
  if (!Number.isSafeInteger(values.operationTimeoutMs) || values.operationTimeoutMs < 1 || values.operationTimeoutMs > 90000 ||
      !Number.isFinite(values.pollDelaySeconds) || values.pollDelaySeconds < 0 || values.pollDelaySeconds > 3600 ||
      !Number.isSafeInteger(values.maxPolls) || values.maxPolls < 1 || values.maxPolls > 1000 ||
      !Number.isSafeInteger(values.maxOutputs) || values.maxOutputs < 1 || values.maxOutputs > 16) throw new Error('INVALID_WORKER_LIMITS');
  return values;
}
async function bounded<T>(ms: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => action(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('PHASE_TIMEOUT')); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** One bounded phase. Transactions surround checkpoints, never provider/media I/O. */
export async function runDelivery(deps: WorkerDependencies, options: WorkerOptions = {}): Promise<DeliveryResult> {
  limits(options); const activation = await deps.queue.fetch();
  return activation ? runActivation(deps, activation, options) : 'idle';
}
export async function runActivation(deps: WorkerDependencies, activation: Activation, options: WorkerOptions = {}): Promise<DeliveryResult> {
  const { store, queue, provider } = deps; const config = limits(options);
  const owner = randomUUID();
  const claimed = await store.transaction(async tx => {
    if (!await queue.lock(tx, activation)) return null;
    const s = await tx.loadAttempt(activation.attemptId);
    if (!s) throw new Error('ATTEMPT_NOT_FOUND');
    s.owner = owner; s.epoch++; await save(tx, s); return s;
  });
  if (!claimed) return 'stale';
  const lease: Lease = { activation, owner, epoch: claimed.epoch };
  // Queue row BEFORE lifecycle row, at claim and EVERY checkpoint/ack. This fences the fetch-to-claim gap.
  const update = async (action: (s: AttemptState, tx: WorkerTransaction) => Promise<void> | void, finish = true) =>
    store.transaction(async tx => {
      if (!await queue.lock(tx, lease.activation)) return null;
      const s = await tx.loadAttempt(activation.attemptId);
      if (!s || s.owner !== lease.owner || s.epoch !== lease.epoch) return null;
      // Observation writers take this same attempt lock. Reconcile INSIDE every
      // fenced checkpoint, including the final publication transaction.
      const evidence = [...await tx.receipts(s.id), ...(s.receipt ? [s.receipt] : [])];
      const conflict = evidence.some(r => !matches(r,s)) || new Set(evidence.map(r => r.providerJobId)).size > 1;
      if (conflict) hold(s,'blocked',issue('IDENTITY_CONFLICT','Conflicting provider acceptance evidence requires investigation. Owned historical media is retained.'));
      else await action(s, tx);
      await save(tx, s);
      if (finish) {
        if (s.phase !== 'hold' && s.phase !== 'done') await queue.enqueue(tx, s.id, s.phase === 'poll' ? config.pollDelaySeconds : 0);
        await queue.complete(tx, activation);
      }
      return s;
    });
  const outcome = (s: AttemptState | null): DeliveryResult => s?.status ?? 'stale';
  if (claimed.phase === 'hold' || claimed.phase === 'done') return outcome(await update(() => {}));
  if (claimed.phase === 'submit') {
    let post = false;
    const intentState = await update(async (s, tx) => {
      if (!s.dispatch) {
        if (createHash('sha256').update(s.request.body).digest('hex') !== s.request.bodySha256) {
          hold(s, 'blocked', issue('REQUEST_INTEGRITY', 'The reviewed request no longer matches its stored digest.')); return;
        }
        const authorization = await tx.authorizeDispatch(s);
        if (!authorization.allowed) { hold(s, 'blocked', authorization.issue); return; }
        s.dispatch = { key: s.id, request: structuredClone(s.request) };
        s.remoteState = 'unknown'; s.status = 'acceptance_unknown';
        s.issue = issue('DISPATCH_IN_FLIGHT', 'Dispatch intent is durable; provider acceptance is not yet known.');
        post = true;
      }
    }, false);
    if (!intentState) return 'stale';
    if (intentState.phase === 'hold') return outcome(await update(() => {}));
    if (!post) {
      const observed = await store.transaction(tx => tx.receipts(intentState.id));
      const receipts = [...observed, ...(intentState.receipt ? [intentState.receipt] : [])];
      if (receipts.some(r => !matches(r, intentState)) || new Set(receipts.map(r => r.providerJobId)).size > 1)
        return outcome(await update(s => hold(s, 'blocked', issue('IDENTITY_CONFLICT', 'Conflicting provider acceptance evidence requires investigation.'))));
      let receipt = receipts[0];
      if (!receipt && provider.lookup) {
        try {
          const found = await bounded(config.operationTimeoutMs, async signal => {
            const value = await provider.lookup!(intentState.dispatch!, signal);
            if (value && matches(value, intentState)) await store.observeReceipt(intentState.id, intentState.dispatch!, value);
            return value;
          });
          if (found) receipt = found;
        } catch { /* Read-only lookup cannot justify a new POST. */ }
      }
      return outcome(await update(s => {
        if (!receipt) hold(s, 'acceptance_unknown', issue('ACCEPTANCE_UNKNOWN', 'Acceptance is unknown. This attempt will not be submitted again.'), 'submit');
        else if (!matches(receipt, s)) hold(s, 'blocked', issue('IDENTITY_CONFLICT', 'Lookup returned a different provider identity.'));
        else { s.receipt = receipt; s.remoteState = 'running'; s.phase = 'poll'; s.status = 'running'; s.issue = null; }
      }));
    }
    let result;
    try {
      result = await bounded(config.operationTimeoutMs, async signal => {
        const value = await provider.submit(intentState.dispatch!, signal);
        // Append valid late acceptance even after ownership changes; only a current lease can adopt it.
        if (value.kind === 'accepted' && matches(value.receipt, intentState))
          await store.observeReceipt(intentState.id, intentState.dispatch!, value.receipt);
        return value;
      });
    } catch {
      return outcome(await update(s => hold(s, 'acceptance_unknown', issue('ACCEPTANCE_UNKNOWN',
        'The provider may have accepted this request. No automatic submission retry is safe.'), 'submit')));
    }
    return outcome(await update(s => {
      if (result.kind === 'accepted') {
        if (!matches(result.receipt, s)) { hold(s, 'blocked', issue('IDENTITY_CONFLICT', 'Provider receipt does not match the reviewed identity.')); return; }
        s.receipt = result.receipt; s.remoteState = 'running'; s.phase = 'poll'; s.status = 'running'; s.issue = null;
      } else if (result.kind === 'unknown') hold(s, 'acceptance_unknown', result.issue, 'submit');
      else hold(s, result.kind === 'blocked' ? 'blocked' : 'failed', result.issue);
    }));
  }
  if (!claimed.receipt || !matches(claimed.receipt, claimed))
    return outcome(await update(s => hold(s, 'blocked', issue('IDENTITY_CONFLICT', 'A verified provider receipt is required.'))));
  if (claimed.phase === 'poll') {
    const polling = await update(s => {
      if (s.polls >= config.maxPolls) hold(s, 'blocked', issue('POLL_LIMIT', 'Automatic status checks reached their limit. Resume to check again.'), 'poll');
      else s.polls++;
    }, false);
    if (!polling) return 'stale';
    if (polling.phase === 'hold') return outcome(await update(() => {}));
    let result;
    try { result = await bounded(config.operationTimeoutMs, signal => provider.status(claimed.receipt!, signal)); }
    catch { return outcome(await update(s => hold(s, 'blocked', issue('STATUS_UNAVAILABLE', 'Provider status could not be read. Resume is read-only.'), 'poll'))); }
    return outcome(await update(s => {
      if (result.kind === 'running' || result.kind === 'succeeded') {
        if (!matches(result.receipt, s)) { hold(s, 'blocked', issue('IDENTITY_CONFLICT', 'Status returned a different provider identity.')); return; }
        if (result.kind === 'succeeded') { s.remoteState = 'succeeded'; s.phase = 'retrieve'; s.status = 'retrieving'; s.issue = null; }
        else if (s.polls >= config.maxPolls) hold(s, 'blocked', issue('POLL_LIMIT', 'Automatic status checks reached their limit. Resume to check again.'), 'poll');
        else { s.remoteState = 'running'; s.status = 'running'; s.issue = null; }
      } else {
        if (result.kind === 'failed') s.remoteState = 'failed';
        hold(s, result.kind === 'failed' ? 'failed' : 'blocked', result.issue, result.kind === 'unavailable' ? 'poll' : null);
      }
    }));
  }
  if (claimed.phase === 'retrieve') {
    let result;
    try { result = await bounded(config.operationTimeoutMs, signal => provider.outputs(claimed.receipt!, signal)); }
    catch { return outcome(await update(s => hold(s, 'blocked', issue('OUTPUTS_UNAVAILABLE', 'The remote result exists, but its media manifest could not be retrieved.'), 'retrieve'))); }
    return outcome(await update(s => {
      if (result.kind !== 'outputs') { hold(s, 'blocked', result.issue, result.kind === 'unavailable' ? 'retrieve' : null); return; }
      if (!matches(result.receipt, s)) { hold(s, 'blocked', issue('IDENTITY_CONFLICT', 'Media manifest returned a different provider identity.')); return; }
      const outputs = result.outputs;
      const valid = Array.isArray(outputs) && outputs.length > 0 && outputs.length <= config.maxOutputs &&
        outputs.every(o => o !== null && typeof o === 'object') &&
        new Set(outputs.map(o => o.outputId)).size === outputs.length && outputs.every(o =>
          typeof o.outputId === 'string' && o.outputId.length > 0 && o.outputId.length <= 512 &&
          typeof o.url === 'string' && o.url.length <= 16384 && /^https?:\/\//.test(o.url) &&
          (o.sha256 === undefined || /^[a-f0-9]{64}$/.test(o.sha256)));
      if (!valid) { hold(s, 'blocked', issue('OUTPUT_MANIFEST_INVALID', 'The provider returned an invalid or unbounded output manifest.')); return; }
      s.outputs = outputs; s.phase = 'import'; s.status = 'retrieving'; s.issue = null;
    }));
  }
  if (claimed.phase === 'import') {
    const output = claimed.outputs.find(o => !Object.hasOwn(claimed.imports, o.outputId));
    if (!output) return outcome(await update(s => { s.phase = 'done'; s.status = 'ready'; s.issue = null; }));
    const importKey = createHash('sha256').update(JSON.stringify([claimed.id, claimed.receipt.provider,
      claimed.receipt.scope, claimed.receipt.providerJobId, output.outputId])).digest('hex');
    let owned;
    try {
      owned = await bounded(config.operationTimeoutMs, signal => deps.media.ownOutput({ projectId: claimed.projectId,
        attemptId: claimed.id, receipt: claimed.receipt!, output, importKey }, signal));
      if (!owned || typeof owned.assetId !== 'string' || !owned.assetId || !owned.storageKey ||
          !/^[a-f0-9]{64}$/.test(owned.sha256) || (output.sha256 !== undefined && owned.sha256 !== output.sha256) ||
          !Number.isSafeInteger(owned.byteLength) || owned.byteLength < 1 || !Number.isSafeInteger(owned.width) || owned.width < 1 ||
          !Number.isSafeInteger(owned.height) || owned.height < 1 || !['image', 'video'].includes(owned.kind)) throw new Error('INVALID_OWNED_MEDIA');
    } catch { return outcome(await update(s => hold(s, 'blocked', issue('IMPORT_PENDING', 'Remote generation succeeded; owned media is not yet available. Resume import without resubmitting.'), 'import'))); }
    // SQL publication is all-or-nothing with checkpoint and queue handoff. If it fails,
    // leave the job active for pg-boss recovery; the media port must reuse owned bytes.
    return outcome(await update(async (s, tx) => {
      const take = await tx.publishTake(s, output, owned);
      s.imports = { ...s.imports, [output.outputId]: take };
      const complete = s.outputs.every(o => Object.hasOwn(s.imports, o.outputId));
      s.phase = complete ? 'done' : 'import'; s.status = complete ? 'ready' : 'retrieving'; s.issue = null;
    }));
  }
  throw new Error('INVALID_PHASE');
}

/** Call only after server-side command authorization/replay checks, inside its transaction.
 * Resumes reads/imports, never clears dispatch identity and never permits a second POST.
 * Nonterminal phases can be explicitly recovered after queue retry exhaustion. The server
 * deduplicates resume commands; multiple deliveries are safe but not useful. Privacy holds cannot resume. */
export async function resumeAttempt(tx: WorkerTransaction, queue: PhaseQueue, attemptId: string): Promise<string | null> {
  const s = await tx.loadAttempt(attemptId);
  if (!s) throw new Error('ATTEMPT_NOT_FOUND');
  if (s.phase === 'done' || (s.phase === 'hold' && s.recoverPhase === null)) return null;
  if (s.phase === 'hold') s.phase = s.recoverPhase!;
  s.recoverPhase = null; s.issue = null;
  s.status = s.phase === 'submit' ? (s.dispatch ? 'acceptance_unknown' : 'queued') : s.phase === 'poll' ? 'running' : 'retrieving';
  s.owner = null; s.epoch++; s.polls = 0;
  await save(tx, s); return queue.enqueue(tx, s.id);
}
