import { openExperiment } from '../src/database.js';
import { runDelivery, type Policy } from './engine.js';
// One actual OS process per bounded delivery. IPC checkpoints only schedule faults.
const policy = JSON.parse(process.argv[2]!) as Policy;
const pause = process.argv[3];
const experiment = await openExperiment({ initialize: false });
try {
  const result = await runDelivery(experiment, policy, async point => {
    process.send?.({ point });
    if (point === pause) await new Promise<void>(resolve => process.once('message', () => resolve()));
  });
  process.send?.({ result });
} finally {
  try { await experiment.close(); } finally { process.disconnect?.(); }
}
