-- Durable phase checkpoints; pg-boss jobs and command receipts share one SQL transaction.
CREATE TABLE flume.worker_checkpoints (
 attempt_id uuid PRIMARY KEY REFERENCES flume.attempts(id),
 version integer NOT NULL CHECK(version>=0), state jsonb NOT NULL
);
CREATE TABLE flume.worker_receipts (
 attempt_id uuid NOT NULL REFERENCES flume.attempts(id),
 identity_hash text NOT NULL, receipt jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(attempt_id,identity_hash)
);
ALTER TABLE flume.outbox ADD COLUMN scheduled_job_id uuid;
