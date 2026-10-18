CREATE TABLE flume.reviews (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, shot_id uuid NOT NULL, shot_revision integer NOT NULL,
 request_hash text NOT NULL, snapshot jsonb NOT NULL, envelope jsonb,
 estimated_cost_usd numeric(18,6) CHECK(estimated_cost_usd>=0), blockers jsonb NOT NULL,
 consumed_attempt_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,shot_id) REFERENCES flume.shots(project_id,id), UNIQUE(project_id,id)
);
CREATE TABLE flume.approvals (
 review_id uuid PRIMARY KEY REFERENCES flume.reviews(id), actor_id uuid NOT NULL,
 max_attempts integer NOT NULL CHECK(max_attempts>0), max_cost_usd numeric(18,6) CHECK(max_cost_usd>=0),
 reserved_count integer NOT NULL DEFAULT 0 CHECK(reserved_count>=0 AND reserved_count<=max_attempts),
 reserved_cost_usd numeric(18,6) NOT NULL DEFAULT 0 CHECK(reserved_cost_usd>=0),
 expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 CHECK(max_cost_usd IS NULL OR reserved_cost_usd<=max_cost_usd)
);
CREATE TABLE flume.attempts (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, shot_id uuid NOT NULL, shot_revision integer NOT NULL,
 review_id uuid NOT NULL UNIQUE REFERENCES flume.reviews(id), actor_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','retrieving','ready','blocked','failed','acceptance_unknown')),
 provider_job_id text, provider_receipt jsonb, error_code text, message text,
 dispatch_state text NOT NULL DEFAULT 'not_started' CHECK(dispatch_state IN ('not_started','intent','accepted')),
 owner_id uuid, fence integer NOT NULL DEFAULT 0, lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,shot_id) REFERENCES flume.shots(project_id,id), UNIQUE(project_id,shot_id,id)
);
ALTER TABLE flume.reviews ADD CONSTRAINT review_consumed_fk FOREIGN KEY(consumed_attempt_id) REFERENCES flume.attempts(id);
CREATE TABLE flume.reservations (
 attempt_id uuid PRIMARY KEY REFERENCES flume.attempts(id), review_id uuid NOT NULL REFERENCES flume.approvals(review_id),
 amount_usd numeric(18,6), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE flume.outbox (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('generation','resume','export')),
 resource_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES flume.projects(id),
 payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')),
 owner_id uuid, fence integer NOT NULL DEFAULT 0, lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX outbox_pending ON flume.outbox(state,created_at);
CREATE INDEX attempts_project ON flume.attempts(project_id);
