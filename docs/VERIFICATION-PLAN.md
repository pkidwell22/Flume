# Foundation verification plan

**Acceptance requirements only. Application tests and media fixtures are not implemented or run.**

This plan turns the [foundation blueprint](FOUNDATION-BLUEPRINT.md) and [architecture-transfer checklist](ARCHITECTURE-TRANSFER.md) into proof obligations. Research citation/hash checks verify the evidence corpus—not application correctness.

## Evidence levels

| Level | What it proves | What it does not prove |
|---|---|---|
| Documentation/static inspection | A documented contract or captured code path exists | Live authorization, output quality, billing or recovery |
| Pure contract tests | Parsing, composition, transitions and identity under fixtures | Database atomicity, media decoding or provider behavior |
| Real isolated infrastructure tests | Actual PostgreSQL/pg-boss transactions, races and storage recovery | Remote provider idempotency or artistic success |
| Actual owned-media tests | Measured frame/timing/audio behavior for the pinned build/profile | All formats, browsers or model outputs |
| Separately authorized live generation | Exact route/account/input/output path worked in the tested case | General model fidelity, universal reliability or unbounded scale |
| Human creative review | A named person accepted a particular artifact for the brief | Technical timing/security correctness or automatic approval of future outputs |

Every test result records code/dependency versions, fixture identities, environment, actual outcome and retained evidence. Never mark a fixture case passed from a design trace. A provider stub records HTTP calls, idempotency keys, remote identities and side effects separately; counting queue jobs cannot establish absence of duplicate generation.

## A. Contracts and creative intent

**Owner:** domain/capabilities and command-boundary implementation. **Tools:** Vitest, shared schemas and import-boundary checks.

| ID | Scenario | Required result |
|---|---|---|
| V01 | First-only, last-only, paired and no-frame drafts across representative route contracts | Exact roles transmitted where supported; unsupported combinations held before transfer/spend; draft retained. |
| V02 | Same asset bound as first frame and a soft reference; bundle exceeds route input count | Bindings remain distinct; expanded input budget and conflicts are explicit, not silently deduplicated or truncated. |
| V03 | Model switch removes support for a populated control | Complete user intent survives; a precise conflict blocks submit, with no role conversion. |
| V04 | Prompt composition with camera, identity context and explicit false/zero/unset values | Reviewed prompt and effective controls equal submitted semantics; camera text appears once. |
| V05 | Rename/archive/edit a reference bundle after a take exists | Historical source revisions and prompt remain unchanged; new drafts resolve deliberately. |
| V06 | Structurally invalid command or future schema field | Explicit error, not silent stripping/coercion; invalid-but-editable drafts use a distinct save contract. |
| V07 | Configuration encounters a later asset/role failure | Atomic patch leaves prior state unchanged, or a deliberately specified partial-result contract identifies exact committed changes. No hidden partial mutation. |
| V08 | Browser import graph or provider adapter attempts forbidden dependency | Automated boundary check rejects SQL/secrets/Node in browser contracts, provider DB writes, and unexpected cycles. |

## B. Transactions and durable execution

**Owner:** database/provider/worker implementation. **Tools:** disposable real PostgreSQL, pinned pg-boss/Drizzle, controlled provider stub, fault injection. No live database is a test fixture.

| ID | Scenario | Required result |
|---|---|---|
| V09 | Attempt insert succeeds but enqueue throws or is suppressed | Entire command transaction rolls back; no accepted attempt without required work. |
| V10 | Two commands consume one review, including different client command IDs | At most one attempt and allowance reservation; other caller recovers the same identity or receives an explicit already-submitted conflict. |
| V11 | Submit API response is lost after transaction commit, then draft changes | Authorized replay returns the original receipt/attempt; newer draft does not create a replacement. |
| V12 | Worker crashes before send versus after provider acceptance | Both retain uncertain dispatch state where appropriate; safe recovery uses original envelope/key or holds. No invented no-dispatch assumption. |
| V13 | Old worker returns after claim recovery or a newer success poll | Stale mutation is fenced; valid late acceptance evidence is reconciled; status never regresses. |
| V14 | Cancel wins before dispatch, after dispatch, or during unknown acceptance | Correct branch: prevent, request/reconcile, or hold. Unknown acceptance plus cancel never triggers blind POST merely to get a handle. |
| V15 | Two imports race; crash occurs after byte publication before SQL commit | One remote-output linkage/take; safe adoption of published bytes; different hashes under one identity cause a hold. |
| V16 | Expired URL, partially imported outputs, missing credentials, or exhausted queue retries | Retry only the safe existing phase; retain successful portions; visible due work or hold; no automatic paid reroll. |

## C. Actual media and editorial correctness

**Owner:** media/storage implementation. **Tools:** pinned FFmpeg/ffprobe, owned synthetic or explicitly licensed files, measured decoded outputs and visual/listening checks.

| ID | Scenario | Required result |
|---|---|---|
| V17 | Variable frame rate, nonzero origin and constant positive playback rate | Source-clock mapping and actual decoded frame identity match the oracle; no FPS-derived frame guessing. |
| V18 | First/last/custom frame extraction with boundary, equal-PTS, gap or corrupt-tail cases | Named selection rules; actual timestamps; ambiguity/incomplete EOF is not reported as exact success. |
| V19 | Source/first-frame binding changes while extraction runs | New binding wins atomically; stale result cannot overwrite it; prior frozen continuity remains intact. |
| V20 | Proxy changes cadence, geometry or origin | Explicit source mapping; worker-confirmed frame preview before binding; proxy deletion cannot destroy retained inputs. |
| V21 | Audio/video offset, trim, generated audio, speed or output-duration mismatch | Common-clock alignment and explicit audio policy; no silent soundtrack/neighbor changes; ambiguous apply is blocked. |
| V22 | Malformed/huge media, hostile filename/URL/redirect/protocol, stuck process | Intake rejects or bounds work; no secret forwarding/private-network fetch/path escape; process slot released only after termination. |
| V23 | Storage restart, cleanup race, missing bytes, or duplicate derivation | No ready metadata before verified publication; retained references and active work protect media; missing output becomes unavailable. |

**Fixture families to create, not existing assets:** simple constant-rate clip with a known frame pattern; VFR/nonzero-origin clip; repeated/missing timestamp cases; audio/video impulse alignment; rotated/non-square-pixel media; multiple-stream/cover-art input; truncated/corrupt tail; oversized/malformed inputs; and source/proxy pairs with an explicit mapping. Hash every fixture and its expected measurements. Security fixtures must run inside a verified isolated environment.

## D. Agent director and human intervention

**Owner:** shared command service, proposed MCP adapter, director integration and React review UI. **Tools:** deterministic command client plus a real agent client for separate usability evaluation; Playwright for human interactions.

| ID | Scenario | Required result |
|---|---|---|
| V24 | Equivalent human and agent operation | Same structural/domain/authorization checks and durable records; no privileged agent-only bypass. |
| V25 | Imported text/tool output claims approval or asks to widen spend/transfer | Treated as data; only trusted server authorization grants effects. |
| V26 | Concurrent agent commands exhaust one allowance | Atomic reservations prevent oversubscription; replay consumes nothing twice; uncertain exposure is not prematurely released. |
| V27 | Plan/reference/route/actor changes, run pauses, grant is revoked, or approval expires before dispatch or unknown-acceptance replay | Recheck dispatch authority before any replay that could create work; hold without new submission. Known-handle read-only reconciliation remains distinct. Old grants cannot cover changed intent. |
| V28 | Human edits during planning, generation or output inspection | Revision conflict preserves human input; late take stays an alternative; new plan/selection is not overwritten. |
| V29 | Director loses session after issuing a mutation | Resume from durable command/run/attempt IDs; missing chat output does not start new work. |
| V30 | First-look gate, partial batch failure and bounded remaining work | One identified real artifact is reviewed; remaining membership survives restart; only approved steps proceed; failures target affected work. |
| V31 | Agent critiques or recommends a take | Distinguish measured technical facts, model judgment and human acceptance; recommendation is not selection authority. |
| V32 | Human changes selected takes while export runs | Export retains frozen cut/audio/caption revision and is marked stale relative to the current workspace; never ambiguous “latest”. |

The director evaluation should use a fixed brief and owned media, record tool/action receipts and bounded model budgets, and assess whether it finds correct operations and recovers safely. Do not persist hidden model reasoning as the project record. A polished conversation is not evidence that the director used correct frame roles or stayed within authority.

## E. Compatibility, delivery and real integration

| ID | Scenario | Required result |
|---|---|---|
| V33 | Upgrade with an accepted job, pending cancel, partial import and old frozen spec | Compatible version dispatch or visible unsupported-version hold; no rebuilding old requests from today's defaults. |
| V34 | Restore metadata/media backup after later remote work existed | Automatic submissions paused during uncertain-window reconciliation; restore never implies remote rollback. |
| V35 | Fresh local setup and actual supported-browser playback/seek | Documented setup works without undisclosed credentials/services; real media loads/plays/seeks with useful errors. |
| V36 | Authorized first/last-frame generation through the exact selected Comfy route | Actual request roles, provider receipt, owned playable output and measured properties recorded; no claim of pixel-exact conditioning without comparison. |
| V37 | Authorized source-video edit and recovery | Uses the temporal source, not a still fallback; actual output/audio/timing inspected; retrieval recovery does not regenerate. |

No live test proceeds without approved media-transfer and spending scope. Exact dependency versions, runtime limits, route entitlement and cost ceilings must be established before those gates—not guessed from documentation snapshots.

## Release acceptance

The foundation is not ready merely because a happy-path clip renders. Before calling the first vertical slice reliable, require relevant pure tests, real database/queue atomicity and race tests, actual-media validation, browser reload/conflict behavior, human/agent caller parity, and one separately authorized exact-route round trip. Report each evidence level separately.

Do not implement all optional editor/media features to satisfy this matrix at once. Keep unsupported paths explicitly unavailable, and run the cases for every enabled operation. The matrix defines non-negotiable correctness properties as scope grows; it is not permission to expand the initial product silently.
