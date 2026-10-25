-- 010_frame_authoring.sql — image frame authoring (draft -> review -> approval -> submit -> result -> bind).
-- Authored by the image lane; NOT applied. The coordinator owns migration execution.
-- Additive only: new tables/indexes/trigger; no changes to existing generation tables.

CREATE TABLE flume.frame_reviews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  shot_id uuid NOT NULL,
  shot_revision integer NOT NULL CHECK (shot_revision > 0),
  role text NOT NULL CHECK (role IN ('first_frame', 'last_frame')),
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 8000),
  model_id text NOT NULL CHECK (model_id ~ '^[a-z0-9][a-z0-9._-]{0,63}/[a-z0-9][a-z0-9._:-]{0,127}$'),
  aspect_ratio text NOT NULL CHECK (aspect_ratio ~ '^[0-9]{1,2}:[0-9]{1,2}$'),
  -- A source is an owned asset reference only; no URL columns exist anywhere in this schema.
  source_asset_id uuid,
  source_asset_sha256 text CHECK (source_asset_sha256 IS NULL OR source_asset_sha256 ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','blocked','approved','submitting','submitted','result_ready','bound','failed','acceptance_unknown')),
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blockers) = 'array'),
  estimate_usd numeric(18,6) CHECK (estimate_usd IS NULL OR estimate_usd >= 0),
  envelope jsonb,
  created_by uuid NOT NULL,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('operator', 'agent')),
  approved_by uuid,
  approved_at timestamptz,
  -- Operator-approved spend ceiling for this exact review. Persisted so the audit trail carries the
  -- cap that authorized the spend; the cap can never exist without a recorded approving actor.
  approved_max_cost_usd numeric(18,6) CHECK (approved_max_cost_usd IS NULL OR approved_max_cost_usd > 0),
  submitted_at timestamptz,
  provider_model_id text,
  provider_receipt_id text,
  provider_cost_usd numeric(18,6) CHECK (provider_cost_usd IS NULL OR provider_cost_usd >= 0),
  output jsonb,
  error_code text,
  result_asset_id uuid,
  bound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, shot_id) REFERENCES flume.shots(project_id, id),
  FOREIGN KEY (project_id, source_asset_id) REFERENCES flume.assets(project_id, id),
  FOREIGN KEY (project_id, result_asset_id) REFERENCES flume.assets(project_id, id),
  UNIQUE (project_id, id),
  -- A spend ceiling without an approving actor would be an unattributable authorization.
  CHECK (approved_max_cost_usd IS NULL OR approved_by IS NOT NULL)
);
CREATE INDEX frame_reviews_shot ON flume.frame_reviews(project_id, shot_id, created_at);
CREATE INDEX frame_reviews_status ON flume.frame_reviews(status);

-- Reviewed identity is immutable. Only lifecycle/approval/receipt/output columns may change.
CREATE FUNCTION flume.frame_reviews_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.shot_id IS DISTINCT FROM OLD.shot_id
     OR NEW.shot_revision IS DISTINCT FROM OLD.shot_revision
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.prompt IS DISTINCT FROM OLD.prompt
     OR NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.aspect_ratio IS DISTINCT FROM OLD.aspect_ratio
     OR NEW.source_asset_id IS DISTINCT FROM OLD.source_asset_id
     OR NEW.source_asset_sha256 IS DISTINCT FROM OLD.source_asset_sha256
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.envelope IS DISTINCT FROM OLD.envelope
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_by_kind IS DISTINCT FROM OLD.created_by_kind
  THEN
    RAISE EXCEPTION 'FRAME_REVIEW_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frame_reviews_identity_immutable
  BEFORE UPDATE ON flume.frame_reviews
  FOR EACH ROW EXECUTE FUNCTION flume.frame_reviews_identity_immutable();

-- One durable import claim per review. The claim is written before any owned-media write, so an
-- interrupted or concurrent import cannot silently create a second, unreferenced asset: only the
-- identical intent (same derived asset_id and sha256) may resume, everything else is refused.
CREATE TABLE flume.frame_result_imports (
  review_id uuid PRIMARY KEY REFERENCES flume.frame_reviews(id),
  project_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  actor_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('importing', 'imported')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX frame_result_imports_project ON flume.frame_result_imports(project_id, status);

-- Claim identity is immutable; only the completion status may advance.
CREATE FUNCTION flume.frame_result_imports_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
  THEN
    RAISE EXCEPTION 'FRAME_IMPORT_CLAIM_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frame_result_imports_identity_immutable
  BEFORE UPDATE ON flume.frame_result_imports
  FOR EACH ROW EXECUTE FUNCTION flume.frame_result_imports_identity_immutable();

CREATE TABLE flume.frame_results (
  id uuid PRIMARY KEY,
  review_id uuid NOT NULL UNIQUE REFERENCES flume.frame_reviews(id),
  project_id uuid NOT NULL,
  shot_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  provider_model_id text NOT NULL,
  provider_receipt_id text,
  imported_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, shot_id) REFERENCES flume.shots(project_id, id),
  FOREIGN KEY (project_id, asset_id) REFERENCES flume.assets(project_id, id),
  UNIQUE (project_id, asset_id)
);
CREATE INDEX frame_results_shot ON flume.frame_results(project_id, shot_id);

-- Append-only provenance for every explicit frame bind.
CREATE TABLE flume.frame_bindings (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  shot_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('first_frame', 'last_frame')),
  asset_id uuid NOT NULL,
  review_id uuid NOT NULL REFERENCES flume.frame_reviews(id),
  revision_before integer NOT NULL CHECK (revision_before > 0),
  revision_after integer NOT NULL CHECK (revision_after = revision_before + 1),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, shot_id) REFERENCES flume.shots(project_id, id),
  FOREIGN KEY (project_id, asset_id) REFERENCES flume.assets(project_id, id)
);
CREATE FUNCTION flume.frame_bindings_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FRAME_BINDINGS_APPEND_ONLY';
END $$;
CREATE TRIGGER frame_bindings_append_only
  BEFORE UPDATE OR DELETE ON flume.frame_bindings
  FOR EACH ROW EXECUTE FUNCTION flume.frame_bindings_reject_mutation();
