# Local provider configuration

This wiring is opt-in and fail-closed. It does **not** prove account entitlement, change an OpenRouter account setting, approve spending, or start a generation on launch.

## Default

`npm run dev` remains edit-only: no credential getter is attached and no provider discovery is requested. Merely inheriting `OPENROUTER_API_KEY` does not opt in. Local editing, imports and existing owned-media workflows remain available.

No `.env` file, credential file, vault, shell profile or global configuration is searched. The entry point reads only the process environment supplied by the operator/launcher.

## Explicit operator configuration

After reviewing/adopting the required changes, configure a **new, separately authorized launch** through the existing launcher. Do not start a second instance against a running application's store. These are instructions, not evidence that any running application was activated.

| Environment variable | Contract |
| --- | --- |
| `FLUME_PROVIDER_MODE` | Omitted or exact `edit-only` keeps the default. Exact `openrouter` attaches the existing bridge and performs one bounded, unauthenticated `/videos/models` GET before serving; a configured verification reference adds the two authenticated reads described below. Other values reject. |
| `FLUME_OPENROUTER_SCOPE` | Required in `openrouter` mode. Stable, non-secret account/route identity, for example `openrouter/my-account/v1`. Each slash-delimited segment uses letters, digits, `.`, `_` or `-`; maximum 200 characters. Do not use a key, secret, email address or URL. Keep it stable for the same account; do not relabel old receipts to use a different account. The reserved `openrouter/local-unconfigured/v1` cannot accompany credentials. |
| `OPENROUTER_API_KEY` | Supply via your approved **server-side secret injection** into the launch environment, not source, browser parameters or command-line arguments. Missing/invalid credentials do not grant readiness. The value is captured in a getter, not included in public configuration/DTOs or startup logs. |
| `FLUME_H3_RETENTION_DECISION` | Omitted or exact `keep-blocked` retains the historical H3 privacy hold. Only an explicitly authorized retention decision may use exact `allow-temporary-retention`. It removes that local H3-only hold, not provider-side ZDR restrictions, entitlement, unknown cost, review blockers or approval requirements. Other values reject. |
| `FLUME_OPENROUTER_VERIFIED_MODEL_ID` | Optional. Must be supplied together with `FLUME_OPENROUTER_VERIFIED_JOB_ID`, in `openrouter` mode. Exact requested catalog model id, for example `alibaba/wan-2.7`. Never a canonical suffix, alias, case variant, trimmed value or guessed identifier. |
| `FLUME_OPENROUTER_VERIFIED_JOB_ID` | Optional. Must be supplied together with the model id. Exact provider job id from one prior **completed** submission. A partial pair, empty value, whitespace or invalid identifier rejects the launch. This is evidence input, not an `entitled=true` switch. |
| `FLUME_FFMPEG_PATH` / `FLUME_FFPROBE_PATH` | Optional independent absolute executable paths. Omission retains `/opt/homebrew/bin/ffmpeg` and `/opt/homebrew/bin/ffprobe`. Empty/relative/control-character paths reject rather than falling back. Paths are passed as paths, never shell commands, and reach local media and worker jobs. Existing executable checks, limits and cleanup remain in effect. |

A non-secret configuration example, **with the key supplied separately and the policy hold retained**, is:

```sh
FLUME_PROVIDER_MODE=openrouter \
FLUME_OPENROUTER_SCOPE=openrouter/my-account/v1 \
FLUME_H3_RETENTION_DECISION=keep-blocked \
npm run dev
```

To additionally ask discovery to re-prove one previously completed Wan job:

```sh
FLUME_PROVIDER_MODE=openrouter \
FLUME_OPENROUTER_SCOPE=openrouter/my-account/v1 \
FLUME_OPENROUTER_VERIFIED_MODEL_ID=alibaba/wan-2.7 \
FLUME_OPENROUTER_VERIFIED_JOB_ID=your-exact-prior-job-id \
FLUME_H3_RETENTION_DECISION=keep-blocked \
npm run dev
```

Replace the example values with your own exact identities; neither is auto-discovered. The job id is evidence about the past, not a template for future submissions. Do not commit it as a fixture or reuse a sample id as application provenance. In `edit-only` mode these two variables are ignored, just like an inherited key, so the default remains edit-only with no discovery.

## Prior-job verification, not entitlement

Without both verification variables, every non-policy-blocked catalog model remains **`unknown`** and ordinary preparation keeps **`ENTITLEMENT_UNKNOWN`**. Catalog presence, a successful catalog GET, possession of a key, pricing or retention consent never set `available`.

With a paired reference, discovery performs two additional authenticated, same-origin, read-only GETs using the current credential:

1. `/videos/{jobId}` must return that exact `id`, `status: completed`, and a syntactically exact `generation_id`.
2. `/generation?id={generationId}` must return a `data` record with that exact `id`, must not be cancelled, and its `model` must exactly equal the `canonical_slug` of the exact requested catalog entry. Unlike the video-job endpoint, the generation-details endpoint wraps its record in `data`.

Only then is that one requested model projected `available` for the current catalog observation. The canonical suffix is never accepted as the requested model id, and no alias, suffix stripping, case folding, cross-model reuse or guessed rate occurs. A canonical slug shared by more than one catalog alias is refused as ambiguous rather than choosing an alias. Signed `urls`/`unsigned_urls` from the job payload are never retained, logged or returned.

Every failure is fail-closed: missing/invalid credential, a privacy hold for that model, a foreign or non-completed job, a missing/mismatched generation identity, a canonical-model mismatch, a malformed reference, or any failed refresh clears the verified route and leaves it `unknown` (or absent after a failed catalog refresh). No submission, retry, polling loop or fallback model is used during discovery. The H3 retention decision still wins for H3 and does not verify, entitle or reprice any other model.

This evidence does **not** prove future acceptance: a previously completed job can coexist with later `402`/`403`, funding or routing changes. It grants no approval, spend authorization, retention exception or provider-enforced cap. Ordinary review, estimate/hash binding, operator approval, reservation, one-submit and no-auto-retry rules are unchanged. There is deliberately no `entitled=true` switch or test-generation probe.

Verification requires the nested generation record to carry its exact `id`. If the provider omits that field, the route remains unverified instead of treating the request's query parameter alone as proof. The live authenticated job-to-generation link and canonical identity were checked against a completed Wan 2.7 job, and the real response envelope is covered by regression tests.

If no prior job exists, an operator must first obtain an explicitly authorized completed job through the provider's documented video API and retain its exact job ID. Discovery does not perform this paid bootstrap automatically. Do not fabricate a receipt or use another account's job as evidence.

## Live verification boundary

A local application run completed one text-only Wan 2.7 request at five seconds, 720p, 16:9 and audio requested off. The normal UI review and approval produced exactly one attempt; the result became an owned take, was played/inspected and explicitly selected, and a frozen MP4 export was downloaded and hash-verified. Provider-reported cost was $0.50 for that run, not a promised future price.

The returned video stream was 1280×720 at 30 fps and 5.000000 seconds. It also contained AAC audio despite audio-off, with a 5.038005-second container duration. Preserve and inspect actual media metadata rather than assuming output properties from requested settings. This test does not establish image-conditioned generation, every supported profile or complete recovery behavior.

Keep production credentials, job IDs, signed output URLs and local evidence outside the repository. Before changing the launch configuration of an existing store, stop its current owner normally, back up the database and review unfinished attempts/queued work. Do not launch a second owner or delete locks to force activation.

## Existing runtime API

For an embedding server with its own approved configuration source:

```ts
const runtime = await createRuntime({
  pool, mediaRoot,
  scope: 'openrouter/my-account/v1',
  getApiKey: approvedServerSideGetter,
  privacyPolicy: {h3RetentionDecision: 'keep-blocked'},
  verificationReference: {modelId: 'alibaba/wan-2.7', jobId: 'your-exact-prior-job-id'},
  mediaTools: {ffmpegPath: '/absolute/path/to/ffmpeg', ffprobePath: '/absolute/path/to/ffprobe'},
});
await runtime.discover(); // read-only; never submits, grants entitlement or approval
```

Construction itself does not discover. The main entry point requests discovery only in explicit `openrouter` mode. Credential injection without an explicit account scope rejects before media/queue acquisition. Scope is reused by the existing dispatch queue and receipt/content checks. The existing loopback-test transport option is for controlled local tests only; no environment-configurable arbitrary credential destination was added.

## Pricing and reviewed identity

Discovery now retains each exact model ID and its **complete, unfiltered** USD `pricing_skus` observation separately from capabilities. No fixture prices, aliases or different model's rates are used. Missing, malformed, unknown-unit or unsupported-control pricing stays `null`; a failed refresh clears the mutable price observation. Historical reviews are not silently repriced.

The H3 helper receives the same frozen compiled request returned as the review envelope. Capability and price are captured from one observation before asynchronous owned-image preparation. Both submitted frame roles are priced even when they reference the same owned image. H3 pricing semantics, bounds and SKU validation are unchanged.

Wan 2.7 has a separate, explicitly scoped estimator for exactly `alibaba/wan-2.7`. Its observed catalog map is duration-only (`duration_seconds`), so the estimate is the literal catalog rate × the exact integer duration in the request. The supported profile is 2–10 integer seconds, `720p`/`1080p`, `16:9`, silent (`generate_audio: false`) and no seed. Catalog-advertised frame roles are allowed and included in the flat duration rate; no `reference_images` or other add-on line item is invented. Any other model, duration, resolution, ratio, audio/seed control, missing `duration_seconds`, unknown SKU (including `reference_images`), malformed USD rate or mismatched model identity stays `unknown`. There is no generic model-pricing guesser. Preparation requires a known Wan 2.7 estimate: when the estimator returns `unknown`, the bridge emits the nonempty `WAN_ESTIMATE_UNKNOWN` blocker and returns no review envelope and no price, so the review cannot be approved, not even with an attempt-only allowance, and nothing is submitted to the provider. H3 keeps its existing unknown-estimate behavior.

A known estimate is persisted as optional `snapshot.estimate`, included in the existing review hash and exposed as optional public `review.estimate`. It includes the exact body SHA-256, model, amount, basis, line items and label:

> Catalog-based estimate; not a quote or provider-enforced spend cap.

Preparation rejects mismatched estimate/envelope/amount identities; approval/dispatch verification checks persisted identity and the database amount again. No database migration or new runtime is introduced. Older reviews without estimate metadata retain their original hashes. Rebuild the canonical domain/client together with the server for the additive public field. The existing UI still displays its amount/estimate wording; this change does not add a pricing-details UI.

A local dollar allowance compares/reserves an **estimate**, not a provider-enforced final-charge cap. Ordinary operator approval, project scope, expiry, revision, reservation, dispatch fencing and one-submit/replay rules remain separate and unchanged.

## Capability projection compatibility

The separately supplied capability-projection changes are preserved: optional public `aspectRatios` and `generateAudioSupported` survive server/domain/web/editor read contracts. Upstream raw absent/null audio still becomes `false`, and raw absent/null ratios still become `[]`; this wiring does not repair those pre-existing raw-unknown semantics.
