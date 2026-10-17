# 01 — Approved immutable request → durable attempt + queued work

**Disposable contract experiment. Refs #3. Not application scaffolding.**

## Verdict: VALIDATED within the tested acceptance boundary

On the pinned set below, one transaction can consume a frozen review, reserve one
count allowance, persist an attempt and command receipt, and insert a real
pg-boss job. Independent connections observe either all committed facts or none.
An enqueue exception, a real PostgreSQL INSERT rejection, or pg-boss returning
`null` aborts the whole transaction. Concurrent calls do not double-consume the
review or allowance. Accepted-command replay survives later draft edits and
returns the original attempt; an unused stale review does not authorize new work.

This is **real isolated infrastructure evidence**, not a provider-generation,
worker-recovery, media-processing, authorization-UI, or whole-application result.
No job is dispatched to a provider. No model/media-provider calls are made.

## Reproduce

Prerequisites already installed on the author machine:

| Component | Exact tested version |
|---|---|
| macOS / architecture | 27.0.1 / arm64 |
| Node / npm | 26.8.1 / 11.19.0 |
| PostgreSQL | 18.6 (Homebrew binaries in `/opt/homebrew/bin`) |
| TypeScript | 5.9.3 |
| Zod | 4.3.6 |
| Drizzle ORM | 0.45.2 |
| node-postgres (`pg`) | 8.20.0 |
| pg-boss | 12.11.1 |
| `@types/node` / `@types/pg` | 26.0.0 / 8.16.0 |

Direct npm dependencies are exact pins; the lockfile pins transitive resolution.
`.node-version`, `engines`, and local `.npmrc` require the tested Node/npm pair.
This package does not install PostgreSQL or change any system service.

From the repository root:

```sh
cd spikes/01-approved-attempt
npm ci --ignore-scripts --no-fund
# Set an EXISTING, owned scratch directory. The short socket path matters.
export TMPDIR="$HOME/.hermes/cache/scratch"
export PG_BIN=/opt/homebrew/bin
npm run verify
npm run test:mutations
# Mutation probes restore dist; rebuild + rerun the normal path afterwards.
npm test
```

`verify` runs strict TypeScript checking, the native runner's safety tests, and
all real-DB assertions. `npm test` creates a fresh owned cluster, compiles, runs
the acceptance suite, stops that exact cluster and verifies removal. Do not run
`test:db` directly or point it at a shared database. It requires runner-supplied
identity/ownership data and checks the actual target before DDL. Do not run the
mutation probes concurrently with another command in this package: they modify
only ignored `dist/src/accept.js` and restore it in `finally`.

Optional local evidence capture (ignored by Git):

```sh
mkdir -p evidence
npm run verify > evidence/verify.log 2>&1
npm run test:mutations > evidence/mutations.log 2>&1
for run in 1 2 3; do
  npm test > "evidence/repeat-$run.log" 2>&1 || exit "$?"
done
```

## Preconditions and behavioral contract

The fixture generator stands in for the *trusted server's* review/grant issuer.
It creates version-1 synthetic request snapshots, a versioned opaque envelope,
explicit first/last-frame revision/hash placeholders, an approving principal,
and an exact-input count-only grant. These are not actual media hashes or a real
Comfy route/schema. UUIDs vary per fixture; fixture content and expected outcomes
are fixed in `test/fixtures.ts`. No prompt or envelope is rebuilt during accept.

- `Context` is trusted actor/project context, not an agent-supplied approval.
  `Command` is strict Zod input: command ID, review ID, grant ID, request fingerprint.
  Unknown keys, coercion, and implicit defaults are not accepted.
- A review freezes the full versioned request. The fingerprint sorts JSON object
  keys but preserves array order, explicit `false`/`0`, role bindings and exact
  envelope-string bytes. It is not a media identity or provider idempotency key.
- Receipt identity is `(project, actor, command ID)`; its fingerprint covers the
  complete parsed command. A different fingerprint under an accepted identity
  raises `COMMAND_CONFLICT`; a new command with an unreviewed fingerprint raises
  `REQUEST_CONFLICT`.
- Identical accepted replay returns the original `{attemptId, jobId}` **before**
  rechecking mutable draft/grant state. This is a receipt lookup, not permission
  for a new dispatch. Different command IDs competing for a consumed review get
  `REVIEW_ALREADY_CONSUMED`; they do not create additional receipts.
- Unused reviews must still match the saved draft revision and project/shot
  scope. Grant reservation binds actor, project, route, account, exact request
  fingerprint, `generate` effect, expiry, revocation and remaining count.
- Budget policy is explicitly `count_only_unknown_cost`. One attempt reserves
  one unit, and replay reserves none. **No monetary ceiling or provider billing
  bound is claimed.** A hard monetary budget with unknown exposure is not modeled.
- Frozen review fields cannot be updated; consumption can move only from unused
  to an attempt. Attempts, receipts and reservations are append-only in this
  experiment. SQL constraints back review/command/attempt uniqueness and count
  bounds. These are not protections against a hostile database superuser.

## Smallest mechanism that passed

`src/accept.ts` checks out a `pg.PoolClient` and gives that exact client to
`drizzle(client).transaction(...)`. Its lock order is command advisory lock →
review row → draft row → grant row. Grant expiry is evaluated with the database
wall clock **after** acquiring the grant lock. The bounded update plus count
constraint prevents competing distinct reviews from exceeding the allowance.

The transaction writes attempt, review consumption, reservation and receipt,
then calls `boss.send` with a documented `Db.executeSql` adapter wrapping that
same checked-out client. It requires the returned job ID to equal the intended
job ID. Throw/null/mismatch rejects the Drizzle callback; PostgreSQL rolls back
all those writes. There is no after-commit enqueue and no provider/network call
inside the transaction. Queue migrations happen only during isolated setup,
not during an acceptance transaction.

The pinned pg-boss release exposes the generic `db.executeSql` adapter. This
experiment does **not** claim to exercise a newer packaged Drizzle-specific
helper. The adapter is small enough to inspect; tests prove its transaction
binding, rather than inferring it from documentation.

`schema.sql` is one disposable fixture schema, applied through Drizzle after
identity checks. It is not a production migration history or a Drizzle Kit
migration experiment. pg-boss's own real migrations create its queue schema.
Scheduling/supervision are disabled; there are no workers. Queue retry/retention
settings are explicit and do not establish a future production policy.

## Assertions and observed results

The final author run passed **22 DB/contract tests and 7 runner tests**, with no
skips. The acceptance suite then passed on **three additional fresh clusters**.
`npm ci --ignore-scripts --no-fund`, strict typechecking, and `npm audit
--audit-level=moderate` also succeeded; the audit reported zero vulnerabilities
in that run. Audit output is not a comprehensive security review.

| Required condition | Oracle / observed result |
|---|---|
| Atomic successful commit | Fresh independent connection sees one attempt, consumed review, reservation, receipt, created pg-boss job and reserved count; IDs/payload/frozen request agree |
| Exception after real enqueue | During the transaction an independent connection sees neither business state nor job; injected throw leaves no rows; retry succeeds once |
| Actual SQL enqueue failure | A test-only PostgreSQL trigger rejects the real pg-boss INSERT; all acceptance state rolls back |
| Real suppression | A preexisting job-ID collision makes actual `boss.send` return `null`; no acceptance/reservation remains and the sentinel is unchanged |
| Wrong enqueue identity | A real job under an unexpected ID causes rollback, including that job |
| Same command concurrency | Eight distinct backend PIDs/open transactions meet a barrier; all eight responses identify the same single persisted attempt |
| Different-command review concurrency | Eight command IDs meet the barrier; one succeeds, seven get explicit consumed-review conflicts; allowance remains one |
| Shared allowance concurrency | Eight distinct reviews **and draft rows** meet the barrier; exactly one succeeds against a one-unit grant; seven reviews remain unused |
| Changed fingerprint | Both changed accepted-command input and unreviewed new-command fingerprint are rejected without additional rows |
| Stale unused review / accepted replay | Unused old revision rejected; accepted identity returns unchanged after draft edit and grant expiry/revocation |
| Scope / immutability | Wrong actor/project/account/route/input/expiry/revocation rejected; inconsistent frozen scope rejected; frozen rows cannot be rewritten/reopened |
| Runner isolation | Socket-only identity, private directory mode, long-path refusal, environment scrubbing, marker refusal, pre-DDL directory mismatch, independent clusters, SIGTERM cleanup verified |

Race tests do not rely on sleeps: every participant proves a distinct PostgreSQL
backend PID and transaction ID before the barrier releases. Outcome snapshots
use a **new client and one read-only repeatable-read transaction**, not the writer
or a pooled transaction. Rollback checks additionally compare **all queue job
IDs** before/after, so an orphan job cannot hide behind a join to rolled-back
attempts. SQL trigger and enqueue hooks are labeled fault/scheduling seams, not
mock transactions or fabricated queue responses.

### Retained RED → GREEN evidence

Raw logs remain locally under ignored `evidence/`; they are not repository data.
The following are observed runs, not expected-output transcripts. Commands used
`TMPDIR=$HOME/.hermes/cache/scratch`; test counts grew with each slice.

| Slice / local logs | RED observation | GREEN observation |
|---|---|---|
| `01-runner-{red,green}.log` (`npm run test:runner`) | 2 failed: owned-cluster stub not implemented | 2 passed |
| `02-commit-{red,green}.log` (`npm test`) | 1 failed: acceptance stub not implemented | 1 passed |
| `03-enqueue-{red,green}.log` | 2 passed, suppression wrongly accepted | 3 passed |
| `04-command-{red,green}.log` | 3 passed, duplicate/replay/conflict assertions failed | 6 passed |
| `05-review-{red,green}.log` | 6 passed, review race/stale/fingerprint guards failed | 9 passed |
| `06-allowance-{red,green}.log` | 9 passed, allowance/scope assertions failed | 17 passed |
| `07-immutable-{red,green}.log` | 18 passed, frozen review update incorrectly allowed | 19 passed |
| `08-runner-signal-{red,green}.log` (`npm run test:runner`) | 4 passed, startup SIGTERM missed cleanup; test's ownership-checked fallback stopped/removed its child cluster | 5 passed after installing handlers before initialization |
| `10-scope-red.log` → `11-verify-green.log` | 21 passed, mismatched frozen project incorrectly accepted | 22 DB tests + 6 safety tests passed |
| `15-canonical-path-red.log` → `15-final-verify-green.log` | Canonical-path helper failed to reject a safe-looking symlink to an unsafe path | 22 DB tests + 7 safety tests passed after validating resolved paths |

Final confirmation: `16-final-mutations.log` rejects all three deliberate faults;
`17-final-normal.log` passes all 22 DB tests after restoring the implementation.
The canonical-path RED used `node --test --test-name-pattern='canonical temp-parent'
scripts/disposable-postgres.test.mjs`; full GREEN used `npm run verify`.

An injected throw already rolled back with the first real Drizzle transaction;
that test passed when introduced. Later SQL-failure/strict-schema safety tests
also validated existing behavior. They are not represented as previously failing.

`npm run test:mutations` makes current assertion sensitivity reproducible:

1. Ignore accepted-job checks → suppression test fails with missing rejection.
2. Enqueue through the pool instead of the transaction client → independent
   connection sees the uncommitted job; atomicity test fails.
3. Skip accepted receipt lookup → post-edit replay fails with consumed review.

All three deliberately broken variants exited 1 on the expected assertion;
the mutation checker exited 0 and restored compiled code. Its output includes
real failure traces. The three normal reruns afterwards each passed 22 tests.

## Runner ownership and cleanup boundary

The runner ignores inherited `PG*`, `DATABASE_URL` and `SPIKE_*` connection
settings; only the chosen binary directory is read separately. It makes a random
private `aa-*` directory under the explicitly owned `TMPDIR`, with a marker,
fresh `initdb` data directory, short Unix socket directory and random database.
Local trust authentication is confined by private directory/socket permissions;
TCP is disabled and host authentication is rejected. No password is needed.

Before creating the database it verifies the administrative connection's
`current_database()` and `data_directory`; before our schema and pg-boss
migrations it rechecks the actual database/data directory, sockets and disabled
TCP listener. Cleanup checks the original ownership marker, directory, recorded
postmaster PID and PID-file data directory before using `pg_ctl -D <owned-dir>`.
It verifies stopped status, absent PID file, dead recorded PID, and removed root.
It never stops a service by name or port. The tests keep another newly owned
cluster alive while stopping the first to verify isolation.

Normal completion, test failure and the primary runner's tested startup SIGTERM
path clean up. SIGKILL, machine failure, and hostile same-user filesystem/PID
replacement are **not** recoverable cleanup guarantees. A guard mismatch fails
closed rather than deleting an unverified directory. Never repair such a failure
by a broad `pkill`, service restart, shared-database reset, or unscoped removal.

## Limits / remaining work

- No Comfy/media/model integration, file upload, real media, FFmpeg, worker fetch,
  dispatch/replay/cancel/import recovery, browser, HTTP/MCP/authentication UI or
  director loop. Only acceptance and queued persistence are proven.
- No crash/restart/power-loss durability experiment, remote exactly-once claim,
  high-load throughput benchmark, migration-upgrade matrix, or cross-platform
  compatibility claim. Durability here is actual PostgreSQL commit with normal
  server defaults, then observation from another connection.
- Grants/reviews are provisioned by trusted synthetic fixtures; no production
  grant issuer, credential handling or least-privilege/RLS deployment is built.
  A later worker must separately recheck dispatch authority. Accepted replay
  cannot be mistaken for fresh dispatch approval.
- Only the implemented version-1 fixture contract and this dependency set were
  exercised. Full application and cross-spike integration remain untested.
- Author validation is not independent approval. The parent/coordinator must
  review the exact diff and run evidence before any merge or issue transition.

## Sources inspected

- [Issue #3](https://github.com/pkidwell22/comfy-creative-studio/issues/3),
  [experiment brief](../../docs/CONTRACT-EXPERIMENT-BRIEF.md),
  [foundation §5](../../docs/FOUNDATION-BLUEPRINT.md),
  [V09–V11 and V26](../../docs/VERIFICATION-PLAN.md).
- [pg-boss 12.11.1 send/null/transaction adapter contract](https://github.com/timgit/pg-boss/blob/12.11.1/docs/api/jobs.md)
  and [constructor/isolation options](https://github.com/timgit/pg-boss/blob/12.11.1/docs/api/constructor.md).
- npm metadata for every direct pin; installed Drizzle 0.45.2
  `node-postgres/session.js` transaction implementation (same supplied client,
  real BEGIN/COMMIT/ROLLBACK) and installed pg-boss 12.11.1 adapter types/source.

The concrete correction to the proposal is narrow: successful `send()` resolution
alone is insufficient; require the expected job identity. Use a demonstrably
transaction-bound client, stable receipt lookup before mutable preconditions,
row-locked single-use review consumption and an atomic allowance reservation.
Do not promote this result into proof of provider idempotency or worker recovery.
