# Creative studio language

This vocabulary describes the new creative-production application. It separates editable intent, submitted work, and owned results so that UI, provider adapters, and history use the same terms.

## Creative work

**Project:**
A durable collection of shots, assets, generation records, and editorial choices for one creative work.

**Shot:**
A planned creative unit with editable direction and references, one or more candidate takes, and an optional selected take. A shot is not a provider job or a media file.

**Shot draft:**
The current editable generation intent for a shot, including its prompt, controls, reference bindings, and selected route.
_Avoid_: request (when the intent is still editable)

**Take:**
An owned candidate result associated with a shot and its provenance. Selecting a take is an editorial choice, separate from generating it.
_Avoid_: job, attempt

**Sequence:**
An ordered arrangement of shot/take selections and timing decisions. The concept does not require a particular timeline interface or rendering engine.

## Media and guidance

**Asset:**
A durable identity for media owned by a project, with measured properties and provenance. An expiring download URL is not an asset.

**Media representation:**
A particular byte representation of an asset, such as an original, prepared input, preview proxy, thumbnail, or export. A representation does not silently replace the identity or timing of its source.

**Reference binding:**
An association between an asset revision and a purpose in a shot draft or submitted specification, including any meaningful order and label. The same asset can be bound for different purposes.

**Frame constraint:**
A dedicated first- or last-frame conditioning input for a route that supports it. This describes input intent, not a promise of pixel-exact provider output.
_Avoid_: ordinary reference image, guaranteed frame lock

**Continuity link:**
Recorded provenance connecting a new shot's guidance to a particular source take, media revision, and extracted frame time. It is not a mutable pointer to whichever take is currently selected.

**Re-shoot:**
A source-video editing operation that creates an alternate take under an explicit change and preservation policy. Generation from an extracted still is not a re-shoot.

## Direction and review

**Director plan:**
An editable, versioned proposal for a project's shots, creative constraints, references and production dependencies. It is not itself permission to generate media.

**Director run:**
A durable record of progress through a particular production goal and plan revision, including step membership, action receipts and any review or recovery holds. It is not the agent's conversation history.

**Reference bundle:**
A versioned collection of identity guidance and asset references for a character, place, object or visual style. Its storage capacity is distinct from a model's per-request input budget.

**Generation review:**
A server-owned inspection handle binding a frozen generation specification and exact request material to the dependencies being reviewed. Accepting it creates at most one generation attempt.

**Approval grant:**
Trusted recorded authority for particular creative-production effects, actors, inputs and limits. It is distinct from a director's proposal or a provider's response.

**Assembly specification:**
A frozen selection of take/asset revisions, timing, soundtrack and other supported edit decisions for one export. Later workspace edits do not change that export's inputs.

## Generation and provenance

**Generation specification:**
The frozen, versioned creative inputs and resolved controls used for one generation intent, separate from the provider's request format.
_Avoid_: draft, provider payload

**Generation attempt:**
One durable execution identity for a frozen generation specification, including its provider-submission and recovery history. A retry of local work does not by itself create a new generation attempt.
_Avoid_: worker delivery, take

**Provider submission:**
The external request and resulting remote identity associated with a generation attempt. A request whose acceptance is unknown is not equivalent to a rejected request.

**Recipe:**
A versioned, reusable definition of a creative operation and its exposed controls, translated by a provider adapter or workflow runner. Reusing a recipe creates a new draft or attempt; it does not rewrite earlier results.

**Capability contract:**
The versioned evidence-backed description of what an exact route/model/recipe accepts, including roles, combinations, limits, and unknowns. Model-name similarity is not a capability contract.
