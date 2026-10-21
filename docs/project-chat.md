# Project chat vertical slice

Project chat is an optional, project-scoped assistant surface. Merely opening it performs list/read requests and never calls a model. Sending a message uses a server-only OpenRouter credential and one of the small allowlisted model IDs in `chat-contracts.ts`.

## Configuration

- `FLUME_CHAT_STORE_ROOT` must be an absolute, dedicated private directory. When absent, storage-backed chat routes report that chat is not configured.
- `OPENROUTER_API_KEY` is read only by the server credential callback when a message is sent. A missing key produces an honest failed turn; no fixture reply is substituted.
- The file adapter is deliberately a **single owning process** deployment adapter. It serializes writes and recovery-capable reads per conversation inside that process, permits only one streaming turn per conversation, writes atomically with private modes, rejects non-UUID path components and symlink files/roots/ancestors, and distinguishes this process's live turn from a streaming record recovered by a newly opened adapter. Do not point multiple server processes at one root; this is not distributed locking. A SQL adapter can later replace the exported `ChatStore` interface.

No chat data is written under public assets. Upstream context is limited to project name/ID/brief, the selected saved shot's ID/title/prompt/revision/aspect ratio, and explicitly selected owned-image metadata. It excludes image bytes, media/provider URLs, hashes, provenance, unrelated workspace data, credentials, and unsaved editor drafts.

Provider submission rejects resolved context over 24,000 characters. Conversation history uses a deterministic newest-whole-message window of at most 32,000 characters including the current user message; older completed messages are deliberately omitted and the current message/context are never silently truncated. Saved output is capped at 64,000 characters. Partial/error output is persisted without automatic retry.

## Browser identity and replay

Browser conversation listing uses `POST /api/chat/conversations/list` with `{ "projectId": "..." }`. Browsers omit Origin on ordinary same-origin GETs; local-operator mode intentionally treats those as a separate agent identity. The origin-bearing read query keeps browser conversations under the same actor as create/send without weakening originless-agent or cross-origin protections. Existing GET routes retain their original identity semantics.

The message endpoint takes the conversation ID in the URL only, not as an extra property in its strict JSON body. Terminal/replayed events reconcile saved text, not merely status. An already-running replay is disclosed as running on the server without a nonfunctional local Stop control; reopen Chat to refresh that saved state.

## Shot-edit proposals

Shot editing is a separate explicit action, never inferred from ordinary chat. It is disabled without a selected saved shot and while the editor is dirty, busy, or reconciling an uncertain command. A request freezes the server-owned actor/project/conversation/shot identity plus saved title, prompt, and revision. The provider may return only a strict `{title,prompt,rationale}` object; extra or malformed fields fail durably, preserve the operator instruction, and are not silently retried.

Proposals are stored privately inside their conversation with `inferring`, `pending`, `applying`, `applied`, `dismissed`, `failed`, or `reconciliation` lifecycle state. The atomic `inferring` claim is non-actionable: concurrent duplicates return that truthful durable state without starting another inference, and a newly opened store marks an interrupted claim failed without retrying it. Apply requires an operator actor and accepts only proposal identity, never caller-supplied edits. Its stable command ID is persisted before provider inference and before mutation; the established `shot.update` command performs revision checking, receipt replay, and the actual save. A changed saved revision blocks first apply without rebasing. Interrupted `applying`/`reconciliation` states can explicitly replay the same command ID and immutable payload; this is labeled as potentially mutating, not as a read-only check. Dismiss never mutates a shot. The model is advisory and is never an authority principal.

Only explicit **Request proposal** invokes the paid text model. Opening/listing chat, applying, reconciling, and dismissing do not invoke model or media inference. Proposal input contains the frozen saved title and prompt only; selected image metadata remains ordinary chat context and is not proposal input. After authoritative apply, the parent workspace is refreshed. A refresh failure leaves the proposal applied and tells the operator not to repeat the mutation; editor dirty state remains owned by the parent controller.

Routes keep identity in their URL and do not duplicate it in the body:

- `POST /api/chat/conversations/:conversationId/shot-edit-proposals`
- `POST /api/chat/conversations/:conversationId/shot-edit-proposals/:proposalId/apply`
- `POST /api/chat/conversations/:conversationId/shot-edit-proposals/:proposalId/dismiss`

## Stream contract

`POST /api/chat/conversations/:conversationId/messages` returns `text/event-stream` events with JSON data:

- `context`: the exact server-derived context sent upstream and its disclosure list.
- `delta`: `{ "text": "..." }` from actual provider output.
- `done`: assistant message ID, `completed` status, saved content, and actual usage, or `null` when the provider did not report usage.
- `in_progress`: an identical request is already running; no second provider call was made.
- `stopped`: cancellation/interruption; partial text remains persisted.
- `error`: truthful provider/configuration failure; no implicit retry occurs.

The request body includes a UUID `requestId`. Its durable fingerprint covers the conversation/project IDs, model, normalized message, canonical selected asset IDs, selected shot, and the exact resolved project context snapshot recorded with the turn. Identical replays return the saved terminal/in-progress state without a second provider call; reuse for changed intent is rejected. The slice exposes no shell, browser, media generation, approval, or submission tool to the model. Its only action surface is the explicit, stored title/prompt proposal reviewed and applied by a human through the canonical `shot.update` command.
