# Execution evidence and constrained verdict

## Trusted-local fixture review follow-up

Based on `2466b57396d5d078835dd9cae08d45ee039f48cf`, this removes the manual review-key handoff without changing the protected default API. `demo.ts` alone selects the closed `trusted-local-fixture-review` HTTP mode. Its HTML contains the workflow and an explicit trust notice, not the login/key section; the actual UI JavaScript opens it with a credential-free state read. No key is placed in HTML, JavaScript, URLs or logs, no browser cookie is issued by automatic entry, and the launcher creates only the private agent credential file.

The server selects a process-local Symbol handle for the existing fixture reviewer **only when no Authorization or Cookie header was supplied**. That handle retains the same PostgreSQL project membership and actor/capability lookup but is independent of bearer-session expiry; no identity/session renewal or new authentication framework is involved. A same-description Symbol or a string cannot impersonate it. Supplied bearer/cookie credentials retain normal validation and expiry, agents remain agents, and malformed/duplicate Authorization fails rather than falling back. The handle cannot be exchanged at `/session` for a wire credential. **This local convenience is not an authentication barrier against local processes and does not prove human identity.** Host/Origin/CSP restrictions are retained, not represented as local-process authentication. No real-provider or spending permission is added.

| Gate | Observed local-review result |
|---|---|
| Focused new/updated demo, UI and guard tests | Typecheck and **13 tests pass** against fresh owned PG and real HTTP |
| Full `npm run verify` → mutations → normal `npm run verify` | Typecheck and **43 tests pass twice**, zero skipped/cancelled; 38 retained/adapted plus five local-review guard cases |
| `node scripts/check-mutations.mjs` | **45 controls rejected** at specific assertions: prior 29 plus 16 local-review controls; owned-cluster removal checked for each |
| Parent probes | All **four unchanged probes pass**, run with a separate output directory: accepted replay, overlapping replay, serialized mixed recovery and uppercase UUID recovery |
| Frozen baseline reuse | **38 tracked 01/02 files** and MIT license match both the follow-up base and main `55d2d64d56869d1490b459352a4db21a17c88e72`; 04 schema/package/lock files also unchanged. Prior **71 core tests, 3 acceptance + 6 recovery mutations, 43 media tests** reused, not claimed as newly rerun suites |
| Fresh local dependency audits | **Zero vulnerabilities** for 01, 02 and 04; no installs or dependency/lockfile changes |
| Cleanup and evidence preservation | **153 observed owned-cluster roots** absent, zero matching live processes; demo tests also assert PID death/listener refusal. **30 prior mutation artifacts** archived and hash-verified before output reuse |

**Observed RED → GREEN:** the actual launcher first failed the no-key-form assertion. After enabling automatic entry, forcing its human session into the past through an ownership-checked independent PG connection still produced **401**, exposing the expiry bottleneck. The process-local reviewer handle makes both a fresh page and the already-open UI work after that expiry, including real first-look inspection and explicit approval by the same actor. The HTTP guard test separately exposed invalid cookie fallback and duplicate Authorization acceptance (**200 instead of 401**); both now fail closed. Logs for these red/green steps remain ignored under `output/trusted-local/`.

**Authority and UX readbacks:** opening the actual demo issues only `/state` and creates zero inspections, approvals, reviews, grants, attempts or reservations. Inspection still does not approve; approval still reserves zero attempts; selection stays empty. The full editor workflow now runs through local mode without injecting a human bearer. The retained protected-mode cookie/CLI, revision, grant, recovery and asynchronous-editor tests still pass. Additional coverage proves protected unauthenticated reads/commands reject, explicit agents cannot approve using their own inspections, supplied expired credentials stay expired even after local entry, the local handle retains project membership checking, and cross-origin/foreign-Host/missing-Origin POST, transfer/spend/authorize, arbitrary media and non-fixture routes reject. Coverage that passed immediately is supported by targeted mutations, not described as a historical implementation RED.

**File ownership:** a pre-existing legacy `human-session.txt` does not block startup and is never consumed or removed. Existing `agent-session.txt` and `demo.json` sentinel collisions still fail exclusive creation without deleting the sentinel; all newly acquired resources are cleaned. The old cleanup control is retained, with an additional legacy-file deletion control. The project-membership control's source match was adjusted only for the parenthesized expiry predicate. Six wrapper type annotations in dispatch/UUID tests now follow the service parameter type; their runtime assertions/interleavings are unchanged.

**Environment:** the first test attempt failed before reaching the behavior under test: native PostgreSQL reported `postmaster became multithreaded during startup` and requested a valid `LC_ALL`. An isolated diagnostic cluster reproduced that error and was removed. Explicit `LC_ALL=C`, together with the required owned `TMPDIR` and `PG_BIN`, made subsequent runs pass; no PostgreSQL source, global settings or unrelated process was changed. This environment failure is preserved separately, not counted as a behavioral RED.

All retained parent demo worktrees/processes/data remain untouched; no lasting server was launched. Independent parent code/visual review remains distinct from author tests. The parent can open the replacement demo directly without any user key-entry action. DOM/real-HTTP automatic-entry and expiry tests are not browser rendering/playback evidence. No production auth, actual LLM usability, private upload, live provider/spend, merge, approval or issue closure is claimed.

## Authorized UUID-key follow-up (historical)

This follow-up is limited to the confirmed valid-UUID case mismatch at `b5d3e0ee38bc794ff150c615679621a370fa86ce`. The only implementation change is in `http.ts`: validate the attempt UUID before deriving a lowercase **internal** key for the existing arrival-generation/recovery-group coordination. The validated service callback already supplies PostgreSQL's canonical lowercase ID for worker coordination. Arrival capture remains before command serialization; the original command is passed unchanged to the common structural, principal, revision and attempt-ownership checks. No schema, dependency, core 01/02, license, UI implementation or broader scheduling change is included.

| Gate | Observed UUID follow-up result |
|---|---|
| Full `npm run verify` → mutations → normal `npm run verify` | Typecheck and **38 tests pass twice**, zero skipped/cancelled; the original 33 remain unchanged and five UUID cases are added |
| `node scripts/check-mutations.mjs` | **29 mutations rejected** at specific assertions; all 26 prior controls retained unchanged, plus arrival-key canonicalization, recovery-group key and malformed-input repair controls |
| Parent probes | **Four tests pass**: both original tests byte-for-byte, the previously adapted serialized mixed-recovery test unchanged, and the uppercase probe copied verbatim from the parent's final-review evidence |
| Frozen baseline reuse | **38 tracked 01/02 files** and root MIT license byte-identical to both the follow-up base and main `55d2d64d56869d1490b459352a4db21a17c88e72`; reuse prior **71 core tests, 3 acceptance + 6 recovery mutations, 43 media tests**, not newly rerun suites |
| Fresh local dependency audits | **Zero vulnerabilities** in each of 01, 02 and 04; no install or lockfile change |
| Evidence preservation / cleanup | **122 earlier artifacts hash-verified preserved**; 27 previous mutation artifacts archived before rerunning their output paths. **115 observed owned-cluster roots** independently absent, with zero matching live processes. Tests also assert postmaster/worker/demo PID death and HTTP listener refusal |

**Observed implementation RED → GREEN:** before the fix, the parent's verbatim uppercase probe and both new uppercase/mixed-case regressions used real PG/HTTP, started an actual worker via HTTP, paused it at intent and sent OS SIGKILL. Both new UUID-variant regressions returned HTTP 200 and the canonical receipt but failed with the original job **active** rather than completed; the parent's report additionally confirmed `available=false` and zero takes. After the key correction, the same probe and regressions complete the original job, return `available=true` and **two takes**; SQL retains one attempt, receipt, reservation, queue job and dispatch key, and the provider receives one submission/job. No additional user command or reroll is needed.

**Additional coverage with negative controls:** mixed-case recovery and a canonical caller overlap at a real queue-read barrier and after a new worker launches but before the first command returns. They share one arrival generation; the new activation is neither killed nor invalidated, and it completes after its real `after-fetch` barrier is released. A raw recovery-group-key mutation fails the no-replacement assertion. Malformed UUIDs (including surrounding whitespace, braces, missing hyphens, invalid hex and nonstrings) produce exact `STRUCTURE`/400 responses through the common service, preserve literal input and leave durable rows, the held worker and provider untouched. Invalid principals, stale revisions, unknown owned-attempt candidates and extra fields still reject. A trim/repair mutation fails that rejection assertion. These coverage-only checks are not represented as separate historical implementation defects.

The canonical-key mutation independently restores the original uppercase failure. The original two parent probe outcomes still pass, and the previously adapted mixed probe still observes **two actual queue reads**, a completed job and two takes. No original probe, negative report or failure log was rewritten. New execution logs and preserved mutation artifacts are ignored under `output/uuid-key/`; parent probe reports use separate working directories. The fixture provider stays alive throughout worker interruption tests. All three retained live demo worktrees/processes and their session files were left untouched; no new retained preview was launched.

Submitted for independent parent re-review, not author approval. Browser rendering/playback, production authentication, arbitrary media intake, provider-process disaster recovery, interrupted-export restart and live model/provider spending remain outside this proof. PR/issue remain open; GitGuardian, strict current-base checks and squash-only/no-bypass rules remain in force.

## Second correction: mixed recovery and POST-phase oracle (historical)

This focused correction is based on `526d3e9354435e107f13b4d472652c9a1c0be375`. Both retained demo worktrees/processes remain untouched. The original five fixes are retained; only HTTP recovery coordination, its internal validated service callback, tests, mutation controls and this documentation change. UI implementation, schemas, dependencies, lockfiles, license and all **38** frozen 01/02 files are unchanged.

| Gate | Observed second-correction result |
|---|---|
| Full `npm run verify`, then mutations, then normal `npm run verify` | Typecheck and **33 tests pass twice**, zero skipped/cancelled; five added dispatch cases |
| `node scripts/check-mutations.mjs` | **26 mutations rejected** at expected assertions: 21 prior controls plus five new controls |
| Parent probes | Original two probe tests run byte-for-byte; mixed-recovery probe run with only boundary instrumentation adapted for serialization; **all three pass** |
| Frozen baseline reuse | Byte-checked unchanged 01/02 against the correction base and main; retained **71 core tests + 3 acceptance / 6 recovery mutations**, and **43 media tests** as prior execution evidence, not newly rerun suites |
| Fresh project-local audits | **Zero vulnerabilities** for 01, 02 and 04; no installs or dependency changes |

**Actual implementation RED:** a real worker was SIGKILLed at `intent`, leaving its job active and remote state unknown. An exact HTTP replay held an actual `isQueued=false` read while recovery reactivated the job. Both requests returned 200, but the completion assertion found `retry`, not `completed`. The failing test snapshot and log are retained privately, alongside the unchanged parent failure probe/logs.

**Ordering fix and GREEN:** the service invokes HTTP's recovery callback only after common structural, principal, revision and attempt-scope validation, while retaining the existing advisory lock. HTTP reserves recovery behind the old start promise, then stops the previous owned worker, performs fail/retry, and takes a fresh queue observation before dispatch. The adapted barrier explicitly proves the job stays **active** while the old false read is held; fail/retry cannot overtake it anymore. Releasing that read yields **two real queue reads**, one replacement worker, a **completed** original job, `available=true` and **two takes**, without another command. Independent SQL checks retain one attempt, receipt, reservation, job and dispatch key; the fixture provider has one submission/job.

The stronger overlap checks also exposed why simply chaining a forced restart is insufficient: it killed a worker just started by the preceding replay/recovery. Arrival generations now make such requests join the new activation instead. A real `after-fetch` worker barrier proves no replacement fork or fail/retry occurs, the new worker stays alive/active, and it completes after release. A separate response-window RED caught arrival after worker launch but before the first recovery command returned; overlapping requests retain their shared generation through command completion. These are bounded in-memory HTTP ownership records, not a scheduler or a change to the frozen queue/activation protocol. Stopping an older worker before reactivation and rejecting malformed/stale/foreign-attempt recoveries are covered too.

**UI coverage only:** immediately after the held successful POST reaches the follow-up GET, the test now asserts text B still exists **before** typing text C. The correct UI implementation passes unchanged. A new isolated mutation assigns `prompt.value=saved.prompt` immediately after POST success and fails that exact B assertion; the separate GET-overwrite mutation still fails the C assertion. This closes an oracle gap, not a newly discovered UI implementation defect or fabricated historical RED. The stop-before-reactivation case likewise passed initially and is supported by a distinct ordering negative control.

The first rerun of the old coalescing mutant survived because removing only its early return now leaves the new pending-promise serialization intact. The control now removes the pending lookup itself, restoring independent queue decisions; the original outcome assertion is unchanged and rejects it. That initial mutation result remains separate from the final passing run. Earlier failure evidence was preserved rather than overwritten; new logs are ignored under `output/review-fixes-2/`. Parent probe outputs run in a separate ignored working directory so old reports remain intact. Owned cluster directories/processes are checked after execution; worker and demo tests additionally verify PID/listener cleanup. Independent parent re-review/retesting and browser interaction remain required.

## First review correction evidence (historical)

Corrections were authored and exercised in a separate worktree based on `bcb357a77245960b4c52cc5023e8341945cc4d24`. The retained user demo, its local branch and its session files were not changed. All source changes remain under this experiment; all **38** tracked 01/02 files and the root MIT license match both that head and `55d2d64d56869d1490b459352a4db21a17c88e72` byte-for-byte.

| Gate | Observed correction result |
|---|---|
| `npm run verify` | Typecheck and **28 tests pass**, zero skipped/cancelled; 17 added regression cases |
| `node scripts/check-mutations.mjs` | **21 mutations rejected** at specific expected failures: the original six plus 15 correction controls |
| Unchanged 01 verify / mutation commands | **71 tests pass** (11 runner, 22 acceptance, 38 recovery); **3 + 6 mutants rejected** |
| Unchanged 02 typecheck / tests | **43 tests pass**, after owned fixture generation |
| Original parent probes, copied without edits | **Both pass**: original receipt after an edit; overlapping HTTP receipts with one queue read, no interruption, one available attempt and two takes |
| Project-local dependency audits | **Zero vulnerabilities** for 01, 02 and 04; no lockfile changes |

| Defect | Observed RED → correction / GREEN evidence |
|---|---|
| Premature advisory unlock / client release | Real PG terminal-statement barriers found the shot lock absent before COMMIT/ROLLBACK. All mutation/accept promises are now awaited. Independent sessions prove an overlapping human/agent edit or selection waits, exactly one wins, and the loser conflicts; pg protocol status proves released clients are transaction-idle. SQL revision compare-and-set also rejects an independent write between validation and mutation. |
| Receipt replay after edits | The same accepted command returned `REVISION_CONFLICT`. Principal-scoped immutable receipt lookup now reconstructs the original core command before mutable draft/grant validation; the unchanged core returns its receipt. Wrong revision/intent, foreign or changed principal, malformed payload and genuinely new stale submissions still reject. Readbacks show no added receipt, job, grant or reservation. |
| Concurrent HTTP replay | Actual queue-read barriers reproduced a second worker and false interruption. Pending starts are now reserved before the asynchronous decision and shared by concurrent receipts. Real fork counts show one worker; failed reads release pending state, and shutdown drains pending starts without late launches. A completed replay after editing starts no new worker. |
| Save replaces newer text | Deferred real POST/GET responses replaced text typed during the save with the submitted text. Save completion now keeps the live buffer and uses the successful POST's base revision, not a later GET's revision. Newer text stays dirty with approval/submission disabled; a subsequent save succeeds or conflicts appropriately. A deliberately lost response after a real commit is described as an unknown result, not a failed write. |
| Cleanup deletes unacquired files | Real demo startup with each pre-existing session/readiness sentinel deleted that sentinel on EEXIST. Exclusive open now succeeds before removal is registered. All three sentinels survive; the actual failure path stops both new listeners, demo/postmaster processes and removes the new cluster and only the newly acquired process files. |

Per-defect RED/GREEN logs and final runs are retained privately in ignored `output/review-fixes/`; parent probe copies/results are in this worktree's ignored `output/parent-review/`. The parent's original four evidence files were hash-compared before/after and remain unchanged. Tests observe real PG queries, worker processes and HTTP responses; they do not fabricate database results. UI proof is DOM/HTTP logic, not browser rendering or playback.

The pending-start failure test initially passed after coalescing and is **coverage with a negative control**, not a claimed historical RED: retaining a rejected pending start makes its retry assertion fail. The first revised mutation run found that the old revision mutant now fails at the new stale-submission error assertion rather than the edit assertion (the new CAS still rejects the edit); its expected failure was updated, not the behavioral test. The initial rollback probe's observation was corrected to use PostgreSQL's `idle in transaction (aborted)` state rather than a non-null transaction timestamp. Both initial logs remain separate from successful runs.

Every printed owned-cluster root collected from the correction logs was independently checked absent, with no matching live postmaster command. Demo/worker tests additionally assert recorded PID death and listener refusal. No shared database, live provider, secret read, global install, browser installation, approval, merge or issue closure was performed. Corrected code still requires the parent's independent retest/re-review and visual review.

## Original submission gates (before these corrections)

Executed against Node **26.8.1**, npm **11.19.0**, existing FFmpeg **9.0.1**, and fresh owned socket-only PostgreSQL clusters.

| Boundary | Command | Observed result |
|---|---|---|
| New workflow | `npm run verify` | Typecheck and **11 tests pass**, zero skipped/cancelled |
| New negative controls | `node scripts/check-mutations.mjs` | **6 mutations rejected** at their expected assertions; isolated copies only |
| Original acceptance/recovery | In 01: `npm run verify` | **71 tests pass**: 11 runner, 22 acceptance, 38 recovery |
| Original mutation gates | In 01: `npm run test:mutations && npm run test:recovery:mutations` | **3 acceptance + 6 recovery mutations rejected**; compiled code restored |
| Original owned-media boundary | In 02: `npm run typecheck && npm test` | Typecheck and **43 tests pass** |
| Dependency install | Pinned project-local `npm ci/install --ignore-scripts` | Audits returned zero vulnerabilities |
| Frozen-source comparison | Compare each tracked 01/02 file with Git blobs at `8bd5f8ef92c414f7d9149011d62f56eafeffc579` | **38 files byte-identical**, including both old lockfiles, schemas, contracts and tests |

The branch was fast-forwarded to the independently merged license/branding base `55d2d64d56869d1490b459352a4db21a17c88e72`. All authored changes are in `spikes/04-caller-parity`.

## Acceptance map

| Issue requirement | Actual exercised evidence |
|---|---|
| Same structural/capability/auth/revision checks | `service.test.ts`, `http.test.ts`: actual cookie and bearer requests plus a CLI subprocess use the same service; reject forged identity, foreign project, role/approval JSON, unsupported transfer, arbitrary media URL and stale revision. Agent's own valid inspection still cannot grant review authority. |
| First/end roles and continuity freeze unchanged | `media.test.ts`, `service.test.ts`, `recovery.test.ts`: real experiment-02 extraction; compare original source/PNG bytes with hashes; assert last VFR PTS becomes the first input, CFR first becomes the end input; compare complete recorded continuity with frozen request envelope after recovery. |
| Human draft survives stale agent writes/submission | Direct service and real HTTP 409 tests; fresh PG connection verifies surviving prompt. `ui.test.ts` executes actual UI JS against the HTTP service and proves unsaved text/base revision survive a passive refresh and conflict. |
| Server-owned allowance/authority; artifact-bound review | First look is decoded and hashed, inspection binds actor + exact plan hash + artifact, server alone creates grants. Zero reserved units before acceptance, exactly one after. Edits revoke dependent grants; a real worker then returns `GRANT_UNAVAILABLE` with zero fixture-provider submissions. Repeated approval is rejected. |
| Inspect real output; explicit take selection | Actual MP4 downloads pass through original byte intake into real import/take rows. First-look inspection cannot stand in for take inspection, another actor cannot reuse that inspection, and stale selection revision conflicts. No selection on result arrival. |
| First-look review of an imported artifact | `ui.test.ts`: after changing the plan, inspect a real imported take, check that the visible review candidate points to that take, approve through actual HTTP, then independently read the frozen artifact ID/hash from PG. Switching back to the prebuilt first look changes the displayed candidate too. |
| Immutable export/selection revision | `export.test.ts`: real FFmpeg process held at a deterministic input-pipe barrier, both selection and draft edited while it is alive, fresh PG snapshots show stale=true and identical frozen JSON/hash. SQL rewrite rejected. Completed export's decoded pixels match the originally selected take, not the newer one. |
| Integrated interruption, not a new attempt/reroll | `recovery.test.ts`: actual worker SIGKILL at `reply` before observation commit and at `bytes` before SQL take publication. Resume through the same pg-boss job and unchanged activation/epoch-fenced engine. One attempt, reservation, queue job, provider job and submission; two distinct imported take rows; no automatic selection. |
| Evidence separated from actual LLM usability | This file and README distinguish adapter/DOM/PG/interruption/media proof. **No new LLM evaluation was run.** |

## Measured media

Two fixed owned six-frame **192×108 H.264 MP4** derivatives, independently FFprobed and fully decoded:

| Output | Bytes | SHA-256 | Decoded frame PTS (timebase 1/12800) |
|---|---:|---|---|
| `output-0` | 3050 | `6ad24120285ed8533d81ede0b39eb5745bcad3640fdd9e6011a67b2029b8e4f9` | 0, 512, 1024, 1536, 2048, 2560 |
| `output-1` | 3224 | `44342f3e19ca1e6a65f7b2470283fbc0ef5ce8c5f3921ac237ba5015a48e1318` | 0, 512, 2048, 2560, 5120, 6144 |

Both fit the unchanged 4096-byte limit. Their derivative clock does not replace the original source clock: the continuity first reference remains VFR ordinal **5**, PTS **5480 × 1/1000**, source time **137/25**, relative time **12/25**, from requested range **[5, 5.52)**. End input is CFR ordinal **0**, PTS **0 × 1/1000**. RGB, PNG-file and source-file hashes remain separate.

## RED → GREEN observations and controls

Slices were run before implementation: missing owned-media preparation; missing command service; unsupported first-look inspection; missing owned-media provider/recovery adapter; missing export command; missing HTTP adapter; missing demo launcher. Each was exercised again after implementation.

Additional observed regressions were fixed and retained separately under ignored `output/`: duplicate approval minted extra review records; accepted HTTP replay incorrectly launched an empty worker; an editor could approve unsaved text/advance its write fence; imported-take review displayed the wrong candidate; switching candidates left the old preview. Their RED and GREEN logs remain separate.

A proposed export schedule based on FFmpeg progress failed honestly: a tiny stream-copy emitted only `progress=end`, after process exit. It was replaced by a real child-process/input barrier, not a race sleep or simulated exporter. Full decoded-output comparison and process-liveness assertions remain in the test.

The six isolated mutations remove: project membership, revision fence, human review capability, inspection ownership, export stale invalidation, and snapshot immutability. All fail at explicit behavioral assertions. No source mutation is left in the working implementation.

## Cleanup and environment failure

Each test registers cleanup immediately after acquisition; independent failures cannot skip other resources. The helpers check postmaster PID death and directory absence. The demo test additionally checks demo PID death, stopped HTTP listener and removal of session/readiness files. After the final suite, all nine directly printed test cluster roots were independently rechecked absent; the demo's separately owned cluster is checked inside its subprocess test. Both interruption tests independently check the killed worker is gone.

An initial **background** original-regression run inherited macOS's native temporary directory instead of the foreground scratch setting. Its nested quote-path had a 101-byte socket path, so the length guard fired before the expected character guard (10/11 runner tests; later `&&` stages did not execute). Source and expected assertions were left unchanged. All printed failed-run cluster roots were absent and no matching postmaster remained. Exporting the intended owned short scratch and PostgreSQL binary path explicitly made the **entire** original verify + both mutation chain succeed. The failure summary is retained in ignored `output/failed-background-regression.txt`, separate from the successful run.

## Verdict

The bounded mechanical workflow is supported by real execution and negative controls, with no changes to proven 01/02 contracts. The human surface is plain, source-backed, and DOM/HTTP exercised. **Independent visual/browser interaction and code review remain parent-review gates**; DOM assertions are not a screenshot or playback test. No MCP, production authentication, arbitrary media intake, private upload, live model/provider output, monetary spending, provider-process disaster recovery, or interrupted-export restart is claimed. No author approval, merge, or issue closure is part of this submission.
