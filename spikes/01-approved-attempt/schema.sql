CREATE SCHEMA spike;
CREATE TABLE spike.drafts (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, revision integer NOT NULL CHECK (revision > 0), prompt text NOT NULL
);
CREATE TABLE spike.reviews (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, shot_id uuid NOT NULL REFERENCES spike.drafts(id),
  draft_revision integer NOT NULL, request jsonb NOT NULL, request_fingerprint text NOT NULL,
  consumed_attempt_id uuid UNIQUE
);
CREATE TABLE spike.grants (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, actor_id uuid NOT NULL, approving_principal uuid NOT NULL,
  route text NOT NULL, account_id uuid NOT NULL, effect text NOT NULL CHECK (effect = 'generate'),
  allowed_fingerprints jsonb NOT NULL, expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
  budget_policy text NOT NULL CHECK (budget_policy = 'count_only_unknown_cost'),
  attempt_limit integer NOT NULL CHECK (attempt_limit > 0), reserved_count integer NOT NULL DEFAULT 0,
  CHECK (reserved_count >= 0 AND reserved_count <= attempt_limit)
);
CREATE TABLE spike.attempts (
  id uuid PRIMARY KEY, review_id uuid NOT NULL UNIQUE REFERENCES spike.reviews(id),
  grant_id uuid NOT NULL REFERENCES spike.grants(id), project_id uuid NOT NULL, actor_id uuid NOT NULL,
  request jsonb NOT NULL, request_fingerprint text NOT NULL, job_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE spike.reviews ADD CONSTRAINT consumed_attempt_fk
  FOREIGN KEY (consumed_attempt_id) REFERENCES spike.attempts(id);
CREATE TABLE spike.reservations (
  attempt_id uuid PRIMARY KEY REFERENCES spike.attempts(id), grant_id uuid NOT NULL REFERENCES spike.grants(id),
  units integer NOT NULL CHECK (units = 1)
);
CREATE TABLE spike.receipts (
  project_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL,
  command_fingerprint text NOT NULL, attempt_id uuid NOT NULL UNIQUE REFERENCES spike.attempts(id),
  PRIMARY KEY (project_id, actor_id, command_id)
);

-- Frozen evidence is append-only in this experiment. Only review consumption
-- may move null -> attempt_id; later draft changes never rewrite these rows.
CREATE FUNCTION spike.freeze_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_REVIEW'; END IF;
  IF (to_jsonb(NEW) - 'consumed_attempt_id') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_attempt_id')
     OR (OLD.consumed_attempt_id IS NOT NULL AND NEW.consumed_attempt_id IS DISTINCT FROM OLD.consumed_attempt_id)
  THEN RAISE EXCEPTION 'IMMUTABLE_REVIEW'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frozen_review BEFORE UPDATE OR DELETE ON spike.reviews
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_review();
CREATE FUNCTION spike.freeze_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END $$;
CREATE TRIGGER frozen_attempt BEFORE UPDATE OR DELETE ON spike.attempts
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_record();
CREATE TRIGGER frozen_receipt BEFORE UPDATE OR DELETE ON spike.receipts
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_record();
CREATE TRIGGER frozen_reservation BEFORE UPDATE OR DELETE ON spike.reservations
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_record();
