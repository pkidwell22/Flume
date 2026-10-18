# Local provider configuration

This wiring is opt-in and fail-closed. It does **not** prove account entitlement, change an OpenRouter account setting, approve spending, or start a generation on launch.

## Default

`npm run dev` remains edit-only: no credential getter is attached and no provider discovery is requested. Merely inheriting `OPENROUTER_API_KEY` does not opt in. Local editing, imports and existing owned-media workflows remain available.

No `.env` file, credential file, vault, shell profile or global configuration is searched. The entry point reads only the process environment supplied by the operator/launcher.

## Explicit operator configuration

After reviewing/adopting the required changes, configure a **new, separately authorized launch** through the existing launcher. Do not start a second instance against a running application's store. These are instructions, not evidence that any running application was activated.

| Environment variable | Contract |
| --- | --- |
| `FLUME_PROVIDER_MODE` | Omitted or exact `edit-only` keeps the default. Exact `openrouter` attaches the existing bridge and performs one bounded, unauthenticated `/videos/models` GET before serving. Other values reject. |
| `FLUME_OPENROUTER_SCOPE` | Required in `openrouter` mode. Stable, non-secret account/route identity, for example `openrouter/my-account/v1`. Each slash-delimited segment uses letters, digits, `.`, `_` or `-`; maximum 200 characters. Do not use a key, secret, email address or URL. Keep it stable for the same account; do not relabel old receipts to use a different account. The reserved `openrouter/local-unconfigured/v1` cannot accompany credentials. |
| `OPENROUTER_API_KEY` | Supply via your approved **server-side secret injection** into the launch environment, not source, browser parameters or command-line arguments. Missing/invalid credentials do not grant readiness. The value is captured in a getter, not included in public configuration/DTOs or startup logs. |
| `FLUME_H3_RETENTION_DECISION` | Omitted or exact `keep-blocked` retains the historical H3 privacy hold. Only an explicitly authorized retention decision may use exact `allow-temporary-retention`. It removes that local H3-only hold, not provider-side ZDR restrictions, entitlement, unknown cost, review blockers or approval requirements. Other values reject. |
| `FLUME_FFMPEG_PATH` / `FLUME_FFPROBE_PATH` | Optional independent absolute executable paths. Omission retains `/opt/homebrew/bin/ffmpeg` and `/opt/homebrew/bin/ffprobe`. Empty/relative/control-character paths reject rather than falling back. Paths are passed as paths, never shell commands, and reach local media and worker jobs. Existing executable checks, limits and cleanup remain in effect. |

A non-secret configuration example, **with the key supplied separately and the policy hold retained**, is:

```sh
FLUME_PROVIDER_MODE=openrouter \
FLUME_OPENROUTER_SCOPE=openrouter/my-account/v1 \
FLUME_H3_RETENTION_DECISION=keep-blocked \
npm run dev
```

Replace the example account label with your chosen stable identity; it is not auto-discovered. Do not use a sample job ID as application provenance. The launcher already forwards the server environment; no launcher code or frontend credential path is added here.

## Precise remaining readiness blocker

Even with an explicit scope, key, accepted retention decision and understood catalog pricing, the built-in bridge returns **`ENTITLEMENT_UNKNOWN`**. `readVideoCatalog` always marks a non-policy-blocked catalog model `unknown`; the current adapter has no account-scoped entitlement observation/attestation interface. Catalog presence, successful GET, possession of a key, pricing or retention consent cannot be used to set `available`.

Accordingly ordinary H3 approval and submission remain blocked. There is deliberately no `entitled=true` environment switch, blocker-clearing override or test-generation probe. Resolving this requires a separately reviewed entitlement source/contract, not bypassing the hold. Existing injected `RuntimeOptions.provider`, `workerProvider` and `scope` remain usable for already-authorized integrations; the successful submission test uses an explicitly synthetic fixture provider, not live H3 entitlement.

## Existing runtime API

For an embedding server with its own approved configuration source:

```ts
const runtime = await createRuntime({
  pool, mediaRoot,
  scope: 'openrouter/my-account/v1',
  getApiKey: approvedServerSideGetter,
  privacyPolicy: {h3RetentionDecision: 'keep-blocked'},
  mediaTools: {ffmpegPath: '/absolute/path/to/ffmpeg', ffprobePath: '/absolute/path/to/ffprobe'},
});
await runtime.discover(); // read-only; never submits, grants entitlement or approval
```

Construction itself does not discover. The main entry point requests discovery only in explicit `openrouter` mode. Credential injection without an explicit account scope rejects before media/queue acquisition. Scope is reused by the existing dispatch queue and receipt/content checks. The existing loopback-test transport option is for controlled local tests only; no environment-configurable arbitrary credential destination was added.

## Pricing and reviewed identity

Discovery now retains each exact model ID and its **complete, unfiltered** USD `pricing_skus` observation separately from capabilities. No fixture prices, aliases or different model's rates are used. Missing, malformed, unknown-unit or unsupported-control pricing stays `null`; a failed refresh clears the mutable price observation. Historical reviews are not silently repriced.

The H3 helper receives the same frozen compiled request returned as the review envelope. Capability and price are captured from one observation before asynchronous owned-image preparation. Both submitted frame roles are priced even when they reference the same owned image.

A known estimate is persisted as optional `snapshot.estimate`, included in the existing review hash and exposed as optional public `review.estimate`. It includes the exact body SHA-256, model, amount, basis, line items and label:

> Catalog-based estimate; not a quote or provider-enforced spend cap.

Preparation rejects mismatched estimate/envelope/amount identities; approval/dispatch verification checks persisted identity and the database amount again. No database migration or new runtime is introduced. Older reviews without estimate metadata retain their original hashes. Rebuild the canonical domain/client together with the server for the additive public field. The existing UI still displays its amount/estimate wording; this change does not add a pricing-details UI.

A local dollar allowance compares/reserves an **estimate**, not a provider-enforced final-charge cap. Ordinary operator approval, project scope, expiry, revision, reservation, dispatch fencing and one-submit/replay rules remain separate and unchanged.

## Capability projection compatibility

The separately supplied capability-projection changes are preserved: optional public `aspectRatios` and `generateAudioSupported` survive server/domain/web/editor read contracts. Upstream raw absent/null audio still becomes `false`, and raw absent/null ratios still become `[]`; this wiring does not repair those pre-existing raw-unknown semantics.
