# 02 — Actual frame selection and continuity provenance

Disposable experiment for [issue #4](https://github.com/pkidwell22/comfy-creative-studio/issues/4). **Verdict: PARTIAL — the specified frame/continuity contract is demonstrated on this owned corpus and tool build; not a general media service or provider guarantee.** Nothing here is app scaffolding, a timeline, Swift, or database infrastructure.

## Run and inspect

From the repository root (Node 26 with native TypeScript stripping):

```sh
cd spikes/02-frame-provenance
npm ci --ignore-scripts --no-audit --no-fund --cache .npm-cache
npm run fixtures
npm run typecheck
npm test
npm run demo

node cli.ts inspect vfr
node cli.ts select cfr first 0 0.24
node cli.ts select vfr last 5.04 5.4
node cli.ts select vfr custom 5 5.52 5.1
node cli.ts map vfr 5.04 5.4 0.05 5.04 2
# Expected exit 2, structured REQUEST_OUTSIDE_RANGE, not an image:
node cli.ts select vfr custom 5.04 5.4 5.4
```

The only accepted media arguments are the generated fixture IDs. No file paths, URLs, user-supplied filters, shell commands, or FFmpeg flags are accepted. FFmpeg/ffprobe paths are fixed to `/opt/homebrew/bin/ffmpeg` and `/opt/homebrew/bin/ffprobe`. Child processes use argument arrays, no shell, a 30-second timeout and bounded captured output. This trusted local harness is **not** a hostile-media sandbox.

`output/demo/index.html` is a local image gallery, not a mock UI. Open it in a browser or inspect the PNG paths in `output/demo/report.json`. All images are actually extracted by FFmpeg. The report has nine asserted selection cases, seven observed holds, and the controlled delayed-delivery race. `demo` exits nonzero if any literal frame/time/hash oracle or expected hold disagrees.

Evidence layout (all ignored):

- `output/fixtures/manifest.json`: ownership, fixed recipe, expected timings, all seven file hashes, RGB reference hashes, tool versions and actual generation commands.
- `output/fixtures/{cfr,vfr,equal-pts,truncated,audio-only,multi-video}.mkv`, `unknown-pts.h264`, six original PPM patterns.
- `output/evidence/<fixture>-*/`: retained source bytes, raw `ffprobe.stdout` JSON, stderr and invocation/exit evidence; full `decoded-framehash.stdout` where decoding is supported; `inspection.json`.
- `output/evidence/extract-*/`: actual `frame.png`, extraction PTS/timebase/RGB hash, PNG round-trip RGB bytes, command results and `extraction.json`.
- `output/demo/report.json`, `output/demo/index.html`, `output/historical-spec.json`.
- `output/tdd/`: observed RED/GREEN and sabotage logs from development. `output/reproducibility.json` and `output/npm-audit.json` retain local verification results.

Nothing downloads media or calls a provider. No app data, credentials, persistent services or system packages are touched. The only installed dependencies are local, exact-version development dependencies and their lockfile. Deleting this spike's `output/`, `.npm-cache/`, and `node_modules/` removes its generated data/dependencies; **retain output until the independent reviewer inspects the evidence**. Regenerating fixtures replaces working fixtures but does not delete retained source snapshots or extracted images. Do not run fixture regeneration concurrently with tests.

## Contract and independent oracles

### Owned fixtures

`fixtures.ts` constructs 192×108 RGB pixels, writes PPM files, then encodes six frames with lossless FFV1 in Matroska. Every ordinal has its own saturated background, a white bar of increasing width, a black corner, and binary ordinal markers. Known timing is authored using `settb=1/1000,setpts=…`, not measured duration × frame rate.

| Zero-based ordinal / color | CFR PTS | VFR PTS | VFR source seconds |
|---|---:|---:|---:|
| 0 / red | 0 | 5000 | 5.00 |
| 1 / green | 40 | 5040 | 5.04 |
| 2 / blue | 80 | 5160 | 5.16 |
| 3 / yellow | 120 | 5200 | 5.20 |
| 4 / magenta | 160 | 5400 | 5.40 |
| 5 / cyan | 200 | 5480 | 5.48 |

Both measured timebases are `1/1000`. Test and CLI oracle **ordinals and PTS are literals**, independently authored from the recipe. Expected pixel bytes/hashes come from the separate RGB pattern generator, never the selector, inspector, extracted image or measured frame list. FFmpeg round-trip bytes must equal those pixels. This proves which known frame was selected, not merely agreement between two calls to a selection function.

The extra fixtures contain actual duplicate PTS, timestamp-less raw H.264, a truncated Matroska tail, audio only, and two video streams. No fabricated probe responses replace actual media decoding. Generating the corpus twice on the tested build produced byte-identical hashes for all seven files.

### Selection semantics

- Ranges are **absolute source-clock seconds**, explicitly `[start,end)`, `start < end`. Membership is determined by each decoded frame's PTS, not by its presentation duration or overlap with the range. Frames exactly at start are included; frames exactly at end are excluded.
- `first`: minimum eligible PTS. `last`: maximum eligible PTS, only after a complete clean scan of the retained source. These are named selections, not fake numeric requested times; `requestedSourceTime` is `null` for both.
- `custom`: first eligible decoded PTS **at or after** the requested source time. A gap snaps forward visibly; no interpolation, nearest-frame heuristic, backward fallback, or implicit clamp. Requested time must itself be inside the range. Empty ranges of frames and no later eligible frame are different explicit errors.
- `map`: `sourceStart + timelineTime × rate` with nonnegative timeline position and a constant positive playback rate. `sourceStart` is an absolute trimmed source-clock position. Negative/reverse/zero speed is unsupported. The original mapping, exact mapped request, decoded absolute time, and decoded time relative to the first PTS all survive.
- Decimal inputs have at most nine fractional places. Rational `BigInt` comparisons avoid float tolerance and source-origin subtraction mistakes. Displayed rational seconds are exact; raw PTS and stream timebase are retained too.

Non-vacuous endpoint proof: `[5.04,5.4)` contains **green #1 exactly at start** and excludes **magenta #4 exactly at end**. `first` is #1, `last` is yellow #3 at 5.2. The gallery separately shows #4 so exclusion is visually inspectable. A deliberate `<` → `<=` mutation selected #4 instead of #3 and failed the test.

Requested-vs-decoded proof: custom `5.1` selects blue #2 at `5.16`, with request `51/10`, decoded source `129/25` and relative time `4/25`. Trim/speed `5.04 + 0.05 × 2` requests `257/50` (5.14), still selecting 5.16. Request 5.5 has no later frame and is held, not silently mapped to the last frame. The finite range end is supplied explicitly; container duration is not used to invent an exact tail timestamp.

### Actual media identity

`inspect` copies source bytes into a unique, read-only evidence file, hashes those bytes, and probes/decodes that retained snapshot. It requires exactly one video stream, known safe-integer PTS, positive timebase and strictly increasing PTS. It never substitutes best-effort or FPS-derived timestamps when PTS is absent. The full FFmpeg RGB framehash stream must agree with ffprobe PTS/count/timebase. Selection decodes the same snapshot by measured ordinal using `select`, `-copyts`, and passthrough timing. A second framehash checks the selected output's actual PTS, timebase and pixels; decoding the resulting PNG back to RGB checks image content. Source, RGB-pixel and PNG-file SHA256s are separate identities.

Every process warning/error is a hold, including a warning accompanied by exit code zero. The truncated fixture actually emitted `File ended prematurely` from ffprobe; returning the preceding frame as an exact last frame would be wrong. The EOF label is deliberately **`observed-clean-decode`**, not a claim that a container proves all originally intended content exists.

### Continuity and historical provenance

`ContinuityDraft` is a small, single-process state experiment. Separate first/last slots contain `conditioning-image` bindings with explicit roles, image identity and copied `actual-output-frame` provenance. An input condition is not proof of the first/last pixels a generation provider would output. This corpus is entirely synthetic, not a live generation result.

Starting an extraction records a unique token, current revision, source content hash and stream index. Any new binding, clear, new extraction or other binding edit advances the revision. Completion checks its token/revision/source synchronously before writing; there is no `await` between comparison and assignment. Duplicate or stale deliveries cannot apply. Source mismatch is explicit. A frozen spec is a deep-frozen detached copy; subsequent caller or draft mutation cannot rewrite it.

The actual-media race uses a deterministic delivery barrier, not timing sleeps:

1. Freeze a **cyan CFR-last #5, PTS 200** first-frame binding.
2. Begin an extraction of **red VFR-first #0, PTS 5000**, holding its delivery.
3. Choose the newer **blue VFR-custom #2, PTS 5160** binding.
4. Release the old delivery: result is `stale`; blue remains selected.
5. Verify three different image digests, unchanged historical JSON, retained original CFR source/image hashes, JSON persistence round-trip, and re-extraction resolving the original cyan frame.

Clearing and changing pending source also invalidate late results. Current completion applies once, preserves the separate last-frame slot, and rejects replay. Removing the fences deliberately produced `applied` rather than `stale` and failed the race test.

## Observed execution

Tested on macOS 27.0.1 / arm64, Node **26.8.1**, npm **11.19.0**, FFmpeg/ffprobe **9.0.1** (Homebrew build), Vitest **5.0.5**, TypeScript **7.0.2**, `@types/node` **26.6.5**. See the generated manifest for complete media build information. Lockfile clean install (`npm ci --ignore-scripts`) was exercised, not just initial install.

Final author run: **3 test files / 34 tests passed**, zero skips; `npm run typecheck` passed; `npm run demo` asserted **9 selections, 7 holds, stale delivery**. `npm audit` reported zero known vulnerabilities at execution time. No independent formatter/linter is configured in this disposable directory; TypeScript and `git diff --check` are the static gates.

| RED→GREEN slice (log prefix in `output/tdd`) | Observed RED | GREEN total |
|---|---|---:|
| `01-inspection` | 1 missing decoded inspection failure | 1 |
| `02-endpoints` | 2 missing extraction failures | 3 |
| `03-custom-ranges` | 11 custom/range/mapping failures | 16 |
| `04-ambiguous` | 9 unsupported/ambiguous handling failures | 26 |
| `05-continuity` | 3 missing continuity failures | 29 |
| `06-capture` | 2 caller-mutation/source-retention failures | 31 |
| `07-cli` | 3 missing CLI/evidence failures | 34 |
| `08-mutant-inclusive-end` | 1 targeted endpoint test failed | restored |
| `09-mutant-missing-fence` | 1 targeted race test failed | restored |
| `10-final-green` | both mutations removed | 34 |

The initial failures were observed before the corresponding implementations, not synthesized transcripts. Raw logs are ignored by repository policy; this table is the concise retained result. A subsequent fresh test run reproduces the final result, not the historical intermediate code states. Author visual inspection also confirmed the cyan/red/blue extracted PNGs are distinct; independent parent inspection remains a separate gate.

## Constrained verdict and transfer corrections

**What worked:** V17 source-clock mapping and known frame identity for this constant-positive-rate corpus; V18 first/last/custom selection, both endpoints, gaps and explicit ambiguity/tail holds; V19 delayed delivery fencing and detached historical provenance within one process. Actual PTS arrays were CFR `[0,40,80,120,160,200]`, VFR `[5000,5040,5160,5200,5400,5480]`. The equal-PTS fixture measured `[0,40,40,120,160,200]`; raw H.264 had six frames with missing PTS despite an available timebase, and was held.

**Not established:** database/multi-process atomicity, restart recovery, immutable object-store permissions/retention/garbage collection, hostile intake isolation, arbitrary formats, B-frame reorder profiles, rotation/SAR/HDR/color management, proxy mapping, audio alignment, reverse/variable playback speed, large-media efficiency, universal corrupt-tail detection, browser playback, or provider frame-lock fidelity. Scanning the whole file is intentionally simple and unbounded in source file size; do not expose it as production intake. A valid remux of an incomplete source can reach clean EOF without proving the creator's intended tail. Equal-PTS sources are rejected wholesale rather than assigned an undocumented tie-break. JSON reloading demonstrates retained content, not tamper-proof persistence.

**Smallest transfer:** measured source snapshot + frame record + explicit selection rule, separate conditioning binding, and revision/token-checked completion against detached frozen provenance. Discard duration×FPS frame guessing, `duration − epsilon` last-frame selection, requested time masquerading as decoded time, inferred timestamps, and unguarded asynchronous binding replacement. Production must enforce the same compare-and-set with a real transaction and immutable storage, independently verified elsewhere. No shared planning documents were edited or marked verified by this experiment.

Primary behavior references consulted: [FFprobe sections and frames](https://ffmpeg.org/ffprobe.html), [FFmpeg copyts/fps_mode/enc_time_base/xerror](https://ffmpeg.org/ffmpeg.html), [select and showinfo filters](https://ffmpeg.org/ffmpeg-filters.html). These documentation references informed the experiment; the local actual-media evidence, not documentation alone, supports the verdict. Read alongside `docs/CONTRACT-EXPERIMENT-BRIEF.md`, `docs/ARCHITECTURE-TRANSFER.md` and V17–V19 in `docs/VERIFICATION-PLAN.md`.
