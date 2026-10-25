-- 011_authoring_journals.sql — durable storyboard proposal application and continue-shot journal.
-- Authored by the durable worker; NOT applied. The coordinator owns migration execution.
-- Additive only: new tables/indexes/triggers; no changes to existing tables.
--
-- Crash-safety model (see apps/server/src/authoring-operation-lock.ts and agent-reports/durable-integration.md):
--  * one row in flume.authoring_operation_leases per operation supplies cross-process ownership:
--    owner token + monotonically increasing fence + lease_expires_at;
--  * every journal mutation carries the fence of the lease that authorised it, so a process whose
--    lease expired (or was stolen after expiry) cannot write, even if its callback is still running;
--  * deterministic command ids + flume.command_receipts(actor_id, command_id) make a re-issued
--    command replay the original receipt instead of creating a second resource. Receipts are
--    actor-scoped, so the actor identity that will issue the command is frozen at acceptance.

-- ---------------------------------------------------------------------------------------------
-- Storyboard proposals. Identity/review columns are frozen when acceptance transitions the row.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE flume.storyboard_proposals (
  project_id uuid NOT NULL REFERENCES flume.projects(id),
  id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','applying','applied','partial','unknown','cancelled')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  bounds jsonb NOT NULL CHECK (jsonb_typeof(bounds) = 'object'),
  failure jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  planner_model_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  proposed_by uuid NOT NULL,
  proposed_by_kind text NOT NULL CHECK (proposed_by_kind IN ('operator','agent')),
  accepted_by uuid,
  accepted_by_kind text CHECK (accepted_by_kind IS NULL OR accepted_by_kind IN ('operator','agent')),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, id)
);
CREATE INDEX storyboard_proposals_project ON flume.storyboard_proposals(project_id, created_at);

CREATE TABLE flume.storyboard_proposal_items (
  project_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  item_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  direction text NOT NULL CHECK (char_length(direction) BETWEEN 1 AND 2000),
  start_description text NOT NULL CHECK (char_length(start_description) BETWEEN 1 AND 2000),
  end_description text NOT NULL CHECK (char_length(end_description) BETWEEN 1 AND 2000),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 60),
  continuity_notes text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('pending','issued','created','failed','unknown')),
  shot_id uuid,
  command_id uuid,
  -- Exact shot.create payload and the actor that will issue it, frozen at acceptance. Immutable
  -- once set (trigger below); a resume sends these bytes, never a reconstruction from live text.
  frozen_payload jsonb,
  frozen_payload_hash text CHECK (frozen_payload_hash IS NULL OR frozen_payload_hash ~ '^[0-9a-f]{64}$'),
  command_actor_id uuid,
  command_actor_kind text CHECK (command_actor_kind IS NULL OR command_actor_kind IN ('operator','agent')),
  issued_fence integer,
  code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, proposal_id, item_id),
  -- One command id can only ever be owned by one cut in one proposal of one project.
  UNIQUE (project_id, proposal_id, command_id),
  FOREIGN KEY (project_id, proposal_id) REFERENCES flume.storyboard_proposals(project_id, id),
  FOREIGN KEY (project_id, shot_id) REFERENCES flume.shots(project_id, id)
);
CREATE INDEX storyboard_proposal_items_proposal ON flume.storyboard_proposal_items(project_id, proposal_id, ordinal);

CREATE FUNCTION flume.storyboard_proposal_items_frozen_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.frozen_payload IS NOT NULL AND (
       NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.start_description IS DISTINCT FROM OLD.start_description
    OR NEW.end_description IS DISTINCT FROM OLD.end_description
    OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
    OR NEW.continuity_notes IS DISTINCT FROM OLD.continuity_notes
    OR NEW.command_id IS DISTINCT FROM OLD.command_id
    OR NEW.frozen_payload IS DISTINCT FROM OLD.frozen_payload
    OR NEW.frozen_payload_hash IS DISTINCT FROM OLD.frozen_payload_hash
    OR NEW.command_actor_id IS DISTINCT FROM OLD.command_actor_id
    OR NEW.command_actor_kind IS DISTINCT FROM OLD.command_actor_kind
  ) THEN
    RAISE EXCEPTION 'STORYBOARD_COMMAND_FROZEN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storyboard_proposal_items_frozen_immutable
  BEFORE UPDATE ON flume.storyboard_proposal_items
  FOR EACH ROW EXECUTE FUNCTION flume.storyboard_proposal_items_frozen_immutable();

-- Proposal-level identity (projecting actor, planner, reviewed bounds) is immutable too. Lifecycle
-- columns remain writable; revision may only move forward.
CREATE FUNCTION flume.storyboard_proposals_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.bounds IS DISTINCT FROM OLD.bounds
     OR NEW.planner_model_id IS DISTINCT FROM OLD.planner_model_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.proposed_by_kind IS DISTINCT FROM OLD.proposed_by_kind
     OR NEW.revision < OLD.revision
     OR (OLD.accepted_by IS NOT NULL AND NEW.accepted_by IS DISTINCT FROM OLD.accepted_by)
     OR (OLD.accepted_by_kind IS NOT NULL AND NEW.accepted_by_kind IS DISTINCT FROM OLD.accepted_by_kind)
     OR (OLD.status <> 'draft' AND NEW.status = 'draft')
  THEN
    RAISE EXCEPTION 'STORYBOARD_PROPOSAL_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storyboard_proposals_identity_immutable
  BEFORE UPDATE ON flume.storyboard_proposals
  FOR EACH ROW EXECUTE FUNCTION flume.storyboard_proposals_identity_immutable();

-- ---------------------------------------------------------------------------------------------
-- Durable operation ownership. One row per operation; safety comes from the fence, not the clock.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE flume.authoring_operation_leases (
  scope text NOT NULL CHECK (scope IN ('storyboard.apply','continue-shot')),
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 1 AND 200),
  project_id uuid NOT NULL REFERENCES flume.projects(id),
  owner_token uuid NOT NULL,
  fence integer NOT NULL CHECK (fence > 0),
  lease_expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  PRIMARY KEY (scope, operation_id)
);

-- ---------------------------------------------------------------------------------------------
-- Continue-shot journal. Intent, extraction dispatch and the exact command payloads are frozen.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE flume.continue_shot_journal (
  operation_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES flume.projects(id),
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('operator','agent')),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  source_take_id uuid NOT NULL,
  source_shot_id uuid NOT NULL,
  source_asset_id uuid NOT NULL,
  source_asset_sha256 text NOT NULL CHECK (source_asset_sha256 ~ '^[0-9a-f]{64}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 100000),
  status text NOT NULL CHECK (status IN (
    'pending','extracting','extracted','creating','created','binding','completed','blocked',
    'extraction_unknown'
  )),
  -- True from the moment the media port is invoked. If the process dies while this is true and no
  -- derived frame is visible on readback, the outcome is IRRECONCILABLE, not "safe to retry".
  extraction_dispatched boolean NOT NULL DEFAULT false,
  extracted_asset_id uuid,
  shot_id uuid,
  shot_revision integer CHECK (shot_revision IS NULL OR shot_revision > 0),
  create_payload jsonb,
  create_payload_hash text CHECK (create_payload_hash IS NULL OR create_payload_hash ~ '^[0-9a-f]{64}$'),
  bind_payload jsonb,
  bind_payload_hash text CHECK (bind_payload_hash IS NULL OR bind_payload_hash ~ '^[0-9a-f]{64}$'),
  command_actor_id uuid,
  command_actor_kind text CHECK (command_actor_kind IS NULL OR command_actor_kind IN ('operator','agent')),
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blockers) = 'array'),
  message text,
  resumable boolean NOT NULL DEFAULT true,
  owner_token uuid,
  fence integer NOT NULL DEFAULT 0 CHECK (fence >= 0),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (source_take_id) REFERENCES flume.takes(id),
  FOREIGN KEY (project_id, source_shot_id) REFERENCES flume.shots(project_id, id),
  FOREIGN KEY (project_id, source_asset_id) REFERENCES flume.assets(project_id, id),
  FOREIGN KEY (project_id, extracted_asset_id) REFERENCES flume.assets(project_id, id),
  FOREIGN KEY (project_id, shot_id) REFERENCES flume.shots(project_id, id)
);
CREATE INDEX continue_shot_journal_project ON flume.continue_shot_journal(project_id, created_at);

CREATE FUNCTION flume.continue_shot_journal_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
     OR NEW.intent_hash IS DISTINCT FROM OLD.intent_hash
     OR NEW.source_take_id IS DISTINCT FROM OLD.source_take_id
     OR NEW.source_shot_id IS DISTINCT FROM OLD.source_shot_id
     OR NEW.source_asset_id IS DISTINCT FROM OLD.source_asset_id
     OR NEW.source_asset_sha256 IS DISTINCT FROM OLD.source_asset_sha256
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.prompt IS DISTINCT FROM OLD.prompt
     OR (OLD.create_payload IS NOT NULL AND NEW.create_payload IS DISTINCT FROM OLD.create_payload)
     OR (OLD.create_payload_hash IS NOT NULL AND NEW.create_payload_hash IS DISTINCT FROM OLD.create_payload_hash)
     OR (OLD.bind_payload IS NOT NULL AND NEW.bind_payload IS DISTINCT FROM OLD.bind_payload)
     OR (OLD.bind_payload_hash IS NOT NULL AND NEW.bind_payload_hash IS DISTINCT FROM OLD.bind_payload_hash)
     OR (OLD.command_actor_id IS NOT NULL AND NEW.command_actor_id IS DISTINCT FROM OLD.command_actor_id)
     OR (OLD.command_actor_kind IS NOT NULL AND NEW.command_actor_kind IS DISTINCT FROM OLD.command_actor_kind)
     OR (OLD.shot_id IS NOT NULL AND NEW.shot_id IS DISTINCT FROM OLD.shot_id)
     OR (OLD.extracted_asset_id IS NOT NULL AND NEW.extracted_asset_id IS DISTINCT FROM OLD.extracted_asset_id)
  THEN
    RAISE EXCEPTION 'CONTINUE_SHOT_JOURNAL_INTENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER continue_shot_journal_intent_immutable
  BEFORE UPDATE ON flume.continue_shot_journal
  FOR EACH ROW EXECUTE FUNCTION flume.continue_shot_journal_intent_immutable();
