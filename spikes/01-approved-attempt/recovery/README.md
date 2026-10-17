# Recovery extension — interrupted generation without a new attempt

**Disposable contract experiment. Refs #5. Author evidence, not independent approval.**

## Verdict: VALIDATED for this bounded simulator; live integration UNTESTED

Real PostgreSQL, pg-boss deliveries and separate Node worker processes recovered
one already authorized attempt through lost HTTP replies and actual `SIGKILL`.
The worker preserved the original request bytes/key, fenced stale checkpoints
**and queue acknowledgements**, retained late acceptance evidence, and recovered
owned output identities across the finalized-bytes/SQL-publication gap. Recovery
never created another business attempt, consumed another review/count allowance,
or changed the editorial selection.

This is **not Comfy integration, provider exactly-once/billing evidence, actual
video, or production infrastructure**. Output files contain the literal label
`SIMULATION ONLY; NOT MP4 OR PROVIDER MEDIA` and use `.simulation`, never `.mp4`.
Actual media integration belongs to #6. No code from the separate media spike is
imported. Count-only grants establish no monetary ceiling or billing proof.

## Scope and reuse

This extends the merged #3 package instead of copying its service, dependencies,
fixtures or cluster runner. `src/accept.ts`, `src/contracts.ts`, the frozen
acceptance `schema.sql`, and acceptance tests remain unchanged. Mutable lifecycle,
dispatch intent, receipts, deliveries and imports live in the **separate
`recovery` schema**. The initial accepted attempt/receipt/reservation stays frozen.

`openExperiment({ initialize: false })` verifies the same exact owned database,
data directory, socket and disabled TCP identity as setup, but performs no schema
creation or queue migration. Only each suite's initializer creates schema. The
acceptance and recovery suites have **separate fresh owned clusters**, not two
files silently reusing one initialized DB. A test also deliberately attempts a
second initializer and checks PostgreSQL's duplicate-schema rejection. No global
`IF NOT EXISTS` was added to conceal isolation defects.

Files:

- `engine.ts`: one bounded delivery, authorization/replay guards, evidence,
  epoch/owner fencing and transactional import publication.
- `worker.ts`: real child-process entrypoint; IPC checkpoints schedule faults.
- `simulator.ts`: independent local HTTP fixture with physical-call log, scoped
  idempotency map, remote job identities and output identity records.
- `store.ts`: bounded synthetic-byte staging, hashing, immutable hard-link
  publication and recovery of already finalized bytes.
- `schema.sql`, `fixtures.ts`, `recovery.test.ts`: separate lifecycle schema,
  isolated resources/process controller and independent assertions.

## Reproduce

Use the same exact pins as the parent package: Node **26.8.1**, npm **11.19.0**,
PostgreSQL **18.6**, TypeScript **5.9.3**, Zod **4.3.6**, Drizzle **0.45.2**,
pg **8.20.0**, pg-boss **12.11.1**. No new dependency or global install.

From the repository root:

```sh
cd spikes/01-approved-attempt
npm ci --ignore-scripts --no-fund
export TMPDIR="$HOME/.hermes/cache/scratch"
export PG_BIN=/opt/homebrew/bin
mkdir -p evidence
npm run verify > evidence/verify.log 2>&1
npm run test:mutations > evidence/acceptance-mutations.log 2>&1
npm run test:recovery:mutations > evidence/recovery-mutations.log 2>&1
# Mutation probes edit ignored dist only; rebuild/retest the normal source.
npm test > evidence/acceptance-final.log 2>&1
npm run test:recovery > evidence/recovery-final.log 2>&1
```

`npm run test:recovery` alone runs every recovery/fault case. Do **not** run the
`:db` scripts against any ambient/shared DB: the owned-cluster runner supplies
and verifies their identity. Do not run mutation probes concurrently with a
build/test in this package. No server is installed or left running.

## Behavioral contract and linearization

1. Acceptance is the unchanged reviewed-request transaction: one command/review,
   attempt, count reservation and initial pg-boss job. A fixture adds its initial
   lifecycle row and an explicit preexisting editorial-selection sentinel.
2. A real `boss.fetch(queue, { includeMetadata: true })` activates the job and returns its
   integer `retryCount`. Before claiming a fresh owner UUID/epoch, lock that job
   row and require both active state and the same counter. A delayed older fetch
   returns stale without changing ownership or reaching provider work. Queue job,
   activation, delivery owner and business attempt are separate identities.
3. Before any possible submit, persist an immutable dispatch row containing the
   original attempt key, exact envelope body, adapter, account, route, simulator
   origin, replay-safety declaration and replay deadline. Database triggers reject
   updates/deletes. No current draft is consulted to rebuild the envelope.
4. Prefer a known remote handle (including a valid late receipt from an old
   worker). Optional read-only key lookup may recover an unknown handle. A missing
   known handle is a visible hold, **never** permission to submit another request.
5. Any request-creating POST requires a fresh, row-locked authorization check:
   current owner/epoch, cancellation, pause, current grant scope/revocation/expiry,
   replay safety/window and submission-slot limit. Expiry uses PostgreSQL's wall
   clock **after locking** the grant. Authorizing and recording unknown acceptance
   commits before the HTTP call; no DB transaction spans external I/O.
6. Cancellation before that authorization prevents dispatch. Cancellation after
   it cannot recall an already authorized/in-flight operation. Reconcile valid
   late acceptance; cancel a known remote handle, recording confirmed vs too late.
   Unknown acceptance plus cancellation holds without POSTing to obtain a handle.
   Read-only lookup remains allowed; local intent is not proof of remote stop.
7. Every reply is checked against the dispatch scope. Valid late evidence remains
   append-only even if its worker lost ownership. Only a current delivery applies
   checkpoints; succeeded/cancelled state cannot regress to running. Conflicting
   known handles hold. A separate test forces old running evidence after success.
8. Claim and acknowledgement both lock **queue job → lifecycle**, in that order.
   Acknowledgement requires the fetched activation counter **and** owner/epoch;
   both row locks remain held through the transaction-bound `boss.complete()`.
   Lifecycle ownership alone is insufficient: a newer fetch commits before its
   claim, while the lifecycle can still name the old worker. The regression pauses
   the newer worker in exactly that gap and proves its activation stays active.
   A separate reversed-order test prevents an older fetch stealing a newer claim.
9. Stable import identity is `(attempt, remote output ID)`, with remote job,
   immutable hash and length pinned at claim time. Download to private staging,
   verify bounded bytes/hash, publish immutable bytes, then transactionally publish
   the take/import linkage under the current owner. A changed descriptor for an
   existing output identity holds before downloading. Two separately approved
   attempts with equal bytes retain distinct take and remote provenance.
10. Finalized bytes without SQL metadata are reusable after restart; a partial
    download has neither finalized bytes nor a take. Duplicate deliveries converge
    through output uniqueness and content-addressed bytes. Late successful output
    after cancellation is imported as an **unselected** alternative.

## Bounds that are actually enforced

- Local HTTP only: simulator binds **127.0.0.1 with an ephemeral port**. Worker URLs
  must match that literal origin and typed fixture paths; redirects are rejected.
- Every HTTP operation has a **4-second** deadline. Byte intake is capped at
  **4096 bytes** and the pinned expected length/hash. The fixture exposes at most
  two output descriptors; this is not a general media intake/security sandbox.
- At most **two durable submit authorizations per attempt**, including the first.
  A crash before physical send may consume a slot. This is deliberately
  conservative. `submit_count` counts authorizations, **not** physical requests;
  the simulator's separate log is the physical-call oracle.
- Default replay window: **60 seconds** from immutable intent creation. Unsupported
  replay, expired window, changed origin/adapter or exhausted slots holds visibly.
  The simulator programs same-key/same-scope/same-body deduplication for its own
  lifetime; none of these numbers establishes a real provider guarantee.
- A worker processes **one delivery**, with bounded provider operations, then
  acknowledges it or is killed. The harness uses real `boss.fail`/`boss.retry` or
  an explicit additional delivery for deterministic resumption. It does not
  create a new attempt or grant. There is no autonomous poll loop, automatic
  reroll, production lease scheduler, throughput/retention policy or global cap
  on explicit read-only recovery commands. Running/held work needs an explicit
  subsequent recovery command; a completed queue job is not a completed take.
- No guessed refund on cancel/unknown/failed import. Reserved count remains one.
- The activation fence depends on pinned pg-boss **12.11.1**: fetch increments the
  integer counter on reactivation; fail/retry preserve it. No timestamp is compared
  through JavaScript `Date`. Direct counter resets or deleting/recreating a job
  with the same ID are outside this protocol. Distinct job IDs still arbitrate
  lifecycle ownership by claim epoch, not a global fetch-time ordering.

## Independent oracles and exercised faults

The simulator runs in the test process, outside each killed worker. Its physical
calls, keys, remote jobs and outputs are inspected directly, not inferred from a
worker return. DB snapshots use a **new pg client** in a read-only repeatable-read
transaction. File hashes are recomputed by the test from actual disk bytes.
Workers are separate PIDs; the harness observes `exit: SIGKILL` and verifies PID
absence. IPC barriers force ordering instead of sleeps guessing a race.

| Fault/condition | Observed invariant |
|---|---|
| Kill after intent, before POST | Independent DB sees immutable intent, queue active, zero physical calls; restart keeps exact key/body |
| Accepted POST, socket destroyed, kill/restart | Two physical submits, one key/body, one remote job; later deliveries use GET |
| Kill after reply before receipt | Optional read-only key lookup recovers that remote identity with one submit total |
| Cancel/pause/revoke/expire before dispatch or unknown replay | Zero physical submits when the crash preceded the first possible effect; no allowance release |
| Cancel while unknown but remotely accepted | Hold with no second submit; later read-only lookup and known-handle cancel reconcile |
| Cancellation before/after authorization | Prevention vs confirmed remote cancel/too-late success are separately observed; late output remains unselected |
| Late acceptance from stale owner | Receipt retained; old checkpoint blocked; current worker reconciles it without request-creating POST |
| Old running reply after success | Success checkpoint does not regress |
| Newer fetch paused before claim | Old owner cannot complete the newer activation of the same pg-boss job |
| Older fetch resumes after newer claim | New owner/epoch, dispatch and delivery rows stay unchanged; no stale provider work |
| Unsupported/expired replay, changed adapter/origin, slot exhaustion | Explicit holds, no new key/attempt |
| Duplicate import/delivery | Same take IDs, no repeated download of finalized bytes |
| Partial HTTP transfer | Staging removed, no finalized bytes/take; later import-only recovery succeeds |
| Kill after finalized bytes, before SQL | Claimed identity and actual immutable bytes survive; restart publishes same output once |
| Kill after first output SQL commit | One take before kill, exactly two after restart; first identity unchanged |
| Actual PostgreSQL trigger rejects take INSERT | Publication transaction rolls back; finalized bytes/claim recover on next delivery |
| Both importers paused after bytes, before SQL | Resume stale worker first: fresh connection sees zero takes and unpublished import; current worker then succeeds |
| Equal bytes across two approved attempts | Two remote jobs, four separately attributed takes, two byte objects |
| Descriptor drift for existing output ID | Explicit conflict before download; original claim unchanged |
| Resource acquisition/read/cleanup failures | Acquired simulator closed; one cleanup rejection cannot strand another resource |

## Retained execution evidence

Raw logs are ignored under `../evidence/`. After the review correction, strict
typechecking, **11 existing runner tests**, **22 unchanged acceptance tests** and
**38 recovery/resource tests** passed twice, including after both mutation suites,
with no skips. npm audit reported zero vulnerabilities (not a comprehensive
security assessment). The following table records the original historical runs;
their raw evidence is preserved, not rewritten as proof of the correction.

| Logs | Actual RED → GREEN observation |
|---|---|
| `00-baseline.log` | Existing 11 runner + 22 acceptance tests passed before changes |
| `01-connect-{red,green}.log` | Duplicate schema creation on worker connect → connect-only mode succeeds |
| `02-intent-{red,green}.log` | Missing durable intent (`0 !== 1`) → intent survives real kill/restart |
| `03-lost-{red,green}.log` | Unhandled lost response and extra submit instead of lookup → unknown checkpoint and same-identity recovery |
| `04-authority-{red,green}.log` | Eight prohibited POST cases failed → all eight prevented/held |
| `05-limits-{red,green}.log` | Six unsafe replay/missing-handle cases failed → explicit bounded holds |
| `06-cancel-fence-{red,green}.log` | Five late-evidence/cancel cases failed → reconciled cancellation; stale-running test already passed when added |
| `07-import-{red,green}.log` | Remote success had zero owned takes → two verified unselected simulation outputs |
| `08-publication-{red,green}.log` | Missing crash checkpoints and uncaught partial/SQL publication failures → explicit fault seams and recoverable import hold |
| `09-attribution-{red,green}.log` | Drift incorrectly attempted download → stable-output conflict before download |
| `10-ack-{red,green}.log` | Old owner completed newer active job → atomic owner-checked acknowledgement |
| `11-full-verify.log` | 11 runner + 22 acceptance + 35 recovery tests passed; real PID/cleanup traces |
| `12-recovery-mutations.log` | All three deliberately broken compiled variants rejected on named assertions |
| `13-acceptance-mutations.log` | All three original acceptance mutations still rejected |
| `14-final-verify.log` | Normal source after both mutation suites: 11 runner + 22 acceptance + 36 recovery tests passed; includes rejection-before-acceptance transport loss |

The final cleanup assertions, duplicate/equal-byte tests and several existing
fences passed when introduced; they are not misrepresented as historical REDs.
Adding a fault checkpoint is instrumentation, not proof that the preexisting
storage protocol itself failed. Current mutation probes make assertion
sensitivity reproducible: bypass cancellation, remove epoch predicates, or skip
output-attribution validation; each named test must fail, then compiled code is
restored. Author validation remains separate from the coordinator's review.

### Review correction: activation fencing and publication oracle

The original acknowledgement test transferred lifecycle ownership before resuming
the old worker. It missed the fetch-to-claim gap reproduced independently in
`parent-review/ack-fetch-gap.json`. New deterministic child-process regressions
failed **before** the fix: the newer active job became completed; an older fetch
also replaced the newer owner/epoch and consumed another submit authorization.
The shared activation lock/check at claim and acknowledgement fixes both orders.

The importer test now pauses the current owner before SQL publication instead of
letting it finish first. Removing only the publication owner predicate produces
an observable phantom take, even though uniqueness would hide it after both
workers finished. No storage protocol change was needed.

Separate ignored `correction/` evidence records activation RED/GREEN, publication
mutation RED, two full verifies, all **3 acceptance + 6 recovery mutations** rejected
on their named assertions, audit and exact owned-resource cleanup checks. The
three additional recovery mutations separately remove publication ownership,
claim activation validation and acknowledgement activation validation. Normal
compiled output was restored and verified after mutations; historical evidence,
acceptance sources/tests/schema, dependency lock and recovery schema are unchanged.

## Cleanup and remaining uncertainty

Each acquired resource registers cleanup immediately. Cleanup actions settle
independently. Owned byte directories are inside the exact owned cluster root;
tests remove them, and the outer runner also owns that root. Simulator shutdown
closes active connections and asserts it stopped listening. Worker teardown
awaits exit/PID absence. The existing strict marker/data-directory/PID checks stop
only the owned Unix-socket PostgreSQL cluster and verify its directory vanished.
No shared database, installed service or unrelated process is touched.

This tests **worker process** failure, not machine/power loss, filesystem crash,
PostgreSQL restart, provider-server restart, multi-host coordination or hostile
same-user file replacement. Files are synced before immutable linking, but no
cross-filesystem/SQL atomic transaction or power-loss durability is claimed.
There is no general orphan garbage collector; owned disposable roots are removed
on completion. Abrupt outer-runner SIGKILL/machine death remains a manual,
ownership-checked cleanup boundary inherited from the acceptance harness.

Stable remote output IDs, verified replay windows/account scope, signed URL
refresh, credentials, live cancellation/idempotency, entitlement, billing,
provider-specific failure states and actual media quality remain untested.
Synthetic trusted review/grant issuance and a local-only fixture protocol are
not production authorization, SSRF protection or a public API. Do not promote
this throwaway engine into the application without those separate proofs.

**Smallest supported correction:** keep acceptance immutable; add narrowly scoped
lifecycle/evidence tables; fence both domain publication and queue acknowledgement;
prefer read-only reconciliation; guard every request-creating replay; recover
storage publication by stable output identity. No broader architecture change is
justified by this experiment.
