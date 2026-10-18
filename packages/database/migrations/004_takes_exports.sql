CREATE TABLE flume.takes (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, shot_id uuid NOT NULL, attempt_id uuid NOT NULL,
 asset_id uuid NOT NULL, remote_identity text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,shot_id,attempt_id) REFERENCES flume.attempts(project_id,shot_id,id),
 FOREIGN KEY(project_id,asset_id) REFERENCES flume.assets(project_id,id), UNIQUE(attempt_id,remote_identity), UNIQUE(project_id,shot_id,id)
);
ALTER TABLE flume.shots ADD CONSTRAINT selected_take_scope FOREIGN KEY(project_id,id,selected_take_id) REFERENCES flume.takes(project_id,shot_id,id);
CREATE TABLE flume.inspections (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL, project_id uuid NOT NULL, shot_id uuid NOT NULL,
 shot_revision integer NOT NULL, take_id uuid NOT NULL, asset_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,shot_id,take_id) REFERENCES flume.takes(project_id,shot_id,id)
);
CREATE TABLE flume.exports (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, shot_id uuid NOT NULL, take_id uuid NOT NULL,
 shot_revision integer NOT NULL, selection_revision integer NOT NULL,
 snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','failed')),
 asset_id uuid, stale boolean NOT NULL DEFAULT false, error_code text, message text,
 owner_id uuid, fence integer NOT NULL DEFAULT 0, lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,shot_id,take_id) REFERENCES flume.takes(project_id,shot_id,id),
 FOREIGN KEY(project_id,asset_id) REFERENCES flume.assets(project_id,id)
);
