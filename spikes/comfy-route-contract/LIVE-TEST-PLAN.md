# Minimal live proof — proposal only

**Preparation for #7; does not close #7. Nothing in this file is approval to access an account, transfer media, estimate, submit, or spend.** Issue #7 remains blocked by #6. This preflight can finish independently; it does not bypass that dependency or independent review.

## One shot, one attempt

Selected creative test: an unbranded matte red mug on a neutral tabletop, with a modest smooth push-in. Proposed exact composed prompt:

> A single unbranded matte red mug sits on a neutral tabletop against a plain background. Make a slow, modest camera push-in. Keep the same mug, handle orientation, lighting direction, tabletop and background. No extra objects, hands, logos, text, cuts or object transformation.

Use two owned synthetic images from the same procedural scene, **not yet created**:

1. **First frame:** the actual final eligible presented frame extracted from an owned local synthetic prior clip, after the frame-provenance experiment is independently validated. Freeze source clip hash/revision, source take, stream index, decoded PTS/timebase, extracted image identity, and prepared image identity. The source video stays local; this is image-guided generation, not video-to-video editing.
2. **Last frame:** a closer view of the same mug/scene, with its own reproducible local recipe, asset revision and prepared-byte hash. It remains an end-frame binding, not a soft reference.

Propose matching 16:9 input geometry. Actual dimensions, MIME, decoded validity, raw/encoded bytes, hashes and any explicit crop/resize remain **pending measurement**. Do not populate them with the contract fixture's fake values. Image URL fields document public URLs, `mm_file://` references and data URIs, but this snapshot alone does not establish all model-specific pixel/byte/transport limits.[1] Prefer two PNG data URIs if the separately checked live contract supports their measured sizes; this is a proposal, not verified transport. No asset generation or upload is included in this PR.

## Exact route and proposed body shape

Native H3 queue, **no alternate provider override**:

```text
POST https://api.comfy.org/v2/models/minimax/minimax-h3/requests?reject_unknown_fields=true
```

The queue accepts the model's native body.[2] This is an intentionally **non-executable template**, not a frozen live body:

```json
{
  "content": [
    {
      "type": "text",
      "text": "A single unbranded matte red mug sits on a neutral tabletop against a plain background. Make a slow, modest camera push-in. Keep the same mug, handle orientation, lighting direction, tabletop and background. No extra objects, hands, logos, text, cuts or object transformation."
    },
    {
      "type": "image_url",
      "role": "first_frame",
      "image_url": { "url": "PENDING_MEASURED_AND_APPROVED_FIRST_PNG_DATA_URI" }
    },
    {
      "type": "image_url",
      "role": "last_frame",
      "image_url": { "url": "PENDING_MEASURED_AND_APPROVED_LAST_PNG_DATA_URI" }
    }
  ],
  "duration": 5,
  "resolution": "768P",
  "seed": 0,
  "aigc_watermark": false
}
```

Ratio is intentionally **unset**: the first/last inputs determine geometry according to the description, not an output-geometry guarantee.[1] Seed zero is an explicit recorded seed, not a determinism promise. No `generate_audio`, `model`, `callback_url`, `reference_*`, or source-video item is added. Audio behavior is unverified and must be recorded, not silently represented as disabled. The `false` above refers only to watermarking.

Do not add `fallback_provider=false` by analogy with synchronous invocation: the pinned queue operation does not list that parameter.[2] Before approval, resolve the account's actual native dispatch/fallback behavior and disclose any possible downstream provider transfer. If it cannot be bounded to the approved transfer scope, **hold** rather than invent a guarantee.

## Permission gates (none satisfied by this PR)

1. **Account/schema read permission:** after #6 and coordinator clearance, ask to use the existing credential only for `GET https://api.comfy.org/v2/models/minimax/minimax-h3` and `GET https://api.comfy.org/v2/models/minimax/minimax-h3/openapi.json`. Pin returned version/digest/ETag and re-run local checks on any reviewed drift. These endpoints are documented authenticated discovery routes.[2] A 200/catalog listing is not, by itself, proof of queue rollout, workspace policy, entitlement, or acceptance of this body. Seek authoritative account-capability evidence; if unavailable, record the unresolved claim and stop. Do not submit merely to probe entitlement.
2. **Input/estimate permission:** after local asset preparation under separate approval, present both exact PNG manifests and the serialized candidate request's byte size/hash, route, controls, schema identity and downstream transfer disclosure. Ask separately before an estimate POST because its body itself transfers the images to Comfy. `POST /v2/models/minimax/minimax-h3/estimate` is documented as non-generating/non-charging, but it may be unavailable, may return an unknown quote, and is not a price lock.[2] **No estimate call was made here.** Current estimate: **unknown**, not zero.
3. **Generation/spend permission:** present the reviewed request and estimate (or explicit unknown), then obtain an explicit numeric total spending cap, currency, and consent to transfer exactly those two prepared images and prompt to the disclosed parties. Spend limit: **not yet set/approved**. If a reliable bound cannot be established, pause for the user's decision; do not infer a budget from this plan or from account concurrency/committed-spend headers. The representative request is one five-second `768P` attempt, not permission for all fixture combinations.

Minimal generation approval request once every placeholder is resolved:

> Authorize one native `minimax/minimax-h3` queued attempt for the reviewed red-mug shot, with the exact first/last PNG identities and request hash shown, 5 seconds, `768P`, seed `0`, watermark `false`, ratio unset, and the disclosed Comfy/downstream image transfer, up to **[explicit user-approved numeric total/currency]**? Estimate: **[current verified quote or explicitly unknown]**. No new paid retry, alternate model/provider, or extra shot without new approval.

This request must not be presented as executable authorization while hashes, media bounds, entitlement, transfer scope or spending limit are unresolved.

## Future execution evidence and stop rules

The separately authorized workflow, **not this package**, would persist the frozen intent, exact body and request identity before the provider boundary. Preserve the authorized credential/workspace scope and a unique idempotency key. Store the queue body's `request_id` separately from the HTTP diagnostic request ID; follow the documented returned status/result URLs and delays.[2] Lost-response recovery uses the reviewed same-attempt contract, not a fresh paid take; an uncertain acceptance or non-replayable conflict stops for review. Do not claim exactly-once execution from one successful sample.

Record the real receipt/status and native terminal document. The H3 model description locates successful video at `task.content.url` and describes time-limited links with no Router refresh route, while a nested shared URL description says to query again.[1] Treat that as a documentation tension: download promptly, verify transfer safety and store an owned output; do not assume link refresh or regenerate on expiry. Capture actual MIME/byte/hash identity, decoder/ffprobe duration, dimensions, frame rate/timebase and audio streams. Keep private logs/media local and redacted.

A real result becomes an **unselected alternative**, retaining the first-frame continuity identity. Check technical and creative outcomes separately:

- **Technical:** correct native roles and exact frozen body; real receipt; owned playable result; measured output properties; no source/selection overwrite.
- **Creative:** recognizable same red mug/handle/color; coherent light/background; modest smooth push-in rather than morph/cut; recognizable start/end guidance; no new logos/text/hands. Dedicated frames do not promise pixel-exact output.

Stop on invalid input, missing scope/entitlement, estimate/cap ambiguity, unsupported transfer, provider rejection, or ambiguous acceptance. Never silently drop the end frame, convert it into a reference, switch routes, or perform another paid request. If H3 cannot satisfy paired intent, report that exact failure and ask about a separately verified route.

A single paired-frame run leaves first-only, last-only, reference-only, all duration/resolution combinations, seed repeatability, role maxima, cancellation races and recovery guarantees **untested live**. Have an independent reviewer issue per-claim VALIDATED/PARTIAL/INVALIDATED verdicts and propose only evidence-supported spec corrections. Until that work occurs, this lane's verdict is **PARTIAL: offline contract only**.

## Sources

[1] https://docs.comfy.org/router-schemas/minimax/minimax-h3.json
[2] https://docs.comfy.org/router-openapi.yaml
