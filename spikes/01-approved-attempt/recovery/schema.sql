CREATE SCHEMA recovery;
CREATE TABLE recovery.lifecycle (
  attempt_id uuid PRIMARY KEY REFERENCES spike.attempts(id),
  epoch integer NOT NULL DEFAULT 0, owner uuid,
  remote_id uuid, remote_state text NOT NULL DEFAULT 'not_dispatched',
  available boolean NOT NULL DEFAULT false, hold text,
  paused boolean NOT NULL DEFAULT false, cancel_requested boolean NOT NULL DEFAULT false,
  cancellation text NOT NULL DEFAULT 'none', submit_count integer NOT NULL DEFAULT 0 CHECK (submit_count BETWEEN 0 AND 2)
);
CREATE TABLE recovery.dispatch (
  attempt_id uuid PRIMARY KEY REFERENCES spike.attempts(id), key uuid UNIQUE NOT NULL,
  origin text NOT NULL, account uuid NOT NULL, route text NOT NULL, adapter text NOT NULL,
  body text NOT NULL, replay_until timestamptz NOT NULL, replay_safe boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER frozen_dispatch BEFORE UPDATE OR DELETE ON recovery.dispatch
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_record();
CREATE TABLE recovery.observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES spike.attempts(id),
  epoch integer NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER frozen_observation BEFORE UPDATE OR DELETE ON recovery.observations
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_record();
CREATE TABLE recovery.deliveries (
  owner uuid PRIMARY KEY, job_id uuid NOT NULL, attempt_id uuid NOT NULL REFERENCES spike.attempts(id),
  epoch integer NOT NULL, outcome text
);
CREATE TABLE recovery.imports (
  attempt_id uuid NOT NULL REFERENCES spike.attempts(id), remote_id uuid NOT NULL,
  output_id text NOT NULL, sha256 text NOT NULL, size integer NOT NULL,
  published boolean NOT NULL DEFAULT false, PRIMARY KEY (attempt_id, output_id)
);
CREATE TABLE recovery.takes (
  id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES spike.attempts(id), remote_id uuid NOT NULL,
  output_id text NOT NULL, sha256 text NOT NULL, UNIQUE (attempt_id, output_id),
  FOREIGN KEY (attempt_id, output_id) REFERENCES recovery.imports(attempt_id, output_id)
);
CREATE TRIGGER frozen_take BEFORE UPDATE OR DELETE ON recovery.takes
  FOR EACH ROW EXECUTE FUNCTION spike.freeze_record();
-- Editorial sentinel: workers have no write path to this independent record.
CREATE TABLE recovery.selections (shot_id uuid PRIMARY KEY REFERENCES spike.drafts(id), selected text NOT NULL);
