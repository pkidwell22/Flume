import { setTimeout as sleep } from 'node:timers/promises';
import { runDelivery } from './coordinator.js';
import type { WorkerDependencies, WorkerOptions } from './ports.js';
export interface RunWorkerOptions extends WorkerOptions {
  signal: AbortSignal; idleDelayMs?: number; onError: (error: unknown) => void;
}
/** One serial worker, no auto-ack. On shutdown drain the bounded current phase before
 * the caller stops boss/pool. On infrastructure failure leave the active delivery to
 * pg-boss supervision; never blindly fail/complete an activation owned by someone else.
 * No startup/drop/migration hooks and no shared service ownership. */
export async function runWorker(deps: WorkerDependencies, options: RunWorkerOptions): Promise<void> {
  const delay = options.idleDelayMs ?? 500;
  if (!Number.isSafeInteger(delay) || delay < 10 || delay > 10000) throw new Error('INVALID_IDLE_DELAY');
  while (!options.signal.aborted) {
    try { if (await runDelivery(deps, options) !== 'idle') continue; }
    catch (error) { options.onError(error); }
    try { await sleep(delay, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
}
