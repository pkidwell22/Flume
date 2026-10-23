# Docker stable and backend-development stacks

## Optional project text chat

The default stack does not load chat credentials. Enable text chat separately from media generation:

```sh
export FLUME_CHAT_API_KEY_FILE=/absolute/private/path/openrouter-key
# Also set the PostgreSQL secret file and desired loopback origins as above.
docker compose -f compose.yaml -f compose.chat.yaml up -d --build --wait
```

The secret is mounted into the server only; the private `chat_data` volume survives container replacement. Do not put a credential in Compose YAML, a command-line argument, a `VITE_*` variable or the build context. Text chat can incur provider charges only when a message or an explicit shot-edit proposal request is sent. Apply, reconcile, and dismiss do not invoke the model. This override does not enable media workers or grant generation/approval tools to chat. Opening/reading conversations does not request model inference. Configured model IDs are not a guarantee of account entitlement.

For Ollama Cloud only, use the separate overlay (which also declares the durable chat volume):

```sh
export FLUME_OLLAMA_API_KEY_FILE=/absolute/private/path/ollama-key
docker compose -f compose.yaml -f compose.ollama.yaml up -d --build --wait
```

To configure both providers, include both overlays. `compose.chat.yaml` intentionally retains the existing OpenRouter secret mount; `compose.ollama.yaml` adds Ollama without changing worker credentials. The model list exposes only models whose provider credential is configured. New conversations default to Ollama when Ollama is configured, otherwise to the first legacy OpenRouter model. Existing saved conversations remain listable/readable even if their provider is currently disabled; sending or proposing with a disabled model is rejected without fallback.

### Runtime compatibility

The Node image uses Debian Trixie so its packaged FFmpeg supports the application's `-enc_time_base demux` media inspection. Debian Bookworm's FFmpeg 5.1 rejects that option even though the application health check succeeds. Verify a real owned-image import and byte-identical download after image changes; version output and HTTP health alone are insufficient.

The internal health check uses Node HTTP with an explicit allowed Host. Do not replace it with `fetch` and assume a caller-supplied Host header is honored by the bundled Undici version.



This setup is intentionally separate from `npm run dev`. It does not import `.flume`, connect to the launcher-owned PostgreSQL instance, or mount repository source. The application image contains a built Vite frontend, the API/runtime sources and production dependencies, and `ffmpeg`/`ffprobe`.

## Boundaries

- The host publishes only `127.0.0.1:${FLUME_HOST_PORT}:8080`. PostgreSQL has no host port.
- The gateway is the only published process. It serves `apps/web/dist` and reaches the API on same-container `127.0.0.1:4311`.
- The API still uses `trustProxy:false`, exact Host/Origin allowlists, and its real loopback peer. The gateway strips `Forwarded`, every `X-Forwarded-*` header, and hop-by-hop headers. It preserves `Origin`, `Authorization`, and `X-Flume-Client`.
- An originless request remains an agent. A request declaring `X-Flume-Client: agent` remains an agent. The gateway never invents an Origin or operator identity.
- Compose-project-owned `postgres_data` and `media_data` volumes are unique per project name. Do not assign the same project name to independent backend stacks.
- The default stack has no provider secret, uses edit-only mode, does not consume generation/export queues, and reports workers unavailable. Enabling workers requires the explicit override, provider secret, and `FLUME_QUEUE_AUDITED=1`.

The fixed resource envelope is 2 CPUs/2 GiB/256 PIDs for the app and 1 CPU/1 GiB/128 PIDs for PostgreSQL. The app root filesystem is read-only; only its project-owned media volume and bounded `/tmp` tmpfs are writable. The app process runs as UID/GID 10001.

## Secrets and configuration

Create a random PostgreSQL password in an untracked local file. Do not place it in `.env`, Compose YAML, command arguments, or logs. The path is selected with `FLUME_POSTGRES_PASSWORD_FILE`; both services read the mounted file. The application rejects symlinks, empty/oversized files, and control characters.

`.env.docker.example` contains only non-secret settings. The key interfaces are:

| Setting | Default | Meaning |
|---|---:|---|
| `COMPOSE_PROJECT_NAME` | `flume-stable` | Namespace for services, network, and both writable volumes |
| `FLUME_HOST_PORT` | `4410` | Loopback-only host port |
| `FLUME_IMAGE` | `flume:stable-candidate` | Immutable image tag for the reviewed build |
| `FLUME_POSTGRES_PASSWORD_FILE` | `./secrets/postgres_password` | Untracked secret file |
| `FLUME_DEV_ORIGIN` | unset | One exact loopback Vite origin allowed to write through the stable API |

The Dockerfile pins `node:26.8.1-trixie-slim`; Compose intends to pin `postgres:18.0-bookworm`. These are source pins, not proof that Docker Desktop resolved or ran linux/arm64 variants. The coordinator must record the resolved image digests and runtime architecture after the first authorized build/up check.

## Stable candidate commands

These are operator commands; this implementation lane did not build or start containers.

```bash
DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
$DOCKER compose --env-file .env.docker -p flume-stable config
$DOCKER compose --env-file .env.docker -p flume-stable build --pull
$DOCKER image inspect flume:stable-candidate --format '{{.Id}} {{.Architecture}} {{.Os}}'
$DOCKER compose --env-file .env.docker -p flume-stable up -d
$DOCKER compose --env-file .env.docker -p flume-stable ps
curl --fail --silent --show-error http://127.0.0.1:4410/api/health
```

After the health check, verify in a browser at `http://127.0.0.1:4410`. A 200 response proves only HTTP health; it does not prove layout, media playback, worker activity, or provider availability.

Use normal `stop`/`start` for lifecycle. Do not make `down -v`, volume removal, or Docker prune part of the routine workflow.

## Independent backend feature stacks

Each backend feature stack needs a unique sanitized project name and loopback port. For example:

```bash
DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
COMPOSE_PROJECT_NAME=flume-dev-chat FLUME_HOST_PORT=4420 FLUME_IMAGE=flume:dev-chat \
  $DOCKER compose -p flume-dev-chat config
COMPOSE_PROJECT_NAME=flume-dev-chat FLUME_HOST_PORT=4420 FLUME_IMAGE=flume:dev-chat \
  $DOCKER compose -p flume-dev-chat build
COMPOSE_PROJECT_NAME=flume-dev-chat FLUME_HOST_PORT=4420 FLUME_IMAGE=flume:dev-chat \
  $DOCKER compose -p flume-dev-chat up -d
```

That project receives its own network, database cluster, queue tables, and writable media store. Never mount host `node_modules`, repository source, another stack's database directory, or another stack's writable media volume.

`compose.media-reference.yaml` is a deliberately separate, explicit inspection-only mount. It mounts an operator-named existing Docker volume read-only at `/reference-media`; the app does not consume it. It must never replace `/data/media`, because active media startup and operations require owned writable storage.

## Frontend-only development against stable data

Set the stable stack's `FLUME_DEV_ORIGIN` to the exact Vite origin before starting it, then run only the web workspace on a distinct loopback port:

```bash
# Stable Compose environment before `up`:
FLUME_DEV_ORIGIN=http://127.0.0.1:4510

# Host frontend-only process:
FLUME_API_URL=http://127.0.0.1:4410 npm run dev --workspace=@flume/web -- --host 127.0.0.1 --port 4510 --strictPort
```

**Every create, edit, selection, approval, and upload from this frontend writes the stable database and media volume. There is no sandbox or copy-on-write layer.** The Vite proxy rewrites only Host to the stable loopback target and preserves browser Origin and explicit agent intent.

For the chat lane, the browser contract remains same-origin `/api`; no container hostname or credential belongs in frontend source.

## Generation availability versus account ZDR

The default Docker stack is edit-only: a text-chat secret does not configure the video provider, and media workers remain disabled. Its generation warning reports missing generation credentials; it does not infer the account's Zero Data Retention settings.

Separately, the Hailuo 3 route has an application-local temporary-retention hold (`FLUME_H3_RETENTION_DECISION=keep-blocked` by default). This is not a live observation of the OpenRouter dashboard. An explicit `allow-temporary-retention` decision lifts only that local hold, not credential, entitlement, pricing, worker, review or approval requirements. Actual upstream `zdr-violation-by-account`, guardrail or request errors remain provider privacy errors. No account setting is changed automatically.

## Worker/provider enablement

Do not enable the worker override merely to make health green. Before using `compose.workers.yaml`, an operator must:

1. Confirm the image migration ledger exactly matches the database ledger.
2. Audit unfinished `flume.outbox`, attempts/checkpoints/receipts, and pg-boss jobs for duplicate or acceptance-unknown work.
3. Resolve or deliberately retain each pending item without silently resubmitting it.
4. Provide the provider key through an untracked Docker secret file and confirm the stable scope/retention policy.
5. Obtain separate authorization for paid calls.

Only then use both files explicitly:

```bash
$DOCKER compose -p flume-stable -f compose.yaml -f compose.workers.yaml config
$DOCKER compose -p flume-stable -f compose.yaml -f compose.workers.yaml up -d
```

## Backup, compatibility, staged cutover, and rollback

Do not point this image at the current launcher-owned store or blindly import it. This checkout contains migrations `001` through `005`. A store containing the unpublished `006` is intentionally rejected by `MIGRATION_LEDGER_MISMATCH`; it is not compatible merely because its tables look similar.

For a future authorized migration:

1. Stop the source owner normally and record its application revision.
2. Take a consistent `pg_dump` plus a permission-preserving media backup. Record backup hashes and the source migration ledger names and SHA-256 values.
3. Restore only into new staging project volumes. Never restore over stable volumes.
4. Compare the image migration files to the ledger as an exact ordered hash prefix before allowing migrations.
5. With workers disabled, verify database constraints/counts and check every referenced media record/object byte size and SHA-256. Retain all generated assets.
6. Perform read-only health/API checks and browser verification, then separately test bounded writes if authorized.
7. Switch only the loopback port/name after review. Keep the prior stack and backups untouched through the rollback window.

Rollback means stopping the candidate and restarting the untouched prior owner on its prior volumes. It does not mean reversing migrations in place, deleting candidate volumes, pruning Docker, or overwriting media.
