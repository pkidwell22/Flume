# Research provenance and limitations

## Working documents

[SPEC.md](SPEC.md) is the active product and architecture direction. [ARCHITECTURE-TRANSFER.md](ARCHITECTURE-TRANSFER.md) defines the control acceptance checklist. Detailed investigation reports and raw evidence remain local; they are not part of this public planning baseline.

## Studio source reference

Studio was inspected at commit `867afa9c57f795bbe70a1195a2cdd5e4c4a053bd` in `pkidwell22/Studio`. Checklist citations point to that exact commit. The repository is private, so these citations require access and are not independently accessible public evidence. No Studio source files or media are included here.

The new application transfers domain concepts and behavior rather than Swift implementation, package format, or native runtime. Documented lifecycle weaknesses are cautions, not requirements to reproduce.

## Public sources

- [Comfy competition](https://comfy.org/open-source-higgsfield).
- [Higgsfield Cinema Studio](https://higgsfield.ai/generate).
- [Higgsfield Genjutsu](https://higgsfield.ai/ai/video?model=genjutsu).
- [Comfy Router OpenAPI](https://docs.comfy.org/router-openapi.yaml).
- [Comfy MiniMax H3 schema](https://docs.comfy.org/router-schemas/minimax/minimax-h3.json).
- [Comfy Runway Aleph 2 schema](https://docs.comfy.org/router-schemas/runway/aleph2.json).
- [Comfy Wan 2.7 Video Edit schema](https://docs.comfy.org/router-schemas/wan/wan2.7-videoedit.json).
- [Runway media input guidance](https://docs.dev.runwayml.com/assets/inputs).

Public documentation is changeable. Pin and validate exact model/route contracts before enabling paid generation. Similar model names do not establish equivalent capabilities across providers.

## Evidence limits

The research used signed-out public UI inspection, inert inspection of shipped browser code, Studio source inspection, and official API documentation. REA MCP performed an initial static pass and a retained-evidence follow-up. Its deeper semantic analysis hit a heap limit; Cinema's complete submission payload and backend pipeline were not reconstructed.

Static declarations, documentation, source inspection, fixture tests, and live generation are distinct evidence levels. This PR includes no runnable application, test-run claim, authenticated Higgsfield workflow, live generation, or validated provider output.

## Excluded material

Downloaded browser JavaScript/HTML, proprietary source snapshots, raw REA exports, screenshots, local paths, and detailed private investigation reports are not distributed here. Research evidence is not implementation source or demonstration media.

## Licensing

An open-source license has not yet been selected. Before competition submission, choose the license, verify dependency and asset rights, and provide owned/licensed examples. Do not redistribute Higgsfield code or media as part of the application.
