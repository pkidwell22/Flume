# Local execution evidence

These are actual local Vitest/CLI observations, not Comfy responses. Scope: this package only. Node 26.8.1 / npm 11.19.0; exact dependencies in the lockfile. The coordinator's independent review is pending.

## Observed RED → GREEN slices

Each implementation slice followed a failing behavior assertion, then the full local check (`npm run check`: `tsc --noEmit` + `vitest run`). Static fixture coverage of existing third-party schema behavior is distinguished from the newly authored checks.

| Slice | Observed RED | Subsequent GREEN |
|---|---|---|
| Actual pinned schema validation | 1 failure: valid text request returned structural false in the minimal harness | 1 passed |
| Non-empty single prompt | 5 failures: semantic pass instead of block | 7 passed |
| Modalities, role conflicts/limits, image source | 15 failures: semantic pass instead of block | 26 passed |
| Ratio/seed prose rules and effective controls | 8 failures: missed blocks / undefined effective controls | 73 passed (includes structural boundary fixtures) |
| Strict lane fields and honest runtime state | 9 failures: extra fields admitted / empty runtime evidence | 85 passed |
| Exact frozen-intent translation | 1 failure: undefined preview | 86 passed |
| Invalid-combination block and deep freeze | 3 failures: no rejection / mutable snapshot | 101 passed |
| Public digest guard | 1 failure: modified source bytes did not throw | 104 passed |
| Actual offline CLI | 1 failure: missing runtime evidence | 105 passed |
| Additional source-pointer and authored-hash checks | Metadata/fixture guards against existing implementation | 107 passed |

Minimal harnesses were replaced, not shipped. The final repository contains no no-op validator or placeholder implementation.

## Mutation proof

Temporarily changed translation from `frozenIntent.prompt.composed` to `.composed.trim()` and ran:

```sh
npm test -- test/frozen.test.ts -t 'preserves the reviewed prompt' --reporter=verbose
```

Observed **1 failed, 15 skipped**, with an exact payload diff losing the two leading spaces. Restored the original translation; final full-suite execution is recorded in `run-summary.json`. This proves that the exact-prompt assertion detects a plausible silent rewrite, not just that the adapter returned something.

## Final reproducible gates

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test -- --reporter=json --outputFile=.local/vitest.json
npm run --silent report > .local/report.json
```

`run-summary.json` is reduced from those real JSON outputs. Raw local test output and the full report remain under ignored `.local/` (they can contain absolute machine paths). No provider, media-generation, media-upload, credential, or estimate action appears in the implementation or these commands. The only external development reads were public documentation, npm package metadata/dependencies and GitHub coordination.

No separate lint configuration exists in the baseline or this bounded package; TypeScript strict checking, test execution, scoped diff/secret review and `git diff --check` are the author gates. Independent review and any later CI status must be reported separately, not inferred from this file.
