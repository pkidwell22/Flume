# Flume caller-parity experiment

Refs #6. A disposable vertical workflow, not product scaffolding or a new agent runtime.

## What is joined

- `service.ts` is the **only command service**. The plain human UI and deterministic headless HTTP client both call `POST /commands` with strict Zod commands. Neither supplies project/actor identity, role, grant IDs, approved booleans, routes, file paths, or URLs.
- The default HTTP/service API requires server-issued opaque fixture credentials, resolved to PostgreSQL membership and capabilities. Unknown/foreign/expired supplied credentials cannot access the workspace. Human review is a distinct server capability; both adapters face the same command predicates, not identical privileges. These one-hour credentials are **fixture issuance, not production authentication**.
- **Only `demo.ts` opts into `trusted-local-fixture-review`.** Credential-free requests at its loopback origin use a process-local handle for the existing fixed fixture reviewer. The browser opens directly into the workflow, with no key, login, secret URL or session file. The handle lasts for the owned demo even after its protected human session expires; it neither renews supplied credentials nor creates identities, grants or reservations. Explicit bearer/cookie credentials still resolve normally, and invalid/malformed/duplicate Authorization never falls back to reviewer. This is **not an authentication barrier against local processes and does not prove human identity**. Host/Origin/CSP restrictions remain; a local process can supply those headers. Do not use this convenience mode as production authentication.
- Unchanged experiment 01 owns acceptance, count-only reservation, pg-boss dispatch, fresh authorization checks, activation/epoch fencing, immutable byte intake and recovery. An additive trigger inserts the recovery lifecycle inside the original acceptance transaction. Workers connect with `initialize:false`.
- Unchanged experiment 02 generates/inspects only its owned `cfr`/`vfr` IDs. Its measured last VFR frame becomes the next first input; CFR first becomes the end input. Source file hash, stream, timebase, PTS, source/relative times, range, RGB hash, PNG hash and roles remain distinct. Local diagnostic paths are replaced with logical artifact IDs before freezing; measured identities are not rewritten.
- The local HTTP provider serves **real, six-frame H.264 MP4 fixture derivatives**. It does not run a model, respond visually to the prompt, or guarantee the supplied first/end images appear at generated endpoints. The measured files fit the existing 4096-byte intake, so **no engine, schema, contract, old test, lockfile or intake limit in 01/02 changes**. The internal `.simulation` extension is retained by the unchanged store; serving an MP4 requires its catalog hash and actual FFprobe/full decode checks. The 53-byte R1 text fixtures are never served as video.

## Workflow and invariants

1. Inspect the prebuilt owned first-look clip, then explicitly approve its exact artifact + current plan. Approval is separate from inspection. An imported take can become the review candidate after editing to a new plan revision.
2. Approval issues server-scoped, expiring grants for the two registered fixture actors. One shared review can be consumed only once; only the unchanged acceptance transaction reserves its allowance. Repeating approval for the same draft is rejected. There is no upload, live route, transfer or monetary-spending capability.
3. Submit with a command UUID and expected draft revision. Human edits revoke dependent grants and make new stale writes/submissions conflict. An exact accepted replay by the original principal returns its immutable receipt even after an edit; reusing that ID with a different revision/intent conflicts. Overlapping identical HTTP submissions share one pending worker-start decision; completed receipt replays launch no new worker. Saving preserves text typed while the POST or subsequent GET is in flight, and advances the editor base only to the successful save's revision. Newer text remains unsaved and cannot be approved; a lost response does not establish whether the write committed.
4. Inspect received bytes, then explicitly select a take with an actor-bound inspection and expected selection revision. Arrival and inspection do not select anything. The UI deliberately uses an explicit refresh rather than background polling.
5. `recover` reactivates the original pg-boss job. HTTP serializes the validated stop/reactivate/read/start operation after any pending replay decision: an older `isQueued=false` cannot consume recovery intent. A worker started since the overlapping requests arrived satisfies their shared recovery generation, including requests arriving before the first command returns; they do not kill or invalidate that new activation. The UUID is validated **before** deriving a lowercase internal coordination key, matching PostgreSQL's canonical ID while preserving early arrival-generation capture. Valid uppercase/mixed-case IDs share that key; the literal command still reaches the common service guards unchanged. Malformed identifiers are rejected, never trimmed or repaired. An older owned worker is stopped **before** fail/retry. Actual SIGKILL at intent, after the provider reply or after durable bytes resumes the same attempt/key/remote identity without another command. Recovery never creates a new attempt, grant, allowance or implicit reroll. The local fixture provider stays alive during these worker interruption tests; provider-process/database disaster recovery is not claimed.
6. Export freezes draft revision, selection revision, take identity/hash, original request and continuity in a PostgreSQL snapshot protected by a trigger. Actual FFmpeg stream copy reads frozen bytes. Later edits/selections mark the export stale without rewriting its inputs. This experiment does not implement interrupted-export restart.

The service awaits each complete operation, holding its per-shot advisory lock and checked-out client through COMMIT or ROLLBACK. Edit/selection updates also use SQL revision compare-and-set. It does **not** rewrite the underlying queue/lifecycle lock protocol or hold those row locks across provider I/O. All data belongs to a new, socket-only owned PostgreSQL cluster; no connection URL or shared service is used.

## Prerequisites and verification

Use the pinned Node/npm versions in `package.json`, existing PostgreSQL tools (`PG_BIN`), and existing `/opt/homebrew/bin/ffmpeg` / `ffprobe`. No global install or browser installation is required.

Set `FLUME_SCRATCH` to a short, canonical, user-owned scratch directory. Explicitly export it even for a background launch: a launcher may not inherit the foreground tool's temporary directory. Do not use a system temp directory or change the guards to accommodate one.

From this directory:

```sh
export LC_ALL=C TMPDIR="$FLUME_SCRATCH" PG_BIN=/opt/homebrew/bin
npm --prefix ../01-approved-attempt ci --ignore-scripts
npm --prefix ../02-frame-provenance ci --ignore-scripts
npm ci --ignore-scripts
npm run verify
node scripts/check-mutations.mjs
```

`verify` builds ignored declarations for 01 without changing its frozen source, regenerates owned media through 02's native Node 26 API, typechecks, and runs all **43 tests** (38 retained/adapted plus five local-review guard cases). Each database test gets a fresh owned cluster; worker subprocesses only connect. The **45 mutations** run in ignored copies and check specific failed assertions plus cluster removal: the prior 29 controls plus 16 for automatic entry, expiry, credential precedence, protected defaults, local origin/authority and legacy-file ownership. The original project-membership mutation's match string follows the parenthesized expiry predicate; its behavioral oracle is unchanged. POST- and GET-phase editor overwrites retain distinct controls. Do not run 01's compiled-code mutation suite concurrently with tests importing that compiled code. Run 04's fixture-producing `verify` before 02's underlying media tests. `LC_ALL=C` also avoids the observed native PostgreSQL startup failure with an unset/invalid locale; no system locale change is needed.

Underlying regression commands, run serially with the same explicit scratch environment:

```sh
npm --prefix ../01-approved-attempt run verify
npm --prefix ../01-approved-attempt run test:mutations
npm --prefix ../01-approved-attempt run test:recovery:mutations
npm --prefix ../02-frame-provenance run typecheck
npm --prefix ../02-frame-provenance test
```

## Start and inspect the human review surface

```sh
export LC_ALL=C TMPDIR="$FLUME_SCRATCH" PG_BIN=/opt/homebrew/bin
npm run demo
```

Wait for `READY http://127.0.0.1:PORT`. It is printed only after a successful HTTP health check. The same origin is in ignored `output/demo.json`; `GET /health` returns `{ "ready": true }`. The new cluster's data root, demo PID and postmaster PID are in that **local-only** readiness file, not the UI.

Open the origin in the existing preview/browser. **The workflow opens automatically.** No login, key entry, copy/paste or file lookup is needed, including after fixture human-session expiry. The page displays the trusted-local boundary; it does not receive a credential or cookie. Page open only reads state. Inspection, approval, submission and selection remain separate explicit commands. The CLI retains its private `output/agent-session.txt` credential. The protected-mode login exchange remains for credentialed callers/tests; no public role-switch or credential-free session-issuance endpoint was added.

Use the normal controls: save direction, inspect first look, approve, run fixture, refresh, inspect a received take, select it, freeze/export, refresh. To review an imported take for a changed plan, save the new direction and inspect that take; the first-look panel then shows that exact review candidate. JSON inspection and PNG/MP4 previews show real artifact references. No PID controls appear in the interface.

Stop the foreground demo with **Ctrl-C** (or send SIGTERM to that verified demo process). Its handler stops owned workers/HTTP services, closes the pool, verifies the owned PostgreSQL postmaster has stopped, removes its cluster and removes only its acquired agent-session/readiness/lock files. The demo test exercises this exact SIGTERM path and independently checks process death, directory absence and a closed HTTP listener. A tracked background tool process should be stopped through that tool's process handle, not a guessed PID. Do not remove `demo.lock` while a demo is alive.

Startup refuses existing agent-session/readiness files rather than overwriting them. A legacy `human-session.txt` is neither read, written nor removed and does not block startup. Cleanup registers file removal only after exclusive acquisition succeeds: an EEXIST failure preserves pre-existing files while stopping this startup's new cluster/listeners and removing only its acquired process files. Never delete another running demo's lock or keys to make startup succeed.

Prepared fixture examples remain in ignored `output/take-0.mp4`, `output/take-1.mp4`, `output/catalog.json`; imported and exported media in the ephemeral cluster root are intentionally removed on cleanup. Never commit those files or session keys.

## Headless client

```sh
ORIGIN="$(node -p 'JSON.parse(require("fs").readFileSync("output/demo.json","utf8")).origin')"
node agent.ts "$ORIGIN" output/agent-session.txt read
node agent.ts "$ORIGIN" output/agent-session.txt command.json
```

A caller-owned JSON command file, for example:

```json
{"type":"edit","revision":1,"prompt":"Continue from the measured cyan tail frame."}
```

Commands are `edit`, `inspect`, `approve`, `submit`, `recover`, `select`, `export`; read `service.ts` for their strict schemas. `approve` is rejected for the agent identity even with forged role headers/model approval JSON. This is a small HTTP/CLI adapter, **not MCP**.

## Evidence boundaries

See [EVIDENCE.md](EVIDENCE.md). Separate claims:

- **Caller parity / authorization / revisions:** actual HTTP cookie and bearer requests, actual CLI subprocess, real PostgreSQL readbacks, negative controls.
- **Interruption:** actual OS worker SIGKILL and same-record recovery through the unchanged engine.
- **Media:** actual owned source extraction, full MP4 decode, FFprobe, content hashes and real FFmpeg export with a deterministic live-process/input barrier.
- **UI logic:** actual demo HTML/JavaScript in a DOM test against real HTTP, including automatic entry, forced session expiry, first-look inspection/approval and cleanup; the editor workflow also runs without injected credentials. This is not a browser rendering or playback test. Independent visual interaction in the existing preview remains a parent-review gate, but no human login handoff is needed.
- **LLM usability:** not evaluated. No new live model/provider call, benchmarking, private upload or spending occurred.
