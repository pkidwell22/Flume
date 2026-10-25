/**
 * Durable PostgreSQL adapter for the frame-authoring store port.
 *
 * Requires migration 010_frame_authoring.sql (present, NOT applied by this lane). The supplied
 * executor may be a PoolClient checked out by the caller's transaction; each method is a single
 * atomic statement so it is safe with a Pool as well. Review identity columns are insert-only and
 * additionally protected by a database trigger in the migration.
 *
 * Bind and import claims are expressed as one statement each so "no rows" can only mean "nothing
 * happened"; the import claim row is the durable record that authorizes the single owned-media
 * write for a review.
 */
import type {
  FrameAuthoringStore, FrameBindings, FrameImportClaim, FrameOwnedAsset, FrameResultRow, FrameResultView,
  FrameReviewRecord, FrameReviewStatus, FrameShotSnapshot, FrameTransitionPatch,
} from './frame-authoring.ts';

export interface FrameSqlExecutor {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const num = (value: unknown): number => typeof value === 'number' ? value : Number(value);
const optionalNumber = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

function reviewFromRow(row: any): FrameReviewRecord {
  return {
    reviewId: row.id, projectId: row.project_id, shotId: row.shot_id, expectedRevision: num(row.shot_revision),
    role: row.role, prompt: row.prompt, modelId: row.model_id, aspectRatio: row.aspect_ratio,
    sourceAssetId: row.source_asset_id ?? null, sourceAssetSha256: row.source_asset_sha256 ?? null,
    requestHash: row.request_hash, status: row.status, blockers: Array.isArray(row.blockers) ? row.blockers : [],
    estimateUsd: optionalNumber(row.estimate_usd), envelope: row.envelope ?? null,
    createdBy: row.created_by, createdByKind: row.created_by_kind, approvedBy: row.approved_by ?? null,
    approvedMaxCostUsd: optionalNumber(row.approved_max_cost_usd),
    resultAssetId: row.result_asset_id ?? null, output: row.output ?? null,
    providerModelId: row.provider_model_id ?? null, providerReceiptId: row.provider_receipt_id ?? null,
    errorCode: row.error_code ?? null,
  };
}

const PATCH_COLUMNS: Record<keyof FrameTransitionPatch, string> = {
  approvedBy: 'approved_by', approvedMaxCostUsd: 'approved_max_cost_usd',
  errorCode: 'error_code', output: 'output',
  providerModelId: 'provider_model_id', providerReceiptId: 'provider_receipt_id', resultAssetId: 'result_asset_id',
};

export function createSqlFrameAuthoringStore(sql: FrameSqlExecutor): FrameAuthoringStore {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A SQL executor with query(text, params) is required.');

  const readResult = async (projectId: string, reviewId: string): Promise<FrameResultView | null> => {
    const { rows } = await sql.query(
      'SELECT asset_id, project_id, review_id, mime_type, width, height, sha256 FROM flume.frame_results WHERE project_id = $1 AND review_id = $2',
      [projectId, reviewId],
    );
    const row = rows[0];
    return row ? { assetId: row.asset_id, projectId: row.project_id, reviewId: row.review_id, mimeType: row.mime_type, width: num(row.width), height: num(row.height), sha256: row.sha256 } : null;
  };

  return {
    async getShot(projectId: string, shotId: string): Promise<FrameShotSnapshot | null> {
      const { rows } = await sql.query(
        'SELECT id, revision, bindings FROM flume.shots WHERE project_id = $1 AND id = $2', [projectId, shotId],
      );
      const row = rows[0];
      if (!row) return null;
      const bindings = row.bindings ?? {};
      return { id: row.id, revision: num(row.revision), bindings: {
        firstFrameAssetId: bindings.firstFrameAssetId ?? null, lastFrameAssetId: bindings.lastFrameAssetId ?? null,
      } };
    },

    async getAsset(projectId: string, assetId: string): Promise<FrameOwnedAsset | null> {
      const { rows } = await sql.query(
        'SELECT id, project_id, kind, sha256, mime_type, byte_size FROM flume.assets WHERE project_id = $1 AND id = $2',
        [projectId, assetId],
      );
      const row = rows[0];
      return row ? { id: row.id, projectId: row.project_id, kind: row.kind, sha256: row.sha256, mimeType: row.mime_type, byteSize: num(row.byte_size) } : null;
    },

    async insertReview(record: FrameReviewRecord): Promise<void> {
      await sql.query(`INSERT INTO flume.frame_reviews (
        id, project_id, shot_id, shot_revision, role, prompt, model_id, aspect_ratio, source_asset_id,
        source_asset_sha256, request_hash, status, blockers, estimate_usd, envelope, created_by,
        created_by_kind, approved_by, approved_max_cost_usd, result_asset_id, output, provider_model_id,
        provider_receipt_id, error_code
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24)`, [
        record.reviewId, record.projectId, record.shotId, record.expectedRevision, record.role, record.prompt,
        record.modelId, record.aspectRatio, record.sourceAssetId, record.sourceAssetSha256, record.requestHash,
        record.status, JSON.stringify(record.blockers), record.estimateUsd,
        record.envelope === null ? null : JSON.stringify(record.envelope), record.createdBy, record.createdByKind,
        record.approvedBy, record.approvedMaxCostUsd ?? null, record.resultAssetId,
        record.output === null ? null : JSON.stringify(record.output),
        record.providerModelId, record.providerReceiptId, record.errorCode,
      ]);
    },

    async getReview(projectId: string, reviewId: string): Promise<FrameReviewRecord | null> {
      const { rows } = await sql.query('SELECT * FROM flume.frame_reviews WHERE project_id = $1 AND id = $2', [projectId, reviewId]);
      return rows[0] ? reviewFromRow(rows[0]) : null;
    },

    async findResult(projectId: string, reviewId: string): Promise<FrameResultView | null> {
      return readResult(projectId, reviewId);
    },

    async transition({ projectId, reviewId, from, to, patch = {} }: {
      projectId: string; reviewId: string; from: FrameReviewStatus[]; to: FrameReviewStatus; patch?: FrameTransitionPatch;
    }): Promise<FrameReviewRecord | null> {
      // Whitelisted patch columns only; identity columns (prompt/model/hash/envelope) are never mutable.
      const columns: string[] = [];
      const params: unknown[] = [projectId, reviewId, to, from];
      for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof FrameTransitionPatch, string][]) {
        const value = patch[key];
        if (value === undefined) continue;
        params.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
        columns.push(`${column} = $${params.length}${key === 'output' ? '::jsonb' : ''}`);
        if (key === 'approvedBy') columns.push('approved_at = clock_timestamp()');
      }
      if (to === 'submitted') columns.push('submitted_at = clock_timestamp()');
      if (to === 'bound') columns.push('bound_at = clock_timestamp()');
      const { rows } = await sql.query(
        `UPDATE flume.frame_reviews SET status = $3, updated_at = clock_timestamp()${columns.length ? ', ' + columns.join(', ') : ''}
         WHERE project_id = $1 AND id = $2 AND status = ANY($4::text[]) RETURNING *`,
        params,
      );
      return rows[0] ? reviewFromRow(rows[0]) : null;
    },

    async insertResult(row: FrameResultRow): Promise<boolean> {
      const { rows } = await sql.query(`INSERT INTO flume.frame_results (
        id, review_id, project_id, shot_id, asset_id, mime_type, width, height, sha256, byte_size,
        provider_model_id, provider_receipt_id, imported_by
      ) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (review_id) DO NOTHING RETURNING id`, [
        row.reviewId, row.projectId, row.shotId, row.assetId, row.mimeType, row.width, row.height,
        row.sha256, row.byteSize, row.providerModelId, row.providerReceiptId, row.importedBy,
      ]);
      return rows.length === 1;
    },

    /**
     * One statement claims the import for a review. Only a row that is still `submitted`, still owned
     * by this project and still carrying this exact asset/hash intent can claim; the unique
     * review_id primary key makes a concurrent second INSERT a no-op instead of a second claim.
     */
    async claimResultImport({ projectId, reviewId, assetId, sha256, actorId }: {
      projectId: string; reviewId: string; assetId: string; sha256: string; actorId: string;
    }): Promise<FrameImportClaim> {
      const claimed = await sql.query(`INSERT INTO flume.frame_result_imports
          (review_id, project_id, asset_id, sha256, actor_id, status)
        SELECT r.id, r.project_id, $3::uuid, $4, $5::uuid, 'importing'
        FROM flume.frame_reviews r
        WHERE r.project_id = $1 AND r.id = $2 AND r.status = 'submitted'
        ON CONFLICT (review_id) DO NOTHING
        RETURNING asset_id, sha256`, [projectId, reviewId, assetId, sha256, actorId]);
      if (claimed.rows.length === 1) {
        const row = claimed.rows[0];
        if (row.asset_id !== assetId || row.sha256 !== sha256) return { status: 'unavailable', assetId: null, result: null };
        return { status: 'claimed', assetId, result: null };
      }
      // Nothing was inserted: either this exact intent already holds the claim, a different intent
      // holds it, it already completed, or the claim state is not readable yet (a concurrent
      // uncommitted claim). The last case must fail closed, never guess.
      const { rows } = await sql.query(
        'SELECT asset_id, sha256, status FROM flume.frame_result_imports WHERE project_id = $1 AND review_id = $2',
        [projectId, reviewId],
      );
      const existing = rows[0];
      if (!existing) return { status: 'unavailable', assetId: null, result: null };
      const existingAssetId = existing.asset_id as string;
      const sameIntent = existingAssetId === assetId && existing.sha256 === sha256;
      if (sameIntent && (existing.status === 'importing' || existing.status === 'imported')) {
        const result = await readResult(projectId, reviewId);
        // Same immutable identity: the caller may finish the exact write this claim already owns.
        if (result && result.assetId === existingAssetId) return { status: 'already_imported', assetId: existingAssetId, result };
        return { status: 'claimed', assetId: existingAssetId, result: null };
      }
      return { status: 'in_progress', assetId: existingAssetId, result: null };
    },

    async completeResultImport({ projectId, reviewId, assetId }: {
      projectId: string; reviewId: string; assetId: string;
    }): Promise<void> {
      await sql.query(`UPDATE flume.frame_result_imports SET status = 'imported', updated_at = clock_timestamp()
        WHERE project_id = $1 AND review_id = $2 AND asset_id = $3 AND status = 'importing'`,
      [projectId, reviewId, assetId]);
    },

    async bindFrame({ projectId, shotId, expectedRevision, role, assetId, reviewId, actorId }: {
      projectId: string; shotId: string; expectedRevision: number; role: 'first_frame' | 'last_frame';
      assetId: string; reviewId: string; actorId: string;
    }): Promise<{ revision: number; bindings: FrameBindings; review: FrameReviewRecord } | null> {
      const path = role === 'first_frame' ? '{firstFrameAssetId}' : '{lastFrameAssetId}';
      /**
       * One statement, and every write is gated by the same precondition:
       *  - `pre` locks the review and shot rows and requires: same project, same shot, review
       *    result_ready, review role = requested role, frozen review revision = client revision =
       *    live shot revision, and an owned image asset. `FOR UPDATE OF r, s` means a concurrent bind
       *    re-evaluates this predicate against the committed winner, so a losing CAS removes the row
       *    before any write happens instead of mutating then returning nothing.
       *  - `bound` can therefore only update the shot when the review precondition held.
       *  - `reviewed` returns the *post-update* review row; the outer SELECT reads that CTE rather
       *    than the base table, whose snapshot still shows status = 'result_ready'.
       *  - The audit row records the review's role (`$8`), never the jsonb path used for the write.
       */
      const { rows } = await sql.query(`WITH pre AS (
          SELECT r.id AS review_id, s.id AS shot_id, s.revision AS revision
          FROM flume.frame_reviews r
          JOIN flume.shots s ON s.project_id = r.project_id AND s.id = r.shot_id
          WHERE r.project_id = $1 AND r.id = $6
            AND r.status = 'result_ready'
            AND r.role = $8::text
            AND r.shot_id = $2
            AND r.shot_revision = $5
            AND s.revision = $5
            AND EXISTS (SELECT 1 FROM flume.assets a WHERE a.project_id = $1 AND a.id = $4 AND a.kind = 'image')
          FOR UPDATE OF r, s
        ), bound AS (
          UPDATE flume.shots s
          SET bindings = jsonb_set(s.bindings, $3::text[], to_jsonb($4::text), true), revision = s.revision + 1
          FROM pre
          WHERE s.project_id = $1 AND s.id = pre.shot_id AND s.revision = pre.revision
          RETURNING s.id, s.project_id, s.revision, s.bindings
        ), reviewed AS (
          UPDATE flume.frame_reviews r
          SET status = 'bound', result_asset_id = $4::uuid, bound_at = clock_timestamp(), updated_at = clock_timestamp()
          FROM bound b
          WHERE r.project_id = $1 AND r.id = $6 AND r.status = 'result_ready'
            AND r.shot_id = b.id AND r.shot_revision = $5 AND r.role = $8::text
          RETURNING r AS review_row
        ), audited AS (
          INSERT INTO flume.frame_bindings (id, project_id, shot_id, role, asset_id, review_id, revision_before, revision_after, actor_id)
          SELECT gen_random_uuid(), b.project_id, b.id, $8::text, $4::uuid, $6, b.revision - 1, b.revision, $7::uuid
          FROM bound b
          JOIN reviewed rv ON true
          RETURNING id
        )
        SELECT b.revision, b.bindings, to_jsonb(rv.review_row) AS review
        FROM bound b
        JOIN reviewed rv ON true
        WHERE EXISTS (SELECT 1 FROM audited)`,
      [projectId, shotId, path, assetId, expectedRevision, reviewId, actorId, role]);
      const row = rows[0];
      if (!row) return null;
      const bindings = row.bindings ?? {};
      return {
        revision: num(row.revision),
        bindings: { firstFrameAssetId: bindings.firstFrameAssetId ?? null, lastFrameAssetId: bindings.lastFrameAssetId ?? null },
        review: reviewFromRow(row.review),
      };
    },
  };
}
