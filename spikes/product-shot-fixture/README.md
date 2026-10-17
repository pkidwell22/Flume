# Owned synthetic product-shot inputs

**Preparation for #7; does not close #7.** This is a fixed local fixture, not live generation, a generic media engine, an app, or a renderer framework. No provider/estimate/authentication request, upload, external media download, installation or spend is performed by this code. GitHub publication is limited to this preparation PR's code/docs/metadata; generated media stays local and ignored. Independent parent visual/code review remains required.

## Reproduce

Requirements: the existing Node 26 installation and FFmpeg/ffprobe at `/opt/homebrew/bin/{ffmpeg,ffprobe}`. There are **no package dependencies** or install steps. Tested with Node 26.8.1 and FFmpeg/ffprobe 9.0.1 on macOS arm64.

```sh
cd spikes/product-shot-fixture
node --test test/kit.test.mjs
node --check scene.mjs
node --check kit.mjs
node --check test/kit.test.mjs
node kit.mjs
```

The last command prints exact absolute `dir`, `manifestPath`, `sourcePath`, and `galleryPath` values. Open `<dir>/index.html` locally; it needs no server or network. `<dir>/gallery.png` is a left-to-right triptych: **prior opening / extracted first-frame input / independently rendered last-frame input**. The PNG has no overlaid labels; the HTML gallery and manifest label its ordered panels. Individual input images contain no text. `prior.mkv` is lossless FFV1 for local FFmpeg/ffplay-compatible tools, not a promise of browser/QuickTime playback.

Every build uses a fresh `output/kit-*` directory and leaves prior evidence intact. No external media/output path is accepted. The entire `output/` directory is ignored, including original RGB PPMs, actual process outputs, clips, PNGs and mutation copies. Keep the review run until acceptance; its path is retained in local `output/review-run.json`. The tracked `evidence/manifest.json` is the measured, path-relative author-run manifest, not fabricated provider output. Its paths resolve relative to the matching generated kit, not the `evidence/` directory. Regenerating on this tested tool build produced a byte-identical complete manifest, source clip and input PNGs. Cross-platform/tool-version byte identity is **not** established.

## Original scene and recipe

`scene.mjs` contains the entire original asset: a closed lathed tapered hollow cup, one elliptical toroidal handle on the right, a neutral tabletop/back wall and a fixed diffuse light from upper left. A fixed, small perspective raster calculation renders that scene at 2× sampling, then averages each 2×2 pixel block. Geometry, colors, light, target and field of view never change; only the camera translates towards its target. This is deliberately **synthetic illustrative geometry**, with visible facets and an approximate analytic contact shadow, not a photorealistic/material-accurate render.

- Output: RGB PNG, **960×540**, **16:9**.
- Camera target: `[0.25, 0.88, 0]`; offset: `[2.7, 2.02, 7.2] × (1 − step × 0.003)`; vertical field of view: 35 degrees.
- Prior: camera steps **0–23**, encoded at **12 fps**, 24 actual distinct frames, measured duration **2.000000 s**.
- Continuity input: **decoded prior frame 23**, not a new rendering passed off as an extraction.
- End input: independent rendering at **camera step 47** of the same unchanged scene. This is an explicit `last_frame` binding, not a soft reference or an alleged prior-source frame.
- No imported photographs, fonts, models, textures, trademarks, private/copyrighted samples, or generated-provider media. The mathematical asset was authored for this fixture.

Exact source code SHA256 revisions, scene recipe, all decoded frame identities and observed tools are in the manifest. Every actual invocation, exit status, signal, diagnostic and stdout is retained under `<dir>/evidence/`; full FFmpeg/ffprobe build banners are there too.

## Measured identities and continuity

| Asset / role | Actual bytes | Actual identity |
|---|---:|---|
| `prior.mkv` | 446969 | SHA256 `509da0c5e5ee37ea4fc100732c631fcb7dd2111f8d22c73e57e9bd35c5fe3b95` |
| `first-reference.png` / `first_frame` | 21299 | SHA256 `2cf677ab0abe6b62696128fdf3721d6c3ae264fd8b4dfaedf953ee309bc29bd5` |
| `end-reference.png` / `last_frame` | 23066 | SHA256 `5c82cf02c4f49b337746ae8816dcc2f399e3a58b6973f5553e0692f7e1ffd165` |

The prior contains exactly one stream: **video stream 0, FFV1, `bgr0`, 960×540, timebase `1/1000`, no audio**. A full clean decode measures 24 increasing PTS from `0` to **`1917`**. The explicit eligible source range is **`[0,2000)` ticks** in that measured clock. Selection chooses the maximum decoded eligible PTS after the complete scan; it does **not** use duration × FPS, a tail seek, or duration minus epsilon. Final frame 23 is **`1917/1000` source seconds**. `observed-clean-decode` is evidence about this retained fixture, not universal corrupt-tail detection.

The implementation follows the **method**, not the fixture-ID API, of `../02-frame-provenance/media.ts`:

1. Generate a new owned clip; retain it read-only, hash its actual bytes, and inspect actual stream/decoded-frame metadata with ffprobe.
2. Decode the full source with FFmpeg `-copyts`, passthrough timing, demux timebase and RGB24 SHA256 framehash. Require agreement with ffprobe count/PTS/timebase, and with all independently rendered source pixel hashes.
3. Select the measured ordinal using a split filter that writes both the actual PNG and its selected PTS/timebase/RGB framehash. Require agreement with the measured source record.
4. Decode that PNG back to RGB; require the selected pixel hash. Recheck source bytes. PNG-file SHA256 and raw-pixel SHA256 are deliberately separate.
5. Preserve first-frame source take/hash, scene revision, stream, decoded ordinal, PTS/timebase and selection rule. Bind the independently rendered end image under its own role.

The test's endpoint oracle is literal **23 / 1917**, with the full independently authored PTS list. The expected pixel buffer is `render(23)`, independent of the inspector's selected index. It explicitly differs from the actual extracted opening PNG. The generated end-reference red-pixel area is approximately **1.1781×** the first reference, within the test's modest-push-in bounds; that check is not a substitute for human creative judgment.

**Original and prepared identities are equal by an explicit `identity-no-transform` operation.** There is no crop, resize, format conversion or color treatment between the extracted/rendered input PNG and its candidate prepared binding. Internal supersampling is part of original scene rendering, before the prior source exists. Route acceptance is explicitly `unverified`; no resize is inferred from the proposed output resolution.

## Observed test-first execution

Final author run: **7 tests passed, zero failures/skips**, all three `node --check` commands passed. Tests exercise real FFmpeg/ffprobe; there are no mocked provider responses. Two complete builds compare the entire manifest, including media byte identities and role mappings. Gallery pixels are checked row-for-row against the actual three PNGs, not just filenames. Child processes use fixed local binaries, argument arrays (no shell), a 60-second timeout, an 8 MB output bound, a local file/pipe input protocol allowlist, and fail closed on even exit-zero diagnostics.

Observed incremental RED → GREEN evidence:

| Slice | RED observed before implementation | GREEN |
|---|---|---:|
| Fixed scene | Missing owned scene renderer assertion | 1 test |
| Actual source/tail extraction | Missing actual media kit builder assertion | 2 tests |
| Separate end role | Missing `last_frame` binding | 3 tests |
| Diagnostic gate | Missing fail-closed process gate | 4 tests |
| PNG gallery | Missing local PNG gallery | 5 tests |
| CLI and reproducibility | Extra arguments incorrectly exit 0; no CLI build result | 7 tests |

The first scene slice is recorded in the author tool transcript; subsequent raw RED/GREEN logs are retained in `output/tdd/02-*` through `06-*`. Two isolated **copies**, not changes to the reviewed implementation, were then deliberately broken: selecting the first eligible frame failed with `0 !== 23`; changing the end role to `first_frame` failed the exact ordered-role assertion. Logs and the copied sources are retained under `output/tdd/07-*` and `output/mutation-*`. These are observed rejection tests, not live-provider findings.

## Limits and review boundary

- The validated 01/02 spikes, route-contract package and root files are untouched. Core 02 still accepts only its existing fixed fixture IDs. This new fixed-source check neither widens that API nor claims its generalization was verified.
- No provider-native request body/data URI was compiled, frozen, estimated or sent. No credentials were read by this harness. The local `first_frame` / `last_frame` labels retain intent but do not establish a live request or model behavior.
- These bytes still need parent visual/code acceptance and exact route/account/schema pixel/byte/transport validation. If a later authorized preparation changes an image, preserve both old/new identities and record the transform explicitly.
- #7 remains blocked by #6. Account entitlement, downstream transfer disclosure, explicit media-transfer consent and a numeric spend cap remain separate gates. Input dimensions do not guarantee output dimensions; input roles do not guarantee pixel-exact generated endpoints.
- No live output, receipt, recovery, selection replacement, seed repeatability, audio behavior, provider fidelity or production-hostile-media safety is established. No merge, approval or issue closure is part of this preparation.
