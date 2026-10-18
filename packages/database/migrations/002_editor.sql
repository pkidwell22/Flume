CREATE TABLE flume.assets (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES flume.projects(id),
 filename text NOT NULL, kind text NOT NULL CHECK(kind IN ('image','video')),
 origin text NOT NULL CHECK(origin IN ('imported','generated','sample')),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), storage_key text NOT NULL,
 mime_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0),
 width integer NOT NULL CHECK(width>0), height integer NOT NULL CHECK(height>0),
 duration_seconds double precision CHECK(duration_seconds>0), provenance jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(project_id,id)
);
CREATE TABLE flume.shots (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES flume.projects(id),
 title text NOT NULL, prompt text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 controls jsonb NOT NULL, bindings jsonb NOT NULL,
 selected_take_id uuid, selection_revision integer NOT NULL DEFAULT 0 CHECK(selection_revision>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(project_id,id)
);
CREATE INDEX shots_project ON flume.shots(project_id);
