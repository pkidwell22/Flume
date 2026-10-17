# Agent-first direction

**Confirmed product requirement; architecture details below are proposed.** Patrick wants the application agent-ready first, with an agent acting as a director, inspired by Slop Cannon. This augments the [selected stack and product spec](SPEC.md); it does not replace the human workspace or authorize implementation.

## Product promise

A creator can express a creative brief, inspect a director's proposed plan, let it operate within an approved scope, and intervene through the same editable project. The director works on durable shots, references, controls, takes, and sequence decisions—not a private plan hidden in conversation history.

A useful loop is:

**Brief → measured context → editable plan → configure and prepare → scoped review/approval → one real first-look take → approved remaining work → targeted revision/selection → frozen cut → verified export.**

This is our proposed loop, not a claim that we have recovered Slop Cannon's implementation. Automatic artistic evaluation and motion/identity judgments require their own quality evaluation; successful tool calls alone do not establish a good result.

## Foundation rules

1. **One application command layer.** UI, agent tools, and any future CLI invoke the same validated operations and authorization rules. An agent must not bypass domain logic through direct database writes or a separate provider path.
2. **Plans are editable artifacts.** A director plan records intended shots, relationships, source references, control proposals, and generation dependencies. A human can inspect and change it; an agent can resume from current project state rather than reconstructing truth from chat.
3. **Read, propose, configure, and execute are different operations.** Capability discovery or draft editing cannot implicitly submit paid work. Execution acts on a validated frozen specification, not ambiguous mutable conversation state.
4. **Bounded autonomy rather than confirmation on every click.** A user may approve a defined plan or generation scope with budget, quantity, provider/model, data-transfer, and revision constraints. The server enforces that scope. Changes outside it require renewed authorization; an agent-supplied approval flag is not approval.
5. **Agents get useful context, not dumps.** Expose paginated project/shot/take summaries, exact references and controls, capability blockers, job identities, and measured media properties. Supply thumbnails/contact sheets/frame samples and explicit source timestamps for visual review, subject to access/transfer controls.
6. **Long work is addressable and recoverable.** Submit returns durable attempt identity. Inspection, cancellation request, and result collection use that identity. A disconnected agent or resumed conversation must not start the generation again merely to recover its status.
7. **Every mutation has an actor and revision.** Attribute user/agent actions and retain causal command/plan/attempt IDs. Use expected revisions to reject stale updates rather than silently overwriting concurrent human changes.
8. **Generated alternatives remain alternatives.** Completion creates owned assets and takes. Selection, sequence replacement, and export are explicit operations within granted authority, with reversible edits and source revalidation where needed.
9. **Untrusted creative material is not an instruction channel.** Prompts inside references, imported workflow metadata, provider errors, tool descriptions, and generated text cannot authorize new tools, spend, data transfer, or publication.

## Interface shape to evaluate

Expose a small set of typed operations for project inspection, capability lookup, plan/draft creation and updates, validation/estimation, generation submission, attempt inspection/cancellation, output inspection, take comparison/selection, continuity-frame extraction, and sequence edits/export when implemented.

Publish schemas and actionable structured errors from the same domain contracts used by the UI. MCP is the proposed external-agent adapter, not the domain layer and not a second source of project state. Exact tool names, transport/authentication, context resources, and model-runtime integration will be specified in the foundation blueprint.

Design the director experience alongside the editable workspace. A headless proof using an existing capable agent client is a validation route, not a decision to make the product external-agent-only or postpone agent architecture. Keep the runtime boundary separate from presentation; an embedded director and external clients use the same commands. We have not selected or authorized a new agent runtime.

## Durable direction and first-look review

Propose a small `DirectorRun` record with a pinned plan revision, ordered/dependent step membership, input revisions, command/attempt receipts, pause reason and resume position. This is production coordination metadata, not a new LLM runtime or event-sourced copy of the project. A planning step can be retried under a bounded language-model budget; a paid media step must resume its existing attempt.

Keep a versioned creative brief/production bible for persistent identity and style constraints, separate from each shot's action and camera direction. Optional analyzed cues retain source/time/confidence and human corrections. Song analysis, dialogue/speaker tools and lip-sync are recipe-specific extensions, not prerequisites for every creative project.

For a multi-shot run, recommend a first-look gate on one intended real take before dispatching the rest. Bind the review to the actual owned artifact/revision and approved plan scope. A later material plan/reference change invalidates dependent authority. This is a proposed product default, not an observed automatic guarantee.

When finishing, freeze the chosen take/order/timing/audio/caption revisions into an assembly specification. A human changing the workspace during rendering makes the old export stale relative to the current cut, not secretly different. Track output availability/attachment, technical verification, artistic review and budget settlement separately.

## Acceptance scenarios

- An agent discovers a model does not support paired first/last frames and proposes a compatible route without dropping either input.
- A human edits a shot after a plan was prepared; stale agent configuration/submission is held for reconciliation.
- A worker or agent disconnects after provider acceptance; resuming recovers the same attempt instead of another chargeable generation.
- An agent can inspect actual output frames and measured timing, then create a revised take while preserving the original and its recipe.
- A permitted batch stops at its reserved budget or quantity boundary even if several agent actions run concurrently.
- User cancellation is reflected as requested until remote outcome is known; an agent cannot equate a stopped local wait with a stopped billable generation.
- UI and agent pathways produce equivalent domain events and records for the same approved operation.

## Research status

The Slop Cannon investigation is complete at the documentation/static level. Its official skill specifies a timed, quoted, first-scene-reviewed production loop; its integration guide describes client-managed per-scene orchestration and recovery without repeat purchase.[67][68] The public concept repository explicitly says it is a simulation, not production source.[76]

We are adopting the shared-project and bounded-director ideas, not assuming its production internals or copying its source. Detailed findings and the prototype/production distinction are summarized in [competitive lessons](COMPETITIVE-LESSONS.md). Authenticated execution and artistic quality remain untested.

This PR adds planning documents only. No agent server, runtime integration, account connection, or generation is implemented or exercised.

## Sources

[67] https://slop.cc/.well-known/skills/slopcannon-music-video/SKILL.md
[68] https://slop.cc/.well-known/skills/slopcannon-music-video/references/company-integration.md
[76] https://raw.githubusercontent.com/bonejohnson8/slopcannon-concepts/0527a817c7ac93cc59390c43817b91cb7225aee1/README.md
