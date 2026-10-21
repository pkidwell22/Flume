# Mountain Meadow Systems environment artwork

Flume's welcome screen and empty-project overview use an original AI-generated alpine scene: dark conifers, silver mist and a visible granite mountain ridge. The editor, reference frames, takes and chat keep their existing functional surfaces and typography.

- **Typography:** existing Archivo and IBM Plex Mono; no font substitution.
- **Artwork role:** decorative product artwork with an empty alt attribute and an aria-hidden picture wrapper. It is not inserted into the project library, a shot binding or a generated take.
- **Responsive delivery:** native-size wide WebP and a dedicated portrait crop via `picture`.
- **Accessibility:** text sits over a scoped contrast gradient; image and gradient are removed in forced-colors mode. Text and controls are not placed inside an overflow-hiding wrapper. Existing focus, dirty-state, approval and image-containment checks remain intact.
- **Provider/model:** OpenRouter / `google/gemini-3.1-flash-image-preview`.
- **Reported generation cost:** $0.068651 for one returned image.
- **Original:** JPEG, 1584 × 672. SHA-256 `2f2fc482659d40f37403b8acd07cbb19c5099016a4175982ccb2c4be1b0e2861`.
- **App derivatives:** `apps/web/public/art/alpine-forest-wide.webp` and `alpine-forest-portrait.webp`. No upscaling or object retouching. Their exact crop, dimensions, byte counts and hashes are recorded in `alpine-forest.provenance.json`.

The original JPEG, full prompt, provider receipt and generation manifest are preserved in the separate creative workspace, not in application data or the public build. This is an invented scene, not a claim to document a particular real location. The imagery does not imply vendor affiliation.

When replacing these derivatives, use new asset filenames (or hashed imports): the static gateway intentionally caches immutable asset URLs. Preserve earlier originals and their provenance.
