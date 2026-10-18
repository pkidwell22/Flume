CREATE TABLE flume.projects (
  id uuid PRIMARY KEY, name text NOT NULL, brief text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE flume.command_receipts (
  actor_id uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL,
  project_id uuid NOT NULL REFERENCES flume.projects(id), receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id, command_id)
);
