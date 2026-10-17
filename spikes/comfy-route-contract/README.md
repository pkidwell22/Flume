# H3 route-contract preflight

**Preparation for #7; does not close #7.** An isolated executable experiment, not a production adapter. Only `spikes/comfy-route-contract/` changes. No application scaffolding, account access, generated media, provider invocation, uploads, estimate POST, or spend.

## Reproduce

Observed toolchain: Node **26.8.1**, npm **11.19.0**. Dependencies are exact project-local versions in `package.json` and `package-lock.json`; install scripts are disabled. No global install is needed.

```sh
cd spikes/comfy-route-contract
npm ci --ignore-scripts --no-audit --no-fund
npm run check                       # TypeScript + Vitest
npm run --silent report             # offline JSON, stdout only
# Optional local artifact (ignored):
mkdir -p .local
npm run --silent report > .local/report.json
```

Tests and report read only checked-in sources/fixtures. They contain no network client or credential handling. `npm ci` downloads dependencies; it is not a provider operation.

## What is proved

| Layer | Evidence | Meaning |
|---|---|---|
| Public structural schema | Ajv runs the actual pinned OpenAPI input schema with local component references | JSON types/required fields/ranges/enums, **not** every statement in its prose |
| Authored H3 semantics | `h3-semantics/v1`, pointer-backed rule ledger, explicit rejection codes | Conservative documented interpretation and clearly labeled local restrictions |
| Frozen translation | Zod strict input; exact native-role assertions; detached deep-frozen sidecar/body | No silent prompt rewrite, role conversion, control defaulting, or provenance leakage into provider fields |
| Runtime | Always `not-run`; entitlement/estimate `unknown`, media readiness `unverified` | **No live compatibility, quality, billing, entitlement, or recovery proof** |

The final local run passed **107 tests** across four files. The CLI evaluated **82 named request fixtures**: 34 semantic passes, 35 semantic blocks, and 13 structural failures with semantics not evaluated. Every expected result matched. These counts describe authored fixtures, not generated shots. See [execution evidence](evidence/EXECUTION.md) and [machine summary](evidence/run-summary.json).

`compileFrozen` returns a **non-executable preview**, serialized `bodyJson`, original intent sidecar and validation; it rejects incompatible requests instead of dropping a binding. The only preview route is:

```text
POST https://api.comfy.org/v2/models/minimax/minimax-h3/requests?reject_unknown_fields=true
```

The queue documentation explicitly uses the same native input body as the model's synchronous schema.[2] We do not emit `model`, callbacks, credential headers, provider overrides, or an invented audio switch. In this snapshot the queued operation lists `reject_unknown_fields`, but does **not** list `fallback_provider`; we do not invent that query control or promise a no-fallback guarantee.[2]

## Rules and limits

- Exactly one non-empty text item is documented. The local rule additionally rejects whitespace-only prompts but never trims submitted text. The structural schema alone does not encode that cardinality/non-emptiness.[1]
- First-only, last-only, paired, neither, and single-reference cases are exercised. Keyframe plus `reference_*` is documented as incompatible.[1] Passing a first/last fixture is documented validity, **not** observed conditioning or pixel-exact frame locking.
- Only text/image input is model-specific evidence. Shared `video_url`, `audio_url`, `base_video`, and output-audio fields do not establish H3 source-video editing or audio-input support.[1]
- Exact `first_frame`, `last_frame`, and `reference_image` image roles are retained in input order. Character/style/general/mask/etc are not guessed to mean `reference_image`. The model schema gives no numeric role/reference maximum.[1] Duplicate frame slots are blocked by local policy; more than one reference is blocked as **unknown limit**, not advertised as a provider maximum of one.
- Integer duration 4–15 is structurally encoded. The source distinguishes Comfy's accepted lower bound of four from MiniMax documentation's five; its reported four-second observation is **not our experiment**.[1] The proposed live shot uses five seconds.
- Resolution admits the exact strings `768P`, `768p`, `2K`, `2k`. The submitted spelling remains unchanged; uppercase dispatch normalization is a separate **documented** effective value.[1]
- Text-only needs a listed explicit non-`adaptive` ratio. First/last conditioning ignores the ratio; the requested field survives unchanged and effective geometry is reported as `frame-determined`.[1] Unlisted strings are conservatively blocked even with frames. Reference-only geometry is less explicit: a listed non-adaptive ratio is a candidate, omitted/adaptive is **unknown**, not inferred to behave like a keyframe.
- Seed's prose range is checked separately from the integer schema. Unset, `-1`, and `0` remain distinct; explicit watermark `false` is retained, not defaulted away.[1] `aigc_watermark` is **not** an audio control.
- The lane rejects additional fields even where the public schema allows them. This is a local preservation/scope policy, not a claim that the provider rejects all such fields. `inspectRequest` reports structural and semantic outcomes separately; `compileFrozen` also requires a strict intent shape/version.

Every semantic rejection code, its evidence classification and exact JSON pointer are in [semantic-rules.json](sources/semantic-rules.json). Tests resolve each pointer into the pinned document, compare exact evidence and ensure every rejection code has a fixture. Unknowns never become permission to send.

## Reproducibility and evidence identity

Public response bodies were freshly fetched by unauthenticated GET at **2026-10-17T02:37:27Z**; no historical/private raw research was copied. [manifest.json](sources/manifest.json) pins URLs, retrieval, versions and SHA-256:

| Source | Version | SHA-256 |
|---|---|---|
| H3 OpenAPI 3.0.2 | `c0e2e941ffff` | `a0ba226c836c1154e21a14818746c63dca9b145fce4220b87a6383d4e16af03b` |
| Router OpenAPI 3.0.2 | `1.0` | `55e5dc8f97847cb35fac9f3dcdb667c4e81d3a5fb30b26ffab0f636ca877f5bc` |

Original-byte digests are checked before the contract loads. The schema is OpenAPI 3.0 rather than a standalone modern JSON Schema: Ajv accepts its `nullable`; `components` is retained for local references, non-validation OpenAPI annotations are tolerated (`strict:false`), and `int64` is treated as an annotation while seed bounds are authored checks. Defaults, coercion and property removal are not enabled.

[authored-manifest.json](sources/authored-manifest.json) separately pins semantic implementations, the rule ledger, and `h3-fixtures/v1` fixture bytes. Changing a snapshot means reviewing affected semantics and updating identity deliberately; re-fetching is **not** part of tests.

`fixtures/frozen-shot.json` is explicitly fictitious request data: `.invalid` locators, repeated-character placeholder asset hashes, synthetic revisions/PTS. It is not a measured clip, a usable media file, or an actual live request. Its deliberately reversed last/first order detects reordering. The byte-identical prompt/role/control assertion was also mutation-tested by temporarily trimming the prompt; the test failed and the mutation was restored.

## What remains outside this experiment

No image decoding, MIME/size/pixel validation, URL reachability/SSRF protection, `mm_file://` ownership check, upload transport, continuity measurement, approval persistence, durable attempts, idempotent submission/recovery, receipt/result parsing, output import, or UI is implemented. The sidecar retains supplied provenance without proving its media bytes. These boundaries remain with the other experiments and the separately authorized live workflow.

See the [minimal live-test proposal](LIVE-TEST-PLAN.md). A source snapshot is not account entitlement; a green fixture is not a live success. Independent coordinator review is still required. Root specification corrections are intentionally not made here; the fresh resolution spelling, reference-count uncertainty, and queue-query observations above are review inputs.

## Sources

[1] https://docs.comfy.org/router-schemas/minimax/minimax-h3.json
[2] https://docs.comfy.org/router-openapi.yaml
