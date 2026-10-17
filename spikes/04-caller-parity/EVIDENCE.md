# Execution evidence and constrained verdict

## Observed gates

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
