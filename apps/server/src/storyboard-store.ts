/**
 * Durable PostgreSQL adapter for `StoryboardProposalStore` (requires migration
 * `011_authoring_journals.sql`, which is NOT applied by this worker).
 *
 * Executor contract (read before wiring):
 *  - `executor.query(text, params)` must be a single-statement API (a `pg.Pool` or a checked-out
 *    `pg.PoolClient` both qualify).
 *  - Every mutation is expressed as ONE statement whose `WHERE` clause carries the guards
 *    (status/revision, or lease owner+fence). There is no read-modify-write in this file, so a
 *    `Pool` (each call on a possibly different connection) is safe for correctness; PostgreSQL's
 *    own row locks order concurrent writers.
 *  - Methods that mutate and then return the full proposal run a second SELECT *after* the write
 *    has committed. Do not pass a `PoolClient` inside an uncommitted caller transaction unless the
 *    caller commits before using the returned record; with a `Pool` this is automatic.
 *  - The returned object's `.lease` is the SQL-backed `authoring_operation_leases` lock
 *    (`createSqlAuthoringOperationLock`). Pass the same executor so item claims join the lease row
 *    that authorised them.
 *  - Do NOT use `save()` to update: it is create-if-absent (`ON CONFLICT DO NOTHING`).
 */
import {
  createSqlAuthoringOperationLock,
  type AuthoringLease,
  type AuthoringSqlExecutor,
} from './authoring-operation-lock.ts';
import type {
  FrozenShotCreate, ProposalItem, ProposalStatus, ShotCreateCommand, StoryboardAcceptInput,
  StoryboardItemSettlement, StoryboardProposal, StoryboardProposalStore,
} from './storyboard-proposals.ts';

export type StoryboardSqlExecutor = AuthoringSqlExecutor;

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());

type ItemRow = {
  item_id: string; title: string; direction: string; start_description: string; end_description: string;
  duration_seconds: number; continuity_notes: string; state: string; shot_id: string | null;
  command_id: string | null; code: string | null;
};

/** `issued` means "a command was dispatched and its result was not recorded". To a caller that is
 * an UNKNOWN outcome, never a reason to assume the work did not happen. */
function itemStateOf(state: string): ProposalItem['state'] {
  if (state === 'created') return 'created';
  if (state === 'failed') return 'failed';
  if (state === 'pending') return 'pending';
  return 'unknown';
}

function itemFromRow(row: ItemRow): ProposalItem {
  return {
    itemId: row.item_id,
    title: row.title,
    direction: row.direction,
    startDescription: row.start_description,
    endDescription: row.end_description,
    durationSeconds: num(row.duration_seconds),
    continuityNotes: row.continuity_notes ?? '',
    state: itemStateOf(row.state),
    shotId: row.shot_id ?? null,
    commandId: row.command_id ?? null,
    code: row.state === 'issued' ? (row.code ?? 'COMMAND_OUTCOME_UNKNOWN') : (row.code ?? null),
  };
}

const PROPOSAL_SELECT = `SELECT p.project_id, p.id, p.status, p.revision, p.bounds, p.failure,
  p.cancel_requested, p.planner_model_id, p.request_hash, p.proposed_by, p.proposed_by_kind,
  p.accepted_by, p.accepted_by_kind, p.created_at,
  COALESCE((SELECT json_agg(json_build_object(
      'item_id', i.item_id, 'title', i.title, 'direction', i.direction,
      'start_description', i.start_description, 'end_description', i.end_description,
      'duration_seconds', i.duration_seconds, 'continuity_notes', i.continuity_notes,
      'state', i.state, 'shot_id', i.shot_id, 'command_id', i.command_id, 'code', i.code
    ) ORDER BY i.ordinal) FROM flume.storyboard_proposal_items i
    WHERE i.project_id = p.project_id AND i.proposal_id = p.id), '[]'::json) AS items
  FROM flume.storyboard_proposals p WHERE p.project_id = $1 AND p.id = $2`;

function proposalFromRow(row: any): StoryboardProposal {
  const items: ItemRow[] = Array.isArray(row.items) ? row.items : [];
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as ProposalStatus,
    revision: num(row.revision),
    createdAt: iso(row.created_at),
    bounds: row.bounds,
    items: items.map(itemFromRow),
    cancelRequested: row.cancel_requested === true,
    failure: row.failure ?? null,
    provenance: {
      plannerModelId: row.planner_model_id,
      requestHash: row.request_hash,
      proposedBy: row.proposed_by,
      proposedByKind: row.proposed_by_kind,
      acceptedBy: row.accepted_by ?? null,
      acceptedByKind: row.accepted_by_kind ?? null,
    },
  };
}

/** Durable lease predicate replicated in every guarded statement. $1 project, $2 proposal, $3 op,
 *  $4 owner token, $5 fence — kept in sync with `authoring_operation_leases`. */
const LEASE_GUARD = (project: string, operation: string, owner: string, fence: string) => `EXISTS (
    SELECT 1 FROM flume.authoring_operation_leases l
    WHERE l.scope = 'storyboard.apply' AND l.operation_id = ${operation} AND l.project_id = ${project}
      AND l.owner_token = ${owner} AND l.fence = ${fence}
      AND l.released_at IS NULL AND l.lease_expires_at > clock_timestamp())`;

export function createSqlStoryboardStore(sql: StoryboardSqlExecutor): StoryboardProposalStore {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A SQL executor with query(text, params) is required.');
  const lease = createSqlAuthoringOperationLock(sql);

  const read = async (projectId: string, proposalId: string): Promise<StoryboardProposal | null> => {
    const { rows } = await sql.query(PROPOSAL_SELECT, [projectId, proposalId]);
    return rows[0] ? proposalFromRow(rows[0]) : null;
  };

  return {
    lease,

    async save(proposal) {
      await sql.query(`WITH created AS (
          INSERT INTO flume.storyboard_proposals
            (project_id, id, status, revision, bounds, failure, cancel_requested, planner_model_id,
             request_hash, proposed_by, proposed_by_kind, created_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (project_id, id) DO NOTHING
          RETURNING id
        )
        INSERT INTO flume.storyboard_proposal_items
          (project_id, proposal_id, item_id, ordinal, title, direction, start_description,
           end_description, duration_seconds, continuity_notes, state)
        SELECT $1, $2, e.item_id, e.ordinal, e.title, e.direction, e.start_description,
               e.end_description, e.duration_seconds, e.continuity_notes, 'pending'
        FROM jsonb_to_recordset($13::jsonb) AS e(
          item_id uuid, ordinal integer, title text, direction text, start_description text,
          end_description text, duration_seconds integer, continuity_notes text)
        WHERE EXISTS (SELECT 1 FROM created)`, [
        proposal.projectId, proposal.id, proposal.status, proposal.revision,
        JSON.stringify(proposal.bounds), proposal.failure === null ? null : JSON.stringify(proposal.failure),
        proposal.cancelRequested, proposal.provenance.plannerModelId, proposal.provenance.requestHash,
        proposal.provenance.proposedBy, proposal.provenance.proposedByKind, proposal.createdAt,
        JSON.stringify(proposal.items.map((item, ordinal) => ({
          item_id: item.itemId, ordinal, title: item.title, direction: item.direction,
          start_description: item.startDescription, end_description: item.endDescription,
          duration_seconds: item.durationSeconds, continuity_notes: item.continuityNotes,
        }))),
      ]);
    },

    async saveDraft(proposal, expectedRevision) {
      const { rows } = await sql.query(`WITH target AS (
          SELECT 1 FROM flume.storyboard_proposals
          WHERE project_id = $1 AND id = $2 AND status = 'draft' AND revision = $3
          FOR UPDATE
        ), items AS (
          UPDATE flume.storyboard_proposal_items i
          SET title = e.title, direction = e.direction, start_description = e.start_description,
              end_description = e.end_description, duration_seconds = e.duration_seconds,
              continuity_notes = e.continuity_notes, ordinal = e.ordinal, updated_at = clock_timestamp()
          FROM jsonb_to_recordset($4::jsonb) AS e(
            item_id uuid, ordinal integer, title text, direction text, start_description text,
            end_description text, duration_seconds integer, continuity_notes text)
          WHERE EXISTS (SELECT 1 FROM target)
            AND i.project_id = $1 AND i.proposal_id = $2 AND i.item_id = e.item_id
          RETURNING i.item_id
        ), bumped AS (
          UPDATE flume.storyboard_proposals p
          SET revision = p.revision + 1, failure = NULL, updated_at = clock_timestamp()
          WHERE p.project_id = $1 AND p.id = $2 AND EXISTS (SELECT 1 FROM target)
          RETURNING p.id
        )
        SELECT (SELECT count(*) FROM items) AS item_count, (SELECT count(*) FROM bumped) AS bumped`, [
        proposal.projectId, proposal.id, expectedRevision,
        JSON.stringify(proposal.items.map((item, ordinal) => ({
          item_id: item.itemId, ordinal, title: item.title, direction: item.direction,
          start_description: item.startDescription, end_description: item.endDescription,
          duration_seconds: item.durationSeconds, continuity_notes: item.continuityNotes,
        }))),
      ]);
      if (num(rows[0]?.bumped) !== 1) return null;
      return read(proposal.projectId, proposal.id);
    },

    load: read,

    async list(projectId) {
      const { rows } = await sql.query(
        `SELECT id FROM flume.storyboard_proposals WHERE project_id = $1 ORDER BY created_at, id`, [projectId],
      );
      const records: StoryboardProposal[] = [];
      for (const row of rows) {
        const found = await read(projectId, row.id);
        if (found) records.push(found);
      }
      return records;
    },

    async loadFrozen(projectId, proposalId) {
      const { rows } = await sql.query(
        `SELECT item_id, command_id, frozen_payload, frozen_payload_hash, command_actor_id, command_actor_kind
         FROM flume.storyboard_proposal_items
         WHERE project_id = $1 AND proposal_id = $2 AND frozen_payload IS NOT NULL
         ORDER BY ordinal`, [projectId, proposalId],
      );
      return rows.map((row: any): FrozenShotCreate => ({
        itemId: row.item_id,
        commandId: row.command_id,
        payload: row.frozen_payload as ShotCreateCommand,
        payloadHash: row.frozen_payload_hash,
        actorId: row.command_actor_id,
        actorKind: row.command_actor_kind,
      }));
    },

    async accept(input: StoryboardAcceptInput) {
      // One statement: revision/status CAS, per-item freeze, and proposal transition. A second
      // concurrent accept finds `target` empty and writes nothing at all.
      const { rows } = await sql.query(`WITH target AS (
          SELECT 1 FROM flume.storyboard_proposals
          WHERE project_id = $1 AND id = $2 AND status = 'draft' AND revision = $3 AND cancel_requested = false
          FOR UPDATE
        ), frozen AS (
          UPDATE flume.storyboard_proposal_items i
          SET command_id = f.command_id, frozen_payload = f.payload, frozen_payload_hash = f.payload_hash,
              command_actor_id = $4, command_actor_kind = $5, state = 'pending',
              updated_at = clock_timestamp()
          FROM jsonb_to_recordset($6::jsonb) AS f(
            item_id uuid, command_id uuid, payload jsonb, payload_hash text)
          WHERE EXISTS (SELECT 1 FROM target)
            AND i.project_id = $1 AND i.proposal_id = $2 AND i.item_id = f.item_id
            AND i.frozen_payload IS NULL
          RETURNING i.item_id
        ), accepted AS (
          UPDATE flume.storyboard_proposals p
          SET status = 'applying', accepted_by = $4, accepted_by_kind = $5,
              accepted_at = clock_timestamp(), failure = NULL, updated_at = clock_timestamp()
          WHERE p.project_id = $1 AND p.id = $2 AND EXISTS (SELECT 1 FROM target)
            AND (SELECT count(*) FROM frozen)
              = (SELECT count(*) FROM flume.storyboard_proposal_items i2
                 WHERE i2.project_id = $1 AND i2.proposal_id = $2)
          RETURNING p.id
        )
        SELECT (SELECT count(*) FROM frozen) AS frozen_count, (SELECT count(*) FROM accepted) AS accepted_count`, [
        input.projectId, input.proposalId, input.expectedRevision, input.acceptedBy, input.acceptedByKind,
        JSON.stringify(input.commands.map(command => ({
          item_id: command.itemId, command_id: command.commandId,
          payload: command.payload, payload_hash: command.payloadHash,
        }))),
      ]);
      if (num(rows[0]?.accepted_count) !== 1) return null;
      return read(input.projectId, input.proposalId);
    },

    async requestCancel(projectId, proposalId) {
      const { rows } = await sql.query(
        `UPDATE flume.storyboard_proposals
         SET cancel_requested = true,
             status = CASE WHEN status = 'draft' THEN 'cancelled' ELSE status END,
             updated_at = clock_timestamp()
         WHERE project_id = $1 AND id = $2 AND status <> 'applied'
         RETURNING id`, [projectId, proposalId],
      );
      if (!rows[0]) return null;
      return read(projectId, proposalId);
    },

    async claimItem(input: { projectId: string; proposalId: string; itemId: string; allowFailed: boolean; lease: AuthoringLease }) {
      const states = input.allowFailed ? ['pending', 'failed', 'unknown'] : ['pending', 'unknown'];
      const { rowCount } = await sql.query(
        `UPDATE flume.storyboard_proposal_items i
         SET state = 'issued', issued_fence = $5, updated_at = clock_timestamp()
         WHERE i.project_id = $1 AND i.proposal_id = $2 AND i.item_id = $3
           AND i.state = ANY($4::text[])
           AND i.command_id IS NOT NULL AND i.frozen_payload IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM flume.storyboard_proposals p
                           WHERE p.project_id = $1 AND p.id = $2
                             AND (p.cancel_requested OR p.status IN ('cancelled', 'applied')))
           AND ${LEASE_GUARD('$1', '$6', '$7', '$5')}`,
        [input.projectId, input.proposalId, input.itemId, states, input.lease.fence,
          input.proposalId.toLowerCase(), input.lease.ownerToken],
      );
      return rowCount === 1;
    },

    async settleItem(input: StoryboardItemSettlement) {
      const { rowCount } = await sql.query(
        `UPDATE flume.storyboard_proposal_items i
         SET state = $3, shot_id = $4::uuid, code = $5, updated_at = clock_timestamp()
         WHERE i.project_id = $1 AND i.proposal_id = $2 AND i.item_id = $6
           AND i.state = 'issued' AND i.issued_fence = $7
           AND ${LEASE_GUARD('$1', '$8', '$9', '$7')}`,
        [input.projectId, input.proposalId, input.state, input.shotId, input.code, input.itemId,
          input.lease.fence, input.proposalId.toLowerCase(), input.lease.ownerToken],
      );
      return rowCount === 1;
    },

    async finish(input: { projectId: string; proposalId: string; status: ProposalStatus; failure: StoryboardProposal['failure']; lease: AuthoringLease }) {
      const { rows } = await sql.query(
        `UPDATE flume.storyboard_proposals p
         SET status = $3, failure = $4::jsonb, updated_at = clock_timestamp()
         WHERE p.project_id = $1 AND p.id = $2
           AND ${LEASE_GUARD('$1', '$5', '$6', '$7')}
         RETURNING p.id`,
        [input.projectId, input.proposalId, input.status,
          input.failure === null ? null : JSON.stringify(input.failure),
          input.proposalId.toLowerCase(), input.lease.ownerToken, input.lease.fence],
      );
      if (!rows[0]) return null;
      return read(input.projectId, input.proposalId);
    },
  };
}
