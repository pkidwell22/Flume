## Scope

Preparation for #6, **not completion/closure**. Standalone `spikes/director-rehearsal/` only; root/shared documents and core #3/#4 work untouched. No MCP/application implementation, caller-parity/backend-safety claim, real media generation/upload, or approval/merge request.

## Artifacts

- Independent-baseline handoff: [`spikes/director-rehearsal/prompt.txt`](spikes/director-rehearsal/prompt.txt); public `manifest.json` + `fixtures.json` (8 synthetic cases).
- Hidden-from-model, predeclared oracle: `spikes/director-rehearsal/oracle.json`; scorer/schema/negative controls in the same directory.
- Frozen pre-inference commit: `1945a40`; `evidence/pre-run-lock.json` pins all prompt/oracle/scorer/test bytes. No post-run score relaxation.
- Actual unedited outputs: `evidence/kimi-k3.response.txt`, `evidence/glm-5.3-flash.response.txt`.
- Exact commands, sessions, route metadata and limits: `evidence/<model>.run.json` and `.session.json`; catalogue verification: `evidence/catalog.json`.
- Reproducible scores: `evidence/<model>.score.json`; descriptive differences: `evidence/diagnostics.json`; full caveats and artifact map: `README.md`.
- RED→GREEN and final checks: `evidence/test-summary.json`, `evidence/final-verification.json`; raw runtime/test logs retained locally in ignored `local-evidence/`.

## Executed commands / results

From `spikes/director-rehearsal/`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
python3 -m unittest discover -s test -p '*_test.py'
```

**50/50 Node tests and 3/3 Python tests pass.** Positive controls prevent blanket refusal from passing; unsafe plausible outputs fail for stale overwrite/revision bump, paired-frame damage, same-key replay after cancellation, invented refund/confirmation, forged approval, exhausted/unknown allowance, changed references, duplicate submission and unauthorized selection. Only spike-local locked dependencies; no global install.

Exactly once per cloud model:

```sh
python3 run-cloud.py kimi-k3
python3 run-cloud.py glm-5.3-flash
```

Both invoke:

```sh
hermes chat --oneshot --provider ollama-cloud --model MODEL_ID \
  --toolsets web --ignore-rules --source tool --max-turns 3 \
  --run-budget 120 --query-file "$PWD/prompt.txt" --quiet
```

Both inference commands exited 0, with one recorded API call and zero tool calls. Exact sessions: Kimi `20261016_224847_79afbc`; GLM `20261016_224911_2e5586`. The actual user-message SHA-256 is identical: `4465514e933d1972e73a704af080762dbe8e6c05bd76d0f6fdec07bb0d576146`. Runtime system-prompt hashes differ; model/provider attribution is session metadata, not upstream attestation.

**Preserved issue:** the historical runner expected a stdout `Session:` banner, but quiet Hermes emitted `session_id:` on stderr. Its original `.run.json` capture-error records are retained; `python3 collect-existing.py` recovered the existing sessions read-only. No model reruns. This was a collector failure, not a transport failure. The repaired offline parser has RED→GREEN tests.

```sh
node score.mjs evidence/kimi-k3.response.txt        # exit 2, retained nonpasses
node score.mjs evidence/glm-5.3-flash.response.txt  # exit 2, retained nonpasses
```

| Frozen exact-protocol result / 8 | Kimi | GLM |
|---|---:|---:|
| Syntax | 8 | 8 |
| Action choice | 4 | 4 |
| Authority / truthful state | 8 | 8 |
| Exact reference/payload/suggestion conformance | 5 | 4 |
| All dimensions | 4 | 3 |

**Not a ranking or unsafe-action rate:** both retained current draft/reference/attempt/selection facts and cancellation/reservation state in all 8 cases. Both proposed exact authorized submission/save and receipt/retrieval recovery. Most strict failures are safe extra reads or `propose` versus `hold` for a read-only recovery; GLM also suggested—but did not apply—a compatible route during an authorized save. The frozen reference dimension is overcoupled to canonical action/suggestion matching. This limitation is disclosed, not fixed after seeing outputs.

## What remains

Fresh **native Astra** baseline and independent review by the parent. Give only `prompt.txt` to that fresh context, freeze its raw final answer/metadata, then score with `node score.mjs PATH`. Do not use the hand-authored safe scorer control as a baseline. No real commands, database/media behavior, artistic quality, or caller-parity guarantees were exercised. #6 remains open and blocked on its foundation work; this PR is a bounded rehearsal only.
