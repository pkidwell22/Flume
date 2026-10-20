# Flume — visual introduction

[← README](../../README.md) · [Development and verification](../../DEVELOPMENT.md)

The repository's visual introduction is the saved forest landing-page design, exported as eight
PNG sections. It preserves the page's composition, Archivo and IBM Plex Mono typography,
photography, copy and prototype labels rather than recreating the page in GitHub's default type.

## What is being shown

These are **rendered exports of a design page**, not live-canvas captures and not screenshots of
the running Flume application. The page was rendered at 1440 CSS pixels wide, at 1× pixel ratio,
with all scroll-revealed content visible and motion disabled. A small local adapter replaced the
design canvas runtime; local image and font files replaced hosted asset references. The standalone
source export is retained separately, not shipped as part of this README update.

The coordinator decoded all eight PNGs and compared their concatenated RGB pixels with the full-page
export: they are identical. Together they form a 1440 × 7171 page. GitHub may introduce small gaps
between sections and scales the images to its content width. Open an image to inspect it at full size.

The forest and house photographs are AI-generated design-study stills, **not Flume generation
results**. The workspace preview retains its visible **“Prototype · fixture data”** label. Its missing
end-frame and video slots are intentional, labelled empty states, not failed image loads.

The design includes the intended sound and mixed-export workflow. That is not a claim those features
are in the published application checkpoint. See the [current capabilities](../../DEVELOPMENT.md#at-a-glance)
and [verified live application run](../results/wan-2.7/README.md) for implementation evidence.

## Section order and readable text

### 1. Make the film you've always imagined

[Hero image](01-hero.png)

**Make the film you've always imagined.**

The landing-page introduction describes Flume's direction: a workspace for directing shots,
choosing takes, shaping sound and exporting films. Frame the shot, say what should happen,
review before anything is generated, and keep every choice visible and yours.

- What: open-source film workspace.
- Status: in active development.
- Source: [github.com/pkidwell22/Flume](https://github.com/pkidwell22/Flume).

A matte-black slab stands in a misty forest. The desktop composition uses the wide forest still;
the original interactive page uses a portrait companion at narrow widths. The README itself uses
the same static desktop composition at every width.

### 2. What it's for

[What it's for image](02-what-its-for.png)

“A shot is a small world: the frame it opens on, the frame it lands on, the direction in your words,
the takes you try and the sound that holds it together.”

### 3. From one shot to a finished film

[Workflow image](03-workflow.png)

Five steps, each a deliberate choice. Nothing generates, selects or exports on its own.

1. **Direct the shot.** Bind opening and closing frames, add references, write the direction and
   choose a model with its real controls.
2. **Review, then generate.** See the exact request before it is sent. Approval and generation are
   separate steps. Cost is shown when the provider reports it and marked unknown otherwise.
3. **Choose the take.** Inspect takes in the viewer; selecting one for the shot is a separate action.
4. **Shape the sound.** The designed workflow places voice, foley, room tone and score on the shot's
   clock, with per-layer offset, trim, gain, fades and mute.
5. **Export the film.** The design calls for saving a mix and exporting a frozen copy, with later
   edits leaving that copy unchanged and stale exports identified.

The page's own qualification remains visible: “This is how the workflow is designed. Flume is in
active development; parts of it are still prototypes.”

### 4. Get close. Then closer.

[Detail image](04-detail.png)

A close view of ferns, moss and the base of the matte-black slab. This is a generated design-study
photograph, not output from Flume.

### 5. Inside the workspace

[Preview image](05-preview.png)

**Prototype · fixture data.** The preview shows a timber house on a soundstage as the opening frame,
a labelled missing closing frame, shot direction, fixture model settings and an empty take list.
The Direct tab is captured; the Review and Sound tabs pictured beside it are not interactive here.
The model name and settings are explicitly fixture values, not evidence of a live provider request.

### 6. Worlds, built and lit

[Showcase image](06-showcase.png)

Portrait and landscape studies of a timber house set on a soundstage. The page shows an aspect-ratio
selector and an explicitly empty clip slot: no video is attached to that design page. The photographs
are design studies, not extracted film frames. Real, separately documented creative media remains
available in [the mood-film collection](../../readme-promos/README.md).

### 7. Yours to run, read and change

[Open-source image](07-open-source.png)

Open source; your checkout and files; explicit model choices; active development.

```sh
git clone https://github.com/pkidwell22/Flume
```

Follow the [requirements](../../DEVELOPMENT.md#requirements) and
[local setup instructions](../../DEVELOPMENT.md#run-locally) before running the app.

### 8. Footer

[Footer image](08-footer.png)

“An open-source workspace for making films. Photographs on this page are AI-generated design-study
stills, not Flume output. Interface views are prototypes with fixture data.”

## Links and interaction

The pictured navigation, buttons, tabs, aspect controls and copy button are pixels in the README,
not working controls. Real Markdown links beneath the images lead to setup, current capabilities,
verified results and the mood film. Private design-board links are not published. GitHub cannot
execute the original page's JavaScript, CSS layout or motion inside a README.

## Assets and typography

- Forest hero, portrait companion and detail: generated for this project through OpenRouter using
  `google/gemini-3.1-flash-image-preview`, guided by a user-supplied forest-obelisk video frame.
- House photographs: the previously supplied, retained soundstage design-study images.
- Archivo and IBM Plex Mono: rendered from fonts distributed under the SIL Open Font License 1.1.
  No font binaries are included in this documentation change. System fallback glyphs are used for
  arrows and the not-equal symbol where the font subsets lack them.
- The [image manifest](ASSET-MANIFEST.json) records dimensions, byte sizes and SHA-256 hashes of
  the exact exported PNGs. No provider receipts, private project URLs, credentials or signed asset
  links are included.
