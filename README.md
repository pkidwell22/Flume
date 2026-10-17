# Comfy creative studio

A new browser-based creative-production application informed by Studio's strongest architecture and controls: first/last frames, role-based references, shot continuity, model-aware generation, reusable recipes, and non-destructive take selection.

## Current status

**Planning repository only.** The technology stack is selected; the application has not been scaffolded, installed, built, or tested. There are no runnable app commands yet. This is not a Swift port or an extension of the existing Studio app.

## Start here

- [Product and architecture spec](docs/SPEC.md) — canonical implementation direction, stack, boundaries, and acceptance requirements.
- [Architecture-transfer checklist](docs/ARCHITECTURE-TRANSFER.md) — source-grounded creative-control contracts.
- [Research provenance](docs/PROVENANCE.md) — source identities, external evidence, and publication boundaries.

## Selected stack

- React, TypeScript, and Vite.
- Radix primitives, Tailwind CSS, Zustand, and TanStack Query.
- Node.js, Fastify, and Zod.
- PostgreSQL, Drizzle, and pg-boss.
- FFmpeg and ffprobe.
- Comfy Router and workflow adapters.
- Vitest, Playwright, and Docker Compose.

The future layout is `apps/web`, `apps/server`, `apps/worker`, and shared domain, capabilities, providers, media, database, and UI packages. These directories are not application scaffolding until implemented.

## Next implementation boundary

Define and implement Slice A from the spec: the modular TypeScript foundation, durable project/domain records, shared validation, and first/last-frame draft controls. First-frame continuity and source-video editing remain distinct workflows. Timeline/editor depth remains undecided, not excluded.

## Publication and licensing

No license has been selected; public visibility alone does not grant an open-source license. This PR establishes the planning baseline only. No application scaffolding, dependency installation, paid generation, or deployment is included. Raw third-party browser bundles, private source snapshots, and detailed local investigation reports are not included. Choose the license and supply owned/licensed example media before competition submission.
