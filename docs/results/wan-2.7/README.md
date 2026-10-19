# Live Wan 2.7 result

This is a real output produced through Flume's local application workflow, not a controlled sample-provider response or the separate promotional mood film.

[![Compressed animation of the generated video](preview.gif)](flume-wan-2.7.mp4)

[Download the unmodified frozen MP4 export](flume-wan-2.7.mp4) · [Machine-readable media manifest](verification.json)

## Request and result

| Item | Observed value |
| --- | --- |
| Model | `alibaba/wan-2.7` |
| Input | Original text prompt; no uploaded images |
| Requested settings | 5 seconds, 720p, 16:9, audio off, no seed |
| Application attempts / owned takes / exports | 1 / 1 / 1 |
| Video stream | H.264, 1280 × 720, 30 fps, 5.000000 seconds |
| Audio stream | AAC was present despite audio being requested off |
| MP4 container duration | 5.038005 seconds |
| Frozen export size | 4,686,571 bytes |
| Provider-reported cost | $0.50 for this run; not a promised price or enforced spending cap |

### Prompt

> An original orange survey robot on a black basalt plain beside an iridescent glass monolith at sunrise. The robot slowly turns its head while the camera makes a subtle push in. Distant mountains, realistic materials, restrained cinematic motion. No logos or text.

## What was verified

1. The application prepared the review and persisted the exact request and its $0.50 estimate.
2. An operator explicitly approved one attempt, then clicked **Generate once**.
3. Exactly one application attempt reached **ready**, with a generated owned asset and take.
4. The downloaded generated asset matched its stored SHA-256.
5. The take was played, inspected and explicitly selected; generation did not auto-select it.
6. One frozen export became ready. The published MP4 is byte-identical to that downloaded export and matches its stored SHA-256:

   ```text
   097e14c3dd3c53c99c1ad38487eb2b34b2f8df9a9accff64bf65088d0f7e17ef
   ```

7. A fresh read-only renderer reopened the real project, advanced video playback and confirmed the persisted selected take and export download action.

## Screenshot and preview provenance

- The [workspace](../../brand/flume-workspace-live.png) and [take/export](../../brand/flume-take-export.png) screenshots were captured from the publication branch's production UI build, not a design mockup.
- They use the same real local test project's API data through a read-only loopback proxy. The only response adaptation removes the unpublished `plan` field to match this branch's strict workspace schema; no statuses, media, settings or results were invented or replaced.
- The capture permitted only local GET/HEAD requests, performed zero network writes and showed no unpublished storyboard UI. Cropping excludes unrelated projects and private identifiers. UI text and states were not retouched.
- `preview.gif` is a resized, palette-quantized 640 × 360, 10 fps animation of the export, without audio. It is an illustration, not the original media. Use the MP4 to judge output quality.
- The original branding and mood film elsewhere in the README remain separate promotional assets, not evidence of this application run.

## Limits

This demonstrates one text-only Wan request, not every model, resolution, image-conditioning combination or recovery path. Prior job evidence does not guarantee future provider acceptance. Hailuo 3 remains unverified; edit-only startup remains the default. Inspect returned stream metadata rather than assuming the provider obeyed audio-off or that video and container durations match exactly.

The live run preceded the additional guard that blocks Wan reviews with unknown estimates. Its supported-profile regression passed afterward; no paid generation was repeated to create these documentation assets.

Credentials, provider job identifiers, signed URLs, full private receipts and the database are intentionally not included.
