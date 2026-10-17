# Foundation blueprint

**Architecture proposal · research-backed · not implemented**

The stack and agent-first direction are selected. The contracts and sequencing below are proposed refinements for review. They do not authorize installation, paid generation, or deployment. Read this with [the product spec](SPEC.md), [shared language](../GLOSSARY.md), and [agent-first direction](AGENT-FIRST-DIRECTION.md).

## 1. The standard we are aiming for

A creator and a director agent work on the **same durable creative project**. Either can inspect intent, configure supported controls, prepare an exact request, obtain scoped authority, generate alternatives, inspect real outputs, and make reversible editorial choices.

Maintainability means that a change to one model does not rewrite the project model; a browser reload does not lose work; a retry does not disguise another charge; a new UI does not bypass validation; and a media optimization cannot silently change which frame was used.

We will protect these properties with boundaries, constraints, and executable acceptance tests—not with a large framework collection. We do not need microservices, event sourcing, a graph database, a new agent runtime, or an arbitrary workflow engine to establish them.

## 2. The core distinctions

| Concern | Editable or durable truth | What it must not be confused with |
|---|---|---|
| Director plan | Editable brief, shot intentions, dependencies, and proposed operations with a revision | Chat transcript, spending authorization, or completed work |
| Director run/step | Durable membership, pinned inputs, command/attempt receipts, pause reason and resume position | A separate agent-owned project store or a replacement LLM runtime |
| Shot draft | Saved but editable prompt, controls, bindings, and selected route | A previously submitted request |
| Generation specification | Immutable resolved creative intent, source revisions, prepared inputs, and versions | Provider wire format or current UI state |
| Submission envelope | Private exact request reconstruction material and adapter/account scope | Redacted logs or a newly rebuilt body on retry |
| Review | A server-owned handle binding a frozen spec/envelope to reviewed dependencies | A reusable permission to spend indefinitely |
| Approval grant | Trusted, scoped authority with actor/effect/input/expiry/count/budget limits | An agent-written `approved` field |
| Generation attempt | One authorized execution identity and its remote/local recovery state | A queue delivery, status poll, or creative take |
| Take | An owned alternative and its provenance | Automatic selection of the newest result |
| Sequence/edit | Reversible selection, ordering, and timing decisions over particular takes/assets | Destructive changes to source bytes |

An attempt can have repeated worker deliveries and multiple output artifacts. Different deliberate attempts may produce identical bytes without becoming the same take. A recipe is reusable; its historical version and the specification used by an old attempt do not change when a new draft is edited.

## 3. Module ownership and dependency rules

Retain the selected modular TypeScript application and separate API/worker entry points. No additional deployment service is selected here.

| Boundary | Owns | Forbidden responsibility |
|---|---|---|
| `packages/domain` | Browser-safe types/Zod command contracts, pure validation/transition rules, prompt composition, spec versions | React state, SQL, queue calls, network, secrets, FFmpeg |
| `packages/capabilities` | Exact route/model/recipe capabilities, evidence/freshness, role/combination validation | Guessing support from a name; changing old specs |
| `packages/providers` | Versioned translation and bounded submit/status/cancel/output-resolution operations | Creating business attempts, waiting indefinitely, importing media, selecting takes |
| `packages/media` | Inspection, frame extraction, typed preparation/export, owned-storage boundary | Spend decisions, arbitrary shell/filtergraph execution, current-shot mutation |
| `packages/database` | Schema/migrations and named guarded transactions: accept review, record acceptance, publish import, select take | Long external calls or unrestricted CRUD that bypasses invariants |
| `apps/server` | Verified actor/scope, shared command handlers, read projections, HTTP and proposed MCP adapters | Long-running generation/media processing; agent-only privileged logic |
| `apps/worker` | Thin phase coordinators using durable checkpoints and shared transition guards | A second domain model or treating delivery count as generation history |
| `apps/web` / `packages/ui` | Draft editing, previews, comparison, explanation and truthful server state | Secrets, spending authority, canonical job state |

**Enforcement to implement:** browser-safe packages have no Node/SQL/provider-runtime imports; external DTOs are explicitly projected rather than serialized database rows; provider adapters cannot write the database; command handlers do not spawn FFmpeg; worker code cannot mutate shot selection as a side effect of generation completion. Add automated import-boundary/cycle checks and keep a small public export surface for each package.

If server and worker later duplicate orchestration, extract the specific shared use case. Do not create a generic service/repository/plugin layer merely to satisfy a diagram. Each new abstraction should remove demonstrated duplication or isolate a real variation point.

## 4. Agent-ready is the application boundary

The director is a client of project operations, not an alternate application hidden behind chat. The human UI and the proposed MCP adapter call the same commands with server-verified actor context.

| Effect | Proposed operation family | Guard |
|---|---|---|
| Read | Inspect project/plan/draft/attempt; list capabilities/takes/assets | Ownership and pagination; no hidden mutation |
| Plan | Propose or revise a shot plan and dependencies | Expected plan revision; no implicit generation |
| Configure | Save draft; bind role-specific references; change a selection | Expected draft/selection revision and explicit patch semantics |
| Local media | Inspect, extract a frame, prepare a preview/input | Typed profile, owned inputs, resource policy, expected binding revision |
| Review | Validate/resolve a spec; inspect effective prompt/inputs/cost state | Complete immutable dependencies; unknowns remain visible |
| Execute | Submit an approved review or bounded approved plan step | Server grant, exact inputs/route/actor, allowance reservation |
| Recover | Read/resume existing attempt; retry retrieval/import | Same identity and phase; no fresh generation key |
| Edit/deliver | Select a take, apply a sequence edit, export | Separate allowed effect and revision preconditions |

Tool schemas, structured results, effect classifications, error codes, and permitted next actions derive from these contracts. Exact MCP transport/authentication and the initial director client remain implementation decisions. Do not expose direct SQL, arbitrary provider requests, shell commands, or mutable browser objects as the director API.

The director's context includes a bounded project digest, plan/shot revisions, explicit references, capability blockers, attempt states and relevant visual artifacts. Supply contact sheets or sampled frames with source times and measured properties; do not substitute a text description for actual visual review. Preserve director observations separately from measured media facts and human acceptance.

A useful loop is **brief → plan → configure → prepare/review → first-look take → approved remainder → inspect/revise/select → frozen export**. Not every step requires an individual human confirmation: a trusted grant may cover an exact multi-shot plan or bounded policy. The server, not agent memory, enforces the scope. An embedded director and external agents can share this boundary; no runtime replacement is selected.

The director should use versioned production context and step receipts, not replay an entire conversation to infer completion. Bound planning-model/tool iterations independently from media spend. Store concise proposals, decisions and action results—not hidden model reasoning. A first-look review of an actual intended take is the proposed default before a large run. Slop Cannon documents this staging and per-scene recovery, but our server records remain authoritative across all clients.[67][68]

A run pause blocks new submissions while already accepted work remains reconcilable. A run finish requires an owned deliverable or an explicit stopped/blocked outcome, not merely an exhausted loop. Exact integrated director presentation and runtime remain open; the shared command boundary must exist from the first vertical slice.

## 5. Prepare, freeze, authorize, execute

### Proposed baseline ordering

1. Save the draft using an expected revision. Incomplete or currently incompatible creative intent is saveable. Apply each command patch atomically after structural/ownership checks; return compatibility blockers separately, without silently clearing intent. If an operation deliberately allows partial application, its contract must expose exact committed changes and a fresh revision.
2. Prepare locally: resolve reference revisions, extract selected continuity frames, create required input representations, validate combinations, resolve defaults, and compose the effective prompt.
3. Freeze a `GenerationSpec` and private `SubmissionEnvelope`. Review shows exact prepared inputs, any crop/timing changes, effective controls, model/route identity, and known/unknown cost.
4. Obtain or verify a trusted approval grant for the reviewed inputs/effects. External transfer during preparation requires its own permitted scope; “validate” must not hide an upload or paid operation.
5. In one short database transaction, consume the review, record the command receipt and attempt, reserve the applicable allowance, and enqueue initial work through the transaction-bound pg-boss adapter.
6. A worker rechecks dispatch authority, persists dispatch intent, performs one bounded provider operation, and records acceptance or uncertainty before scheduling the next phase.

The pg-boss documentation exposes a Drizzle transaction adapter; this supports the design but is not proof of compatibility for our eventual pinned dependency set. Its enqueue operation can return no job when a policy suppresses insertion, so a successful return without an accepted job identity is not sufficient.[28][35] Prove commit and forced rollback against real PostgreSQL before claiming atomic enqueue.

Resolve defaults and normalization before review. Zod's ordinary object parsing and Fastify's baseline validation have behavior that can strip, coerce or default fields; select and test one explicit runtime integration so validation cannot silently change reviewed creative intent.[31][33]

### Approval is data with authority, not model prose

A grant binds the approving principal, permitted actor, project scope, exact review/spec or bounded policy, route/account, immutable media/transfer scope, effects, expiry, attempt count and budget policy. Reserve allowance atomically. An accepted command replay returns its original attempt without consuming the grant again.

An unknown estimate is not zero cost. If a hard monetary ceiling is required but no safe upper bound is known, hold execution; any count-only exception must explicitly disclose unknown monetary exposure. A local reservation is not a guarantee about a provider's eventual billing. Do not release it merely because the agent disconnects or cancellation is requested.

A revised plan is not covered automatically by an old approval. A queued operation whose authority expired or was revoked is held before dispatch. Reconciliation of already accepted work remains distinct from authorization to create new work.

## 6. Durable execution and recovery

Use domain attempts as the authority; pg-boss is the delivery mechanism. Queue retention, retry counters, and worker completion do not determine creative history.

| Durable fact | Examples | Required behavior |
|---|---|---|
| Remote knowledge | Not dispatched, acceptance unknown, queued, running, succeeded, failed, cancelled | Preserve raw evidence and normalize per exact provider contract |
| Local availability | Retrieval pending, downloading, import pending, ready, unavailable | Remote success does not imply a usable owned file |
| Cancellation intent | Requested, prevented before dispatch, remote confirmed, too late, unresolved | Local abort is not remote cancellation |
| Recovery/attention | Due action or explicit hold with reason | Every nonterminal attempt has a next action or an explained hold |

Keep three independent deduplication identities: **command/review**, **provider attempt key**, and **remote output import key**. Neither a spec hash nor a media hash can replace all three. New deliberate attempts are allowed to reuse a spec.

Provider acceptance can occur before our process records the reply. Persist dispatch intent and the original replay material first. Prefer a known remote-handle lookup; use same-key replay only within the provider's verified scope and replay window. Same-key replay during unknown acceptance can create previously unaccepted work: recheck current dispatch authority, including run pause, revocation, expiry and cancellation, before permitting it. Read-only reconciliation of a known remote handle is not a fresh generation submission. Unknown/expired scope, changed account/body, or unavailable replay material creates a visible hold—not a new key.

Guard worker transitions with the current phase/version/owner. A stale worker cannot overwrite current state, but a late valid acceptance receipt must be reconciled rather than discarded. An old running poll cannot regress a succeeded attempt. Keep database transactions short; never hold them across provider calls, downloads, or media work.[34][39]

**Cancellation race:** if cancellation wins before dispatch authorization, prevent submission. After dispatch authorization, continue reconciliation. If acceptance is unknown and cancellation has been requested, do not replay a request-creating POST solely to obtain a cancel handle. A late successful output may still be useful and billable; import it as an unselected alternative.

## 7. Owned media, time and continuity

Media identity must survive UI and provider behavior. Retain immutable bytes/revisions, selected stream IDs, inspection coverage, prepared input hashes, and the exact transformations used. Signed URLs are temporary locators; a thumbnail/proxy is not the source.

FFmpeg distinguishes presentation timestamps and timebases; average/nominal frame rates do not identify arbitrary frames.[46][47] Seeking is not proof of exact selection.[42][43] Proposed contract: lossless integer tick values plus rational timebases, a declared common source clock, half-open ranges, and named selection rules. Browser time is useful interaction input, not authoritative source-frame evidence.[49]

For continuity, store the selected take/source revision, requested time, actual decoded frame identity/time, extracted image revision and profile/tool version. Extracting the last frame requires identifying the last eligible presented frame, not `duration - 1/fps`. A late extraction must compare the binding revision before attachment. Changing the selected prior take never rewrites an old continuity link.

Separate generation-audio intent from edit/export policy. Source audio preservation includes chosen streams, offsets, ranges and any permitted retiming; it is not just `generateAudio:false`. Keep source bytes and soundtrack unless explicitly replaced. Reject or visibly resolve output-duration mismatch before application.

**Import protocol:** claim a stable remote output identity → download to bounded private staging → inspect/hash → publish immutable bytes → transactionally publish asset/take linkage. A crash between storage publication and metadata commit must recover that identity. URL refresh cannot create another take. Two different attempts producing equal bytes retain separate provenance.

Prepared inputs and continuity stills are retention roots, not disposable caches. Temporary objects and proxies can be cleaned only under a reference-aware, active-job-aware policy. Metadata and media backups form one recovery problem; restoring a database does not undo remote provider work.

## 8. Capabilities and recipe contracts

A capability record is keyed by **channel + route + model + recipe/schema version**, not a friendly model name. Distinguish accepted inputs/combination rules, account availability, and control meaning (`native`, `prompt_guidance`, `unsupported`, `unknown`).

Drafts preserve incompatible intent. A model change returns conflicts and explicit repair options; it cannot silently drop references, demote first/last frames, or reassign source video. Reference bundles expand to actual inputs and guidance before counting limits and freezing review. Names/tags resolve to stable revision-bound IDs; later rename/archive changes do not rewrite history.

Keep recipe authoring separate from recipe use. Initially use reviewed, versioned recipes with named stages and outputs; do not create a generic graph interpreter. Expose meaningful stages, reuse versus rerun decisions, and spending consequences. Node wiring may remain internal or an optional later view, without hiding model identity or required advanced controls.

## 9. Security, observability and release discipline

Treat uploads, provider output URLs, metadata, workflow definitions and model/tool output as untrusted. Centralize bounded media intake and URL resolution/redirect policy. Keep authenticated provider calls distinct from unauthenticated downloads; reject private-network destinations and path escapes. Uploaded MIME and file names are not proof of safe content.[56][57]

Run FFmpeg/ffprobe with typed operation profiles, fixed executable/argv, no shell, bounded output, process lifetime and OS/container resource limits, and a restricted filesystem/network environment. Process cancellation is not complete until termination and stream closure are observed.[55] A protocol flag is not a filesystem sandbox.

Persist causal identities: initiating principal, acting agent, command, plan/review/grant, spec, attempt, provider request, media operation, output and edit. Keep prompts/private media in authorized project storage, not generic logs. Emit safe structured diagnostics and distinguish remote outcome, local readiness and artistic acceptance.

Version API/queue payloads, specs, composer, adapter and media profiles separately. Use reviewed ordered migrations and one migration owner. Preserve in-flight old adapters/decoders or hold unsupported work visibly; do not reinterpret old requests with new defaults. Begin with coordinated API/worker upgrades rather than premature zero-downtime complexity.

## 10. Small vertical slices with proof obligations

| Slice | Useful result | Proof before moving on |
|---|---|---|
| 1. Command contract | UI and agent can inspect/configure the same shot and preserve first/last frames | Caller-parity, strict parsing, conflict, permission and redaction tests |
| 2. Exact media preparation | Import/inspect owned media; extract and bind a real frame | Actual timestamp/hash evidence, stale-binding race, browser preview and bounded process tests |
| 3. Reviewed attempt | Frozen spec/envelope, trusted grant, transactional attempt/enqueue | Real-DB commit/rollback, concurrent submit/reservation and replay tests |
| 4. Provider recovery | One actual Comfy generation becomes an owned unselected take | Separately authorized live call plus injected lost-response/restart/cancel/import failures; no fresh key on recovery |
| 5. Director loop | Plan shots, review actual outputs, revise within granted scope, select explicitly | End-to-end agent and human traces; budget exhaustion, interruption and concurrent human edits |
| 6. Continuity and bounded assembly | Reuse a recorded prior-take frame; edit/select/export a frozen sequence or slice | Source/time/audio fidelity, reversible edit/reopen, export verification |

All are future acceptance requirements. No runtime fixture, application test, media operation or provider integration is claimed complete by this document.

## 11. Decisions to confirm before implementation

- **Product + engineering:** prepare before final spending review; single-use generation review and a scoped grant with atomically reserved allowances.
- **Engineering:** compatible pinned versions and real-DB Drizzle/pg-boss integration; actual queue/worker policy budgets.
- **Product + engineering:** initial director client and MCP exposure/authentication, without changing the selected app stack.
- **Product:** permitted autonomy, monetary/count limits, transfer scope, and conditions for automatic take selection/export, if any.
- **Media owner:** initial supported input envelope, exact frame/range rules, codec/browser matrix and FFmpeg build/license.
- **Product:** timeline depth, retention/deletion behavior, and hosted authentication/storage choices. These remain open, not silently excluded.

A decision earns a dedicated record when it is costly to reverse and has a real trade-off. The architecture is successful when these contracts are easy to find and tests prove them—not when the diagram contains the most boxes.

## Sources

[28] https://pgboss.io/api/adapters
[31] https://fastify.dev/docs/latest/Reference/Validation-and-Serialization
[33] https://zod.dev/api
[34] https://www.postgresql.org/docs/current/transaction-iso.html
[35] https://pgboss.io/api/jobs
[39] https://www.postgresql.org/docs/current/explicit-locking.html
[42] https://ffmpeg.org/ffprobe.html
[43] https://ffmpeg.org/ffmpeg.html
[46] https://ffmpeg.org/doxygen/trunk/structAVFrame.html
[47] https://ffmpeg.org/doxygen/trunk/structAVStream.html
[49] https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
[55] https://nodejs.org/api/child_process.html
[56] https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
[57] https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
[67] https://slop.cc/.well-known/skills/slopcannon-music-video/SKILL.md
[68] https://slop.cc/.well-known/skills/slopcannon-music-video/references/company-integration.md
