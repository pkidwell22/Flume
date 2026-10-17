CREATE SCHEMA parity;
CREATE TABLE parity.sessions (
  token_hash text PRIMARY KEY, actor_id uuid NOT NULL, project_id uuid NOT NULL,
  can_review boolean NOT NULL, expires_at timestamptz NOT NULL
);
-- Acceptance and lifecycle become durable in the SAME original transaction.
CREATE FUNCTION parity.start_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO recovery.lifecycle(attempt_id) VALUES (NEW.id); RETURN NEW; END $$;
CREATE TRIGGER accepted_lifecycle AFTER INSERT ON spike.attempts
  FOR EACH ROW EXECUTE FUNCTION parity.start_lifecycle();
CREATE TABLE parity.inspections (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL, shot_id uuid NOT NULL REFERENCES spike.drafts(id),
  plan_hash text NOT NULL, artifact text NOT NULL, sha256 text NOT NULL, probe jsonb NOT NULL
);
CREATE TRIGGER frozen_inspection BEFORE UPDATE OR DELETE ON parity.inspections
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_record();
CREATE TABLE parity.approvals (
  review_id uuid PRIMARY KEY REFERENCES spike.reviews(id), inspection_id uuid NOT NULL REFERENCES parity.inspections(id),
  approving_actor uuid NOT NULL
);
CREATE TRIGGER frozen_approval BEFORE UPDATE OR DELETE ON parity.approvals
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_record();
CREATE TABLE parity.exports (
  id uuid PRIMARY KEY, shot_id uuid NOT NULL REFERENCES spike.drafts(id),
  revision integer NOT NULL, selection_revision integer NOT NULL,
  snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','complete','failed')),
  stale boolean NOT NULL, output_sha256 text
);
CREATE FUNCTION parity.freeze_export() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (to_jsonb(NEW)-'status'-'stale'-'output_sha256') IS DISTINCT FROM
    (to_jsonb(OLD)-'status'-'stale'-'output_sha256')
  THEN RAISE EXCEPTION 'IMMUTABLE_EXPORT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frozen_export BEFORE UPDATE OR DELETE ON parity.exports
  FOR EACH ROW EXECUTE FUNCTION parity.freeze_export();
CREATE TABLE parity.plans (
  shot_id uuid PRIMARY KEY REFERENCES spike.drafts(id), continuity jsonb NOT NULL,
  selected_take uuid REFERENCES recovery.takes(id), selection_revision integer NOT NULL DEFAULT 0
);
