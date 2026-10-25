/**
 * RED→GREEN regressions for the real-database continuation failure the coordinator reproduced
 * against the authorized disposable PostgreSQL:
 *
 *   explicit resume of a seeded extracted frame -> continue-shot.ts advance() -> save() matched no
 *   row -> CONTINUE_CONCURRENT, before shot.create.
 *
 * Root cause, restated as an assertion: `begin()` inserts the journal row WITHOUT owner_token /
 * fence / lease_expires_at and then acquires a separate lease row, while SAVE_SQL required
 * `j.owner_token = $n AND j.fence = $n AND j.lease_expires_at > clock_timestamp()` on that same
 * journal row. The first legitimate save could therefore never match, and ownership renewal lived
 * on the journal shadow instead of the authority `isActive()` consults.
 *
 * These tests run against `journal-lease-simulator.ts`: two tables with DISTINCT columns, DDL
 * defaults for the journal mirror, and guard predicates evaluated from the statement text. A
 * scripted mock that returns canned success rows cannot express this bug, which is exactly why the
 * original suite stayed green while the database failed. See the simulator header for the limits
 * of that model; the coordinator's real-SQL rerun remains the acceptance gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintPayload } from '../src/authoring-operation-lock.ts';
import { createSqlContinueShotJournal } from '../src/continue-shot-store.ts';
import {
  continueShotIntentHash, createContinueShot, type ContinueShotCommand, type ContinueShotJournal, type ContinueShotRecord,
} from '../src/continue-shot.ts';
import { defaultControls, type Actor } from '../src/contracts.ts';
import { createJournalLeaseSimulator } from './journal-lease-simulator.ts';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '10000000-0000-4000-8000-000000000002';
const OPERATOR = '30000000-0000-4000-8000-000000000001';
const SOURCE_SHOT = '40000000-0000-4000-8000-000000000001';
const TAKE = '50000000-0000-4000-8000-000000000001';
const VIDEO = '60000000-0000-4000-8000-000000000001';
const DERIVED = '70000000-0000-4000-8000-000000000001';
const OP = '90000000-0000-4000-8000-000000000001';
const VIDEO_SHA = 'a'.repeat(64);
const TITLE = 'Continue from take 50000000';
const PROMPT = 'The figure reaches the door.';
const TTL = 60_000;

const operator = (): Actor => ({ id: OPERATOR, kind: 'operator', projectIds: [PROJECT] });

/** The SQL journal always exposes the read-only liveness probe; assert it rather than assume it. */
async function active(journal: ContinueShotJournal, operationId: string): Promise<boolean> {
  const probe = journal.isActive;
  if (typeof probe !== 'function') throw new Error('the SQL journal must expose a read-only liveness probe');
  return (await probe.call(journal, operationId)) === true;
}

function createCommand(): ContinueShotCommand {
  return { type: 'shot.create', commandId: 'aaaaaaa1-0000-4000-8000-000000000001', projectId: PROJECT, title: TITLE, prompt: PROMPT };
}

function baseRecord(overrides: Partial<ContinueShotRecord> = {}): ContinueShotRecord {
  return {
    operationId: OP, projectId: PROJECT, actorId: OPERATOR, actorKind: 'operator',
    intentHash: continueShotIntentHash({
      projectId: PROJECT, sourceTakeId: TAKE, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA,
      title: TITLE, prompt: PROMPT, actorId: OPERATOR, actorKind: 'operator',
    }),
    sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA,
    title: TITLE, prompt: PROMPT, status: 'pending', extractionDispatched: false,
    extractedAssetId: null, shotId: null, shotRevision: null,
    createPayload: null, createPayloadHash: null, bindPayload: null, bindPayloadHash: null,
    blockers: [], message: null, resumable: true, updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function world() {
  const assets: any[] = [{
    id: VIDEO, projectId: PROJECT, filename: 'take.mp4', kind: 'video', origin: 'generated',
    sha256: VIDEO_SHA, mediaUrl: `/api/media/${VIDEO}`, width: 64, height: 48, durationSeconds: 5,
  }];
  const shots: any[] = [{
    id: SOURCE_SHOT, projectId: PROJECT, title: 'Take one', prompt: 'A figure enters.', revision: 1,
    controls: { ...defaultControls }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null },
    selectedTakeId: null, selectionRevision: 0,
  }];
  const commands: any[] = [];
  const extractions: string[] = [];
  return {
    assets, shots, commands, extractions,
    ports: {
      getWorkspace: async () => ({
        project: { id: PROJECT, name: 'Film', brief: '', revision: 1 },
        shots: structuredClone(shots), assets: structuredClone(assets),
        takes: [{ id: TAKE, projectId: PROJECT, shotId: SOURCE_SHOT, attemptId: 'a0000000-0000-4000-8000-000000000001', assetId: VIDEO, createdAt: '2026-01-01T00:00:00.000Z' }],
        attempts: [], reviews: [], exports: [], capabilities: [],
      }) as any,
      extractReferenceFrame: async () => {
        extractions.push(VIDEO);
        const derived = {
          id: DERIVED, projectId: PROJECT, filename: 'frame.png', kind: 'image', origin: 'imported',
          sha256: 'b'.repeat(64), mediaUrl: '/api/media/f', width: 8, height: 8,
          provenance: { kind: 'extracted-frame', frame: 'last', sourceAssetId: VIDEO, sourceSha256: VIDEO_SHA },
        };
        assets.push(derived);
        return derived as any;
      },
      command: async (_actor: Actor, command: any) => {
        commands.push(command);
        if (command.type === 'shot.create') {
          const created = {
            id: '80000000-0000-4000-8000-000000000001', projectId: PROJECT, title: command.title,
            prompt: command.prompt, revision: 1, controls: { ...defaultControls },
            bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0,
          };
          shots.push(created);
          return { commandId: command.commandId, projectId: PROJECT, resourceId: created.id, revision: 1 } as any;
        }
        const shot = shots.find(item => item.id === command.shotId)!;
        shot.bindings = { ...shot.bindings, ...command.patch.bindings };
        shot.revision += 1;
        return { commandId: command.commandId, projectId: PROJECT, resourceId: shot.id, revision: shot.revision } as any;
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The production failure: the first save after begin, and the resume that surfaced it
// ---------------------------------------------------------------------------------------------

test('the first journal save after begin matches the live lease instead of the row it just created', async () => {
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: TTL });
  const begun = await journal.begin(baseRecord());
  assert.equal(begun.created, true);
  assert.ok(begun.lease, 'begin must acquire the fenced lease');

  const guard = { ownerToken: begun.lease!.ownerToken, fence: begun.lease!.fence };
  const payload = createCommand();
  const before = sim.calls.length;
  const saved = await journal.save(
    { ...begun.record, status: 'creating', createPayload: payload, createPayloadHash: fingerprintPayload(payload) },
    [begun.record.status], guard,
  );

  assert.equal(sim.calls.length - before, 1, 'save must be ONE guarded statement: no read-then-write window');
  assert.ok(saved, 'the first legitimate save after begin must not be reported as a lost race (production: CONTINUE_CONCURRENT)');
  assert.equal(saved!.status, 'creating');
  assert.equal(saved!.createPayloadHash, fingerprintPayload(payload));
  assert.equal(sim.journalRow(OP)?.status, 'creating');
});

test('begin mirrors the live lease onto the journal row, and the mirror tracks the authority', async () => {
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: TTL });
  const begun = await journal.begin(baseRecord());

  const journalRow = sim.journalRow(OP)!;
  const leaseRow = sim.leaseRow('continue-shot', OP)!;
  assert.ok(leaseRow, 'the lease row is the canonical authority');
  assert.equal(journalRow.owner_token, leaseRow.owner_token, 'the journal mirror records the owner begin acquired');
  assert.equal(journalRow.fence, leaseRow.fence, 'the journal mirror records the fence begin acquired');
  assert.equal(journalRow.lease_expires_at, leaseRow.lease_expires_at, 'the mirror expiry equals the canonical expiry');
  assert.equal(begun.record.status, 'pending', 'mirroring the lease must not advance the journal status');
});

test('a second service instance resumes a seeded extracted record and completes the continuation', async () => {
  const fixture = world();
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: TTL });

  // Seed the exact durable state the coordinator had in PostgreSQL: extracted, no shot, idle owner.
  const seeded = baseRecord({ status: 'extracted', extractionDispatched: true, extractedAssetId: DERIVED });
  const begun = await journal.begin(seeded);
  assert.ok(begun.lease);
  await journal.release(OP, { ownerToken: begun.lease!.ownerToken, fence: begun.lease!.fence });
  assert.equal(sim.leaseRow('continue-shot', OP)?.released_at !== null, true, 'the seeding owner released');

  const service = createContinueShot({ ...fixture.ports, journal, now: () => new Date(sim.now()).toISOString() });
  const outcome = await service.resumeContinueShot(operator(), { projectId: PROJECT, operationId: OP });

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.resumed, true);
  assert.equal(outcome.extractedAssetId, DERIVED);
  assert.deepEqual(fixture.extractions, [], 'resuming an extracted record must not extract again');
  assert.equal(fixture.commands.filter((command: any) => command.type === 'shot.create').length, 1);
  assert.equal(fixture.commands.filter((command: any) => command.type === 'shot.update').length, 1);
  assert.equal(sim.journalRow(OP)?.status, 'completed');
  assert.equal(sim.journalRow(OP)?.shot_revision, 2);
});

// ---------------------------------------------------------------------------------------------
// Stale authority: released, expired and superseded owners must never save
// ---------------------------------------------------------------------------------------------

test('a released lease cannot save, while the same owner could save before releasing', async () => {
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: TTL });
  const begun = await journal.begin(baseRecord());
  const guard = { ownerToken: begun.lease!.ownerToken, fence: begun.lease!.fence };

  const live = await journal.save({ ...begun.record, status: 'extracting', extractionDispatched: true }, ['pending'], guard);
  assert.equal(live?.status, 'extracting', 'control: the live owner saves');

  await journal.release(OP, guard);
  assert.equal(sim.leaseRow('continue-shot', OP)?.released_at !== null, true);

  const afterRelease = await journal.save(begun.record, ['extracting'], guard);
  assert.equal(afterRelease, null, 'a released lease must not authorise a write');
  assert.equal(sim.journalRow(OP)?.status, 'extracting', 'the refused save must not advance the status');
  assert.equal(await active(journal, OP), false);
});

test('an expired lease cannot save; a takeover fences the old owner out', async () => {
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: 250 });
  const begun = await journal.begin(baseRecord());
  const staleGuard = { ownerToken: begun.lease!.ownerToken, fence: begun.lease!.fence };
  const live = await journal.save({ ...begun.record, status: 'extracting', extractionDispatched: true }, ['pending'], staleGuard);
  assert.equal(live?.status, 'extracting', 'control: the live owner saves');

  sim.advance(300);
  assert.equal(await active(journal, OP), false, 'the lease has expired');
  assert.equal(await journal.save(begun.record, ['extracting'], staleGuard), null, 'an expired owner must not write');

  const takeover = await journal.begin(baseRecord({ status: 'extracting', extractionDispatched: true }));
  assert.ok(takeover.lease, 'an expired lease must be takeable');
  assert.equal(takeover.lease!.fence, staleGuard.fence + 1, 'takeover increments the fence');

  const freshGuard = { ownerToken: takeover.lease!.ownerToken, fence: takeover.lease!.fence };
  assert.equal(await journal.save({ ...begun.record, status: 'extracted' }, ['extracting'], staleGuard), null, 'a superseded fence must not write');
  const saved = await journal.save({ ...begun.record, status: 'extracted', extractedAssetId: DERIVED }, ['extracting'], freshGuard);
  assert.equal(saved?.status, 'extracted');
  assert.equal(sim.journalRow(OP)?.extracted_asset_id, DERIVED);
});

// ---------------------------------------------------------------------------------------------
// Renewal consistency: one authority, observed by isActive()
// ---------------------------------------------------------------------------------------------

test('a successful save renews the canonical lease that isActive() observes, not just the journal mirror', async () => {
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: TTL });
  const startedAt = sim.now();
  const begun = await journal.begin(baseRecord());
  const guard = { ownerToken: begun.lease!.ownerToken, fence: begun.lease!.fence };
  assert.equal(sim.leaseRow('continue-shot', OP)!.lease_expires_at, startedAt + TTL);

  sim.advance(30_000);
  const saved = await journal.save({ ...begun.record, status: 'extracting', extractionDispatched: true }, ['pending'], guard);
  assert.equal(saved?.status, 'extracting');

  const lease = sim.leaseRow('continue-shot', OP)!;
  assert.equal(lease.lease_expires_at, startedAt + 30_000 + TTL, 'the save renewed the canonical lease by one ttl');
  assert.equal(sim.journalRow(OP)!.lease_expires_at, lease.lease_expires_at, 'the journal mirror equals the renewed authority');
  assert.equal(await active(journal, OP), true);

  // Past the ORIGINAL expiry but inside the renewal: only a renewed authority keeps the owner live.
  sim.advance(40_000);
  assert.equal(await active(journal, OP), true, 'renewal is what keeps a slow but healthy owner live');
  sim.advance(30_000);
  assert.equal(await active(journal, OP), false, 'liveness still expires on the canonical row');
});

test('a lost status CAS neither advances the row nor renews the lease', async () => {
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: TTL });
  const begun = await journal.begin(baseRecord());
  const guard = { ownerToken: begun.lease!.ownerToken, fence: begun.lease!.fence };
  const expiry = sim.leaseRow('continue-shot', OP)!.lease_expires_at;

  sim.advance(1_000);
  const lost = await journal.save({ ...begun.record, status: 'creating' }, ['extracted'], guard);
  assert.equal(lost, null, 'a save from a status the row is not in must not land');
  assert.equal(sim.journalRow(OP)?.status, 'pending');
  assert.equal(sim.leaseRow('continue-shot', OP)!.lease_expires_at, expiry, 'a failed CAS must not renew the lease either');
});

test('a save for another project cannot ride a lease from this one', async () => {
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: TTL });
  const begun = await journal.begin(baseRecord());
  const guard = { ownerToken: begun.lease!.ownerToken, fence: begun.lease!.fence };

  const crossProject = await journal.save({ ...begun.record, projectId: OTHER_PROJECT, status: 'creating' }, ['pending'], guard);
  assert.equal(crossProject, null, 'the guard is scoped to the exact project/scope/operation/owner/fence');
  assert.equal(sim.journalRow(OP)?.status, 'pending');
});

// ---------------------------------------------------------------------------------------------
// Reads stay non-mutating
// ---------------------------------------------------------------------------------------------

test('journal reads never acquire, renew or release anything', async () => {
  const sim = createJournalLeaseSimulator();
  const journal = createSqlContinueShotJournal(sim.sql, { leaseTtlMs: TTL });
  const begun = await journal.begin(baseRecord());
  assert.ok(begun.lease);
  const index = sim.calls.length;

  await journal.load(OP);
  await active(journal, OP);
  await journal.load('90000000-0000-4000-8000-0000000000ff');
  await active(journal, '90000000-0000-4000-8000-0000000000ff');

  assert.deepEqual(sim.writesSince(index), [], 'no write may be issued by a read path');
  assert.equal(sim.leaseRow('continue-shot', OP)!.released_at, null, 'reads do not release the owner lease');
});
