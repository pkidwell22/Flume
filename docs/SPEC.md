# Comfy creative studio — architecture-transfer spec

**Draft 0.4 · Stack and agent-first direction selected · Foundation refinements proposed · Not implemented**

## 1. Direction

We are building a **new creative-production application**, informed by the best architecture and controls in Patrick's Studio project. We are not extending its Swift app, translating its source line by line, or requiring its native runtime.

**Confirmed direction:** transfer Studio's canonical generation model, first/last-frame controls, role-based references, shot continuity, model-aware controls, project assets, provenance, and non-destructive selection of takes. Do not reduce the product to a prompt box and a model dropdown.

**Agent-ready first:** an agent can act as a creative director over the same project, shot, reference, generation, review, and edit operations as the human workspace. This is a foundation requirement, not a later chat add-on. Slop Cannon's director model is a research reference; its production architecture is not assumed. See [agent-first direction](AGENT-FIRST-DIRECTION.md).

**Selected implementation:** a TypeScript web application with React/Vite, Fastify on Node.js, PostgreSQL/Drizzle, pg-boss background jobs, and FFmpeg/ffprobe media processing. Patrick approved recording this stack in the spec. It is designed to run locally and support a hosted demonstration; nothing has been installed or implemented. No Swift, AppKit, AVFoundation, App Store, or macOS-only dependency is required.

Working name: **Comfy creative studio**. The repository is `pkidwell22/comfy-creative-studio`; the final public product name remains open. Studio is the architectural reference, not necessarily the new product name.

The [foundation blueprint](FOUNDATION-BLUEPRINT.md) proposes the detailed ownership and recovery contracts; [competitive lessons](COMPETITIVE-LESSONS.md) explains the evidence behind them. The [verification plan](VERIFICATION-PLAN.md) defines proof obligations. These proposals refine this spec without claiming implementation or silently deciding the remaining product scope.

## 2. The architecture we transfer

| Studio decision worth keeping | Contract in the new project |
|---|---|
| Canonical generation spec separate from provider payload | Store creative intent in a versioned, provider-neutral `GenerationSpec`; adapters alone produce model-native request bodies. |
| Distinct user prompt and composed prompt | Keep editable wording separate from the exact submitted prompt. Show the actual composition and retain its version. Never append camera/context instructions twice. |
| First/last frames are not ordinary references | Give start and end frames explicit asset bindings and dedicated controls. Never downgrade a frame binding to soft image guidance silently. |
| References have meaningful roles | Preserve general, character, setting, prop, style, brand, mask, annotation, and audio roles in project data. Map only supported semantics to each route. |
| Continuity is an asset relationship | Record source shot/take, source media revision, frame timestamp, and the extracted frame asset used for the next shot. |
| Capabilities drive available controls | Duration, resolution, aspect ratio, frame combinations, references, seed, and audio come from the selected model/route's verified contract. Unsupported and unknown are distinct. |
| Media and edit decisions are separate | Durable metadata references owned media; browser player/rendering objects are transient. A sequence/timeline model must not depend on a particular rendering engine. |
| Generation produces project artifacts | Results become reusable takes and assets with provenance, not transient URLs or chat attachments. |
| Non-destructive changes | A generated alternative never replaces the source automatically. Selecting/applying a take is an explicit, reversible project action. |

Source basis: Studio commit `867afa9c57f795bbe70a1195a2cdd5e4c4a053bd`, especially `ProductionGenerationModels.swift`: canonical spec at 732–758, prompt composition at 1127–1191, continuity at 1822–1841, video controls at 1844–1869, and reference roles/semantics at 2592–2657. These are source observations, not a new-app implementation claim.

**Do not transfer the weaknesses:** existing Studio Retry creates a new generation; reopen does not resume accepted provider work; the adapter returns only after terminal completion; import lacks remote-output deduplication; partial-range edit grouping is not durable across reopen. The new architecture must distinguish recovery from new generation from the beginning. See [research provenance and limitations](PROVENANCE.md).

## 3. Creative-control requirements

First/last-frame controls and continuity are core requirements, not optional polish. Support is evaluated per model and per combination of controls; this does not promise that every model accepts every input.

| Control | Required product behavior | Acceptance check |
|---|---|---|
| First frame | Attach an uploaded image, library asset, or extracted video frame as an explicit start frame; preview, replace, and clear it. | Submitted adapter payload uses the route's actual first-frame field/role; asset identity survives reload. |
| Last frame | Dedicated end-frame binding, independent of the start frame. Show when end-only or start+end is unsupported. | Compatible routes transmit the correct end-frame role. Unsupported combinations block before spending, without discarding the draft. |
| Previous-shot continuity | “Use frame from previous take” creates a durable extracted image with source time/revision; bind it as a first frame or an explicitly chosen soft reference. | Reopening and reusing the recipe uses the recorded frame, not whichever take is currently selected. |
| Reference assets | Visible roles, previews, counts, and remove/reorder actions where order matters. Distinguish source video from reference imagery. | Swapping model validates the entire reference combination; no silent dropping or role conversion. |
| Duration, ratio, resolution | Model-scoped values and limits; explain when input frames determine geometry. | UI and server reject unsupported combinations consistently; requested and measured output properties remain distinct. |
| Camera movement | Transfer Studio's prompt-guidance semantics: locked-off, dolly, orbit, tracking and similar directions. Preserve order if multiple movements are enabled. | Reviewed composition equals submitted wording. Do not promise deterministic 3D motion. |
| Look, lighting, lens | Model-native controls where supported; otherwise clearly labeled prompt guidance. | No invented provider parameters or claims that a visual selector physically controls a lens. |
| Seed and audio | Preserve supported seed and generated-audio settings, including random/unspecified state. Explain unavailable controls. | Reuse records the exact submitted value; seed does not promise identical outputs across models or versions. |
| Negative prompt / advanced settings | Expose only when supported. Optional advanced provider settings remain separate from the main creative controls. | Typed validation, explicit precedence, and redacted request preview. No arbitrary authenticated destination or reserved-field override. |

Studio calls first/last-frame intent a “hard frame lock”. In this product that means a **dedicated conditioning input**, not a guarantee of pixel-exact provider output. Validate the result and describe the actual model behavior honestly.

## 4. Workspace and user journey

The interface has a project/shot navigator, asset library, central preview/comparison area, creative-controls panel, and generation/take history. These are functional regions, not a frozen layout or a copy of Higgsfield's styling.

1. Create/open a project and shot; import or select references.
2. Choose a model/workflow and inspect its capabilities.
3. Set first/last frames, continuity, references, creative direction, and supported output controls.
4. Review the final prompt, transfer disclosure, validation results, and available cost estimate. An unknown estimate is not zero cost.
5. Submit a take; see truthful queue/running/cancellation state.
6. Download and inspect the output, compare it with the source/reference or another take, then explicitly select it for the shot.
7. Reuse its recipe or extracted frame for the next shot; reopen without losing state; download the owned result.

**Sequencing/timeline:** retain the architecture's separation of shot/sequence decisions from media playback/export. We have not decided to omit a timeline, nor committed to rebuilding Studio's entire NLE. A detailed timeline/editor scope remains a product decision; it must not constrain the provider/job foundation or erase first/last-frame and continuity requirements.

**Video editing/re-shoot:** source video plus an explicit requested change produces a new take. Keep appearance edits, character replacement, camera re-shoot, and motion transfer distinct. A still extracted from a clip is image-guided generation, not video-to-video preservation. Existing camera-preserving edit instructions must not be reused unchanged for a camera-change request.

## 5. Selected stack and system boundaries

| Layer | Selected technology | Responsibility |
|---|---|---|
| Web workspace | React + TypeScript + Vite | Interactive shot controls, references, previews, take comparison, and future editor surfaces. |
| UI primitives and styling | Radix primitives + Tailwind CSS | Accessible interactions with a purpose-built creative-workspace design, not a stock dashboard. |
| Local draft/workspace state | Zustand | Editable draft, selection, panel, and interaction state; not authoritative remote job state. |
| Server-state synchronization | TanStack Query | Fetch/cache/invalidate project, asset, take, and job data. No automatic replay of chargeable submit mutations. |
| API | Node.js + Fastify + TypeScript | Validated project operations, credential boundary, submission and recovery endpoints. |
| Runtime contracts | Zod | Shared domain/API validation; server preflight remains authoritative. Validate external responses separately. |
| Metadata and migrations | PostgreSQL + Drizzle | Project/shot metadata, frozen specs, attempt checkpoints, asset identities, provenance, and reversible edits. |
| Background execution | pg-boss | Durable PostgreSQL-backed generation reconciliation, retrieval/import, and media jobs; no Redis dependency. |
| Media tools | FFmpeg + ffprobe | Authoritative frame extraction, thumbnails, input preparation, output inspection, and export behind a media interface. |
| Generation | Comfy Router and workflow adapters | Translate the frozen domain spec into verified model/workflow contracts. |
| Tests | Vitest + Playwright | Domain/adapter/integration tests and browser acceptance tests. |
| Local runtime | Docker Compose | Reproducible API, worker, PostgreSQL, and persistent media-volume setup. |

PostgreSQL replaces the earlier SQLite proposal. Its local setup is heavier, but it supports the shared web application's concurrent metadata and durable job workload in one database. Media bytes remain outside the database. We are not maintaining parallel SQLite and PostgreSQL implementations.

React/Vite is selected over a server-rendering-first framework because the core product is an interactive workspace. Long-running work belongs to persistent workers, not page rendering, request handlers, or browser-tab lifetime. Electron/Tauri packaging, a separate broker, and a full microservice architecture are not required for the initial build.

### Repository layout

One TypeScript repository with explicit application entry points and shared packages:

```text
apps/
  web/           React workspace
  server/        Fastify API and project operations
  worker/        pg-boss consumers and media processing
packages/
  domain/        Shots, assets, bindings, specs, attempts, takes
  capabilities/  Model/route support and combination validation
  providers/     Comfy Router and workflow adapters
  media/         Frame extraction, inspection, and export
  database/      Drizzle schema, migrations, transactional operations
  ui/            Shared interface components
```

This is one modular application, not independent microservices. The server and worker share the domain, provider, and database code but run as separate entry points so media work does not block API request handling. Browser-safe domain contracts must not import database, credential, Node-only, or FFmpeg code.

### Processing boundaries

```text
Web workspace
  → versioned project / shot / generation intent
  → capability validation + deterministic prompt composition
  → persisted attempt + prepared media
  → server-side Comfy adapter / workflow runner
  → queue reconciliation + result retrieval
  → validated owned asset + take provenance
  → explicit shot selection / sequence edit
  → preview and export services
```

**UI:** React controls and comparisons backed by Zustand drafts and TanStack Query server state. Persist drafts explicitly through the API; a client cache is not the project store. First/last frames, continuity, and references are domain concepts, not component-local contracts. No provider secrets or authoritative job orchestration in the browser.

**Domain:** `Project`, `Shot`, `Asset`, `ReferenceBinding`, `GenerationSpec`, `GenerationAttempt`, `Take`, and reversible edit records. These are proposed new-project contracts, not a promise to copy Studio's SQLite schema or `.studio` format.

**Capabilities:** exact provider/route/model identity, schema version, freshness/evidence, accepted media roles and combinations, limits, and support states. Client controls and server preflight consume the same normalized contract; the server remains authoritative. Unknown capability never means allowed. Preserve unset, explicit false, and numeric zero where meaningful, particularly for audio and seed. Preserve incompatible drafts and ask for explicit changes when switching models.

**Execution:** separate prepare, validate, submit, reconcile, retrieve, and import operations. Fastify validates commands and records durable intent; pg-boss workers execute/reconcile them. Atomically record a new attempt and its queued work in PostgreSQL using a verified transaction integration. Persist checkpoints before provider side effects and immediately after acceptance. Worker retry/redelivery resumes the same attempt: it must not create a fresh provider request or idempotency key. Database transactions do not cover external generation calls; Comfy idempotency and output deduplication remain necessary. Reloading/closing the browser or restarting a worker must not create a second generation. Separate media and provider-reconciliation queues/concurrency so an FFmpeg task cannot starve status recovery.

**Storage:** PostgreSQL metadata accessed through Drizzle, plus a small media-storage interface: persistent filesystem volumes for local operation and object storage for hosted deployment. The hosted storage vendor remains unselected. API and worker must resolve the same owned asset identities; temporary worker paths are not durable references. Prepared media is retained for exact recovery; derived thumbnails/proxies are disposable. Use stable IDs, content hashes, measured media properties, and source provenance. Never use an expiring signed URL as the durable asset. Test database/file crash recovery separately because a database transaction cannot atomically commit a filesystem or object-store write.

**Media:** browser-native playback where sufficient; FFmpeg/ffprobe in the worker provide authoritative extraction, inspection, preparation, and export behind the media interface. Preserve actual decoded frame timestamps and source timebase; a browser screenshot is not proof of the requested frame. Bound subprocess time, memory, concurrency, paths, and accepted media. Pin a compatible FFmpeg build and review its enabled codecs/license before distribution. A hosted edition needs access control, tenant isolation, credential handling, and storage policy verified before exposure; do not publish the local service as-is.

**Credentials:** private server-side secret storage/environment for local operation; no keys in browser bundles, project exports, logs, or public fixtures. Do not require macOS Keychain. Authenticated requests stay on approved Comfy origins, and credentials never accompany output downloads. Validate externally supplied media URLs against private-network access and enforce upload/size/type bounds.

## 6. Comfy routes and frame semantics

### Direct a shot: H3 candidate

The [H3 public schema](https://docs.comfy.org/router-schemas/minimax/minimax-h3.json) describes text/image input, `first_frame`/`last_frame` roles, integer durations 4–15 seconds, and `768P`/`2K` resolution. Exactly one non-empty text item is required. Text-to-video needs an explicit non-`adaptive` ratio; frame-guided generation ignores the ratio field. Keyframe roles and `reference_*` roles are mutually exclusive in that documented request.

The UI must explain those conflicts rather than sending an invalid mixture. Before claiming a particular frame mode, verify it with that exact route; cover first-only, last-only, paired, and neither in contract tests, including rejection of unsupported cases. The product must provide a verified route for the required first/last-frame workflow. If H3 cannot satisfy the required frame workflow, choose another verified Comfy route rather than quietly deleting the requirement.

H3's shared schema includes video fields, but its model-specific input modalities list text/image only. **It is not our evidence for source-video editing.**

### Re-shoot: Aleph 2 candidate

The [Comfy Aleph 2 schema](https://docs.comfy.org/router-schemas/runway/aleph2.json) explicitly declares video input, with required `promptText` and `videoUri`. It accepts data-URI video, enabling a bounded prototype without a new media-hosting service. Do not send `model` in the Router body. Its optional timed keyframes are not automatically equivalent to another model's first/last-frame contract.

Proposed validation: one short, owned source clip, one reviewed edit instruction, one alternate take. Exact input duration/encoded-size checks, source audio preservation, output timing, and visible edit quality must pass. Documentation supports this candidate; no live call has been made. Wan 2.7 Video Edit is a documented alternative with a different media-hosting contract. The [official Comfy Aleph 2 schema](https://docs.comfy.org/router-schemas/runway/aleph2.json) and [Runway input guide](https://docs.dev.runwayml.com/assets/inputs) are the external contract references.

### Shared execution contract

- Enqueue with `POST /v2/models/{provider}/{model}/requests`; persist the **body** `request_id` and returned URLs. Keep HTTP request IDs separate for diagnostics.
- Queue states are `IN_QUEUE`, `IN_PROGRESS`, and `COMPLETED`. Completion with `error_type` is not success. Check the native output shape before importing.
- Persist the attempt and `Idempotency-Key` before submit. Recovery uses unchanged credential/workspace scope, method, path/query, and body. In-flight-key conflicts honor `Retry-After`; non-replayable or changed-request conflicts require review, not a silent new key. A deliberate new take is a separate attempt.
- `PUT cancel_url` acceptance means cancellation pending. Reconcile afterwards; `ALREADY_COMPLETED` requires a status read. A late result can still be billable and useful.
- Separate remote success from download/import success. Retry retrieval/import without regenerating, with a unique import identity per remote output. Expired/unrecoverable results remain clearly unavailable; no automatic paid replacement.
- Public schemas are documentation snapshots. Verify the live account's capabilities and queue access before enabling generation. Retention and downstream media handling need separate review; OpenRouter account privacy settings do not apply to Comfy.

For workflow execution, publish real versioned workflow JSON and node/model requirements. For Router-only execution, publish real request recipes and explain the absence of a node graph; resolve the competition's “workflow files” expectation before submission. No fabricated workflows.

## 7. Durable contracts and invariants

A submitted spec freezes user/composed prompts, control values, role bindings, model/schema/recipe versions, source revisions, prepared-media identity, and preservation policy. Recovery uses that frozen spec, not current UI controls. A recipe can be reused into a new editable draft without changing historical attempts.

A continuity binding includes the source take/asset, actual decoded frame time and extracted-frame asset. Account for source trim and playback speed. Replacing or clearing the first frame invalidates stale continuity linkage; a late extraction cannot overwrite a newer selection. A video-edit source additionally includes range, timebase, speed and relevant rendered-edit revision. Applying a result revalidates that source; stale results stay available as alternate takes rather than overwriting a changed shot.

Keep remote state (`unknown`, queued, running, succeeded, failed, cancelled) separate from local state (preparing, downloading, import pending, ready). Cancellation requested is not confirmed cancellation. Save imported asset/take identity transactionally with deduplication. Model output is measured, not accepted blindly from response metadata.

Selection and sequence edits are reversible. If a later timeline operation splits and replaces a range, make it one durable atomic edit with rollback and reopen-safe undo—not an in-memory UI grouping. Preserve source audio unless the user explicitly chooses replacement; do not silently trim, retime, or alter adjacent shots.

## 8. Build order and proof

| Slice | Deliverable | Required evidence |
|---|---|---|
| A. Project/domain foundation | Selected TypeScript stack, shared Zod/domain contracts, PostgreSQL migrations, pg-boss worker, assets, capabilities, first/last-frame draft controls | Reproducible local setup, persistence/reload, incompatible-model switching, role/combination validation, exact prompt composition. |
| B. Real Comfy round trip | Persisted attempt → queued generation → owned playable take | Separately authorized live job, real playback, first/last-frame case coverage, same-attempt recovery, no duplicate import. |
| C. Continuity and direction | Prior-take frame reuse, supported camera/look controls, comparison and take selection | Exact source timestamp/revision, preserved recipe, visible UI inspection, representative real outputs. |
| D. Video editing | Verified source-video route with distinct edit/preservation policy | Real temporal input use, timing/audio checks, stale-source protection, explicit reversible application. |
| E. Competition packaging | Runnable open-source project, actual recipes/workflows, owned example media, short demo | Fresh setup, dependency/asset/license check, no secrets, successful end-to-end demo. |

Failure cases include lost submit response, browser reload, service restart, queue delay, missing credentials, unsupported roles, model switch, cancellation race, terminal failure, expired URL, failed import, duplicate recovery, and changed source. Fixtures prove fixture behavior; they do not prove provider quality or runtime compatibility.

Use Vitest for domain, composition, capability, and adapter contracts; exercise PostgreSQL/pg-boss integration against a real disposable database for transaction, restart, redelivery, and import-deduplication checks. Use Playwright for first/last-frame selection, model switching, review/submit, reload, recovery display, and take selection. Validate FFmpeg/ffprobe against owned media fixtures and measured output—not mocked metadata alone. Live Comfy tests remain separate and explicitly authorized.

## 9. Competition and authorization

[Comfy's published competition](https://comfy.org/open-source-higgsfield) closes **October 30, 2026, at 9 a.m. Pacific**. It requires a usable Comfy Developer Platform app, open-source code/license and local setup, workflow files, a demo of at most two minutes, and a social post tagged `#OpenSourceHiggsfield`. A hosted link is encouraged, not required.

Use original implementation and owned/licensed media. Downloaded Higgsfield code is private research evidence, not code to redistribute. Existing Studio architecture can inform the new project; publishing Studio itself is not required by this plan. Any reused source/assets still need a rights/dependency check.

Open decisions: final public product name; timeline/sequence-editor depth; source-video demonstration priority; hosted deployment/storage/authentication choices; live-test spend and transfer consent. The application stack is selected in §5. Patrick owns product/publication/spend decisions; engineering owns the detailed contracts, version pinning, and capability mappings. The Git repository and this planning PR establish the documentation baseline. No application implementation, paid generation, credentials changes, deployment, or competition submission is included.

## 10. Research and document status

Completed: public Higgsfield UI inspection; initial REA MCP analysis/export; byte-cited Cinema chunk inspection; Studio source investigation; Comfy route comparison; independent review of the prior execution contracts. REA's initial deeper semantic pass was heap-limited; Cinema's full submission payload and backend generation pipeline remain unresolved. This is not a completed clone or server reconstruction.

The [architecture-transfer checklist](ARCHITECTURE-TRANSFER.md) provides source-cited, implementation-independent acceptance requirements for frames, references, continuity, controls, capabilities, and frozen specifications.

Detailed investigation reports and raw captures remain local and are not included in this public planning PR. [Research provenance](PROVENANCE.md) records the source identities, public references, and coverage limits. Studio source findings inform domain contracts and cautionary lessons—not instructions to modify Swift.

The earlier native implementation plan is retained in the external research workspace and superseded by this document; see [research provenance](PROVENANCE.md). The architecture-transfer checklist is complete as a specification, not as tested functionality. Next: finalize Slice A in this repository against the selected stack; no local Swift build is required. This planning PR does not include scaffolding, installation, deployment, or paid provider calls.

Stack references: [Vite backend integration](https://vite.dev/guide/backend-integration), [Fastify type providers](https://fastify.dev/docs/latest/Reference/Type-Providers/), [TanStack Query server state](https://tanstack.com/query/latest/docs/framework/react/overview), and [pg-boss](https://github.com/timgit/pg-boss). Pin exact dependency versions during implementation rather than treating latest-version documentation as a lockfile.


---
Raw research evidence is not distributed with these planning documents. See [research provenance](PROVENANCE.md) for source identities and limitations.
