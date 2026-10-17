# Architecture transfer — cinematic generation controls

**Target: a new project, not a Swift port or a Studio integration.** Transfer Studio's domain behavior and control contracts; do not inherit its UI framework, package format, database, or full nonlinear editor. A web implementation is a possible delivery choice, not an existing implementation. Preserve a directed, reference-aware, multi-shot workflow—not merely a prompt box and Generate button.

**Evidence:** inspected local Studio source at pinned commit `867afa9c57f795bbe70a1195a2cdd5e4c4a053bd`. Links below point into that source snapshot. These are source findings, not runtime/provider verification. Unchecked items are acceptance requirements for the new project, not claims of completed work.

## Recommended boundary

**Editable shot draft → capability validation + prompt composition → frozen generation specification → provider/recipe translation → job and output provenance.** Keep assets, role bindings, continuity, controls, and prompt/context snapshots independent of the UI and transport. The same specification should drive review, submission, and history. A shot board and media viewer can supply continuity without requiring a multitrack timeline.

## Transfer checklist

### 1. First and last frame are distinct controls

**Reuse:** separate optional opening/closing image selections, each with a stable asset identity and explicit role. Studio calls these hard frame-lock roles, distinct from soft visual references; that is input semantics, not proof of pixel-exact provider output. Its UI supports clearing either selection and model-specific availability/requirements.

- [ ] First-only, last-only, both, and neither are evaluated against the selected route's contract; unsupported combinations fail before upload/submission.
- [ ] The reviewed first and last images reach their respective provider fields; never flatten them into an unordered reference list or silently exchange their roles.
- [ ] Missing/nonimage assets and duplicate bindings for a singleton frame slot produce actionable validation errors.
- [ ] Show required-frame rules, frame previews, and effective aspect/crop behavior before generation. A model change must explain incompatible selections rather than silently discard them.

Sources: [frame controls and availability](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioApp/Views/WorkspaceView.swift#L11493-L11574); [roles and semantics](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L2592-L2664); [concrete validation and adaptive-ratio translation](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioProviders/MiniMaxVideoProduction.swift#L153-L238).

### 2. References retain their purpose

**Reuse:** bindings have their own ID, asset ID, role, and optional label. Preserve general, style, character, setting, prop, brand, first-frame, last-frame, mask, annotation, and audio roles. Soft guide, frame constraint, mask, annotation, and audio are different semantics—not interchangeable upload slots.

- [ ] Save/reload preserves each binding's identity, role, label, and meaningful order. Reusing one asset in different roles does not collapse those bindings.
- [ ] Validate media type, supported role, count limits, and combination rules for the exact provider/model/recipe.
- [ ] Clearly disclose when a soft role becomes generic provider guidance; never silently downgrade a hard frame constraint, mask, or audio input.
- [ ] Conflicting frame/reference modes offer an explicit resolution. Preserve draft intent instead of silently clearing references.

Sources: [binding schema and semantic classes](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L2592-L2659); [route-specific mutual exclusion/count limits](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioProviders/MiniMaxVideoProduction.swift#L153-L181). Studio itself clears general reference frames on frame-lock changes: [implementation](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioApp/Models/WorkspaceModel.swift#L21862-L21875). Transfer the constraint, not that destructive interaction.

### 3. Continuity is an asset-backed relationship between shots

**Reuse:** use a prior shot's end, current viewer frame, first frame, or custom frame as the next shot's first frame. Import the extracted still as a durable asset; retain source asset/optional clip identity, actual extracted source time, and continuation camera language. Studio's source-time conversion accounts for trim, playback speed, and range bounds.

- [ ] Continuity works from an existing shot/asset without demanding a full editor. Preview the chosen source frame and timestamp before submission.
- [ ] For trimmed/speed-adjusted sources, extraction matches the selected visible moment; persist actual decoded time, not only requested time.
- [ ] Persist source revision/content identity alongside the extracted still and provenance (a new-project strengthening of Studio's ID/time schema).
- [ ] Replacing/clearing the first frame invalidates stale continuity linkage. An extraction completing after the user changes source cannot overwrite the new choice.
- [ ] Locked-camera continuation is visible, editable intent—not a hidden mandate for every shot or a guarantee of visual continuity.

Sources: [choice vocabulary](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioApp/Models/WorkspaceModel.swift#L292-L311); [continuity schema](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L1822-L1841); [extraction/import/provenance](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioApp/Models/WorkspaceModel.swift#L22391-L22449); [source-time mapping](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioApp/Models/WorkspaceModel.swift#L23460-L23493); [link invalidation](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioApp/Models/WorkspaceModel.swift#L21862-L21883).

### 4. Preserve the useful control vocabulary

**Reuse:** duration, aspect ratio, resolution, explicit size, generated-audio choice, seed, and camera direction. Studio camera choices include none, locked-off, dolly-in, push-in, orbit, handheld-follow, crane-up, aerial-reveal, and tracking. Its camera control is a single prompt hint, not a geometric path or ordered movement sequence.

- [ ] Every enabled control has a defined submission effect, shown in review and preserved in history; unsupported controls cannot appear to work.
- [ ] Unset, explicit false, and numeric zero remain distinguishable where relevant (especially audio and seed).
- [ ] Camera guidance appears exactly once in the composed prompt. “None” adds nothing; labels do not promise deterministic camera motion.
- [ ] Duration/geometry combinations are validated together. Show requested versus effective values when a route constrains them.
- [ ] If ordered camera moves are added, treat them as a new versioned feature—not functionality already established by Studio.

Sources: [typed controls](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L1844-L1869); [camera choices/phrases](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L2666-L2700); [camera composition](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L1170-L1191).

### 5. Capabilities are contracts, not model-name guesses

**Reuse:** provider-plus-model identity, supported modes/options/frame roles, reference/audio/seed support, constrained passthrough parameters, capability capture time, and raw/evidence metadata. Studio also models evidence sources and caveats, particularly for image capabilities.

- [ ] One capability contract drives UI choices and authoritative preflight; bypassing the UI cannot submit invalid combinations.
- [ ] Key contracts by provider, model, and route/recipe version. A similarly named model on another service does not inherit support.
- [ ] Distinguish supported, unsupported, and unknown. Unknown capability is not permission to enable a paid operation; keep evidence/freshness visible.
- [ ] Record the capability/recipe version used for the request. Catalogue refreshes cannot rewrite historical control meaning.
- [ ] Test representative contracts: first-frame-required, both-frame-capable, no-frame, frames-versus-references-exclusive, seed/audio-unsupported, and unknown.

Sources: [capability evidence](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L3-L58); [model capability schema](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L121-L140); [direct MiniMax example](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioProviders/MiniMaxVideoProduction.swift#L76-L105). These direct-provider values are **not** verified Comfy contracts. Studio's frame-picker nil-capability check is permissive ([source](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioApp/Views/WorkspaceView.swift#L11557-L11558)); do not copy that unknown-means-allowed behavior.

### 6. Canonical prompt, controls, and context travel together

**Reuse:** a typed specification holds provider/model/mode, prompt, negative prompt, bindings, controls, continuity, raw user prompt, composed prompt, context snapshot, and composition version. Composition draws on scene, setting, and bound production entities. The adapter prefers the saved composed prompt; persistence stores request/spec separately from the redacted wire payload.

- [ ] Review shows editable user intent separately from the exact effective prompt and controls to be submitted.
- [ ] Freeze the resolved request before submission, including reference revisions, continuity, effective defaults, and composer/recipe/capability versions. Separate this immutable record from subsequent draft edits.
- [ ] Round-trip the snapshot and compare its semantic fields; changing the current scene, camera, model catalogue, or composer does not alter an existing request.
- [ ] Translation consumes the saved effective prompt without recomposing or appending direction again. Define whitespace normalization before freezing/reviewing it.
- [ ] Every resulting take links back to that specification and its source assets. A deliberate new take forks the snapshot; editing a draft never rewrites prior provenance.
- [ ] Keep credentials and bearer-like media URLs out of persisted diagnostics; store safe wire evidence separately from private creative content.

Sources: [canonical specification](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L732-L809); [context composition](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioGeneration/ProductionGenerationModels.swift#L1127-L1208); [adapter prompt precedence](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioProviders/ProviderGenerationAdapters.swift#L73-L95); [snapshot persistence/provenance](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioProjects/StudioProjectPackage.swift#L12980-L13088).

## Transfer boundaries and verification limits

- Preserve **guided shot creation, references, continuity, camera intent, inspectable controls, and take provenance** as a coherent product. Neither a generic generator nor a full NLE is implied.
- Copy contracts and behavior, not provider-specific branches. For example, Studio's OpenRouter producer includes `shotContinuity`, while its adjacent direct MiniMax producer omits that field: [producer comparison](https://github.com/pkidwell22/Studio/blob/867afa9c57f795bbe70a1195a2cdd5e4c4a053bd/Sources/StudioApp/Models/WorkspaceModel.swift#L14558-L14674). The new canonical boundary should preserve continuity regardless of adapter.
- First-frame continuation is new-shot generation, **not source-video re-shooting**. A re-shoot feature requires separately verified video-input support and an explicit preservation policy.
- Do not import Studio's retry/reopen lifecycle weaknesses. Durable recovery belongs to the new job architecture; the reviewed source distinguishes new-generation retry from recovery; see [provenance and limitations](PROVENANCE.md).
- These checks require implementation tests and separately authorized real-provider/media validation before completion. This investigation made no application changes, executed no Studio tests, and established no new external provider guarantees.


---
Raw research evidence is not distributed with these planning documents. See [research provenance](PROVENANCE.md) for source identities and limitations.
