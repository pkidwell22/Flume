# Flume

A new browser-based creative-production application informed by Studio's strongest architecture and controls: first/last frames, role-based references, shot continuity, model-aware generation, reusable recipes, and non-destructive take selection.

## Current status

**Planning repository only.** The technology stack is selected; the application has not been scaffolded, installed, built, or tested. There are no runnable app commands yet. This is not a Swift port or an extension of the existing Studio app.

## Start here

- [Product and architecture spec](docs/SPEC.md) — canonical implementation direction, stack, boundaries, and acceptance requirements.
- [Architecture-transfer checklist](docs/ARCHITECTURE-TRANSFER.md) — source-grounded creative-control contracts.
- [Agent-first direction](docs/AGENT-FIRST-DIRECTION.md) — director workflow and authority boundaries.
- [Foundation blueprint](docs/FOUNDATION-BLUEPRINT.md) — proposed module ownership, commands, recovery, media and release contracts.
- [Competitive lessons](docs/COMPETITIVE-LESSONS.md) — evidence-backed adopt/adapt/avoid decisions.
- [Verification plan](docs/VERIFICATION-PLAN.md) — proof obligations, not test-pass claims.
- [Contract experiment brief](docs/CONTRACT-EXPERIMENT-BRIEF.md) — Patrick's preserved direction for the deeper validation task; archived, not started.
- [Shared language](GLOSSARY.md) — distinct meanings for plans, shots, specs, attempts and takes.
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

Before product scaffolding, the proposed next step is the bounded [contract experiment](docs/CONTRACT-EXPERIMENT-BRIEF.md): prove the critical agent-directed workflow and recovery boundaries, then revise the architecture from those results. The brief is archived and the experiment has not started. Slice A remains the later implementation boundary. First-frame continuity and source-video editing remain distinct; timeline/editor depth is undecided, not excluded.

## Publication and licensing

Original code and documentation in this repository are licensed under the [MIT License](LICENSE). Third-party dependencies and reference-schema snapshots retain their upstream terms.

This PR establishes the planning baseline only. No application scaffolding, dependency installation, paid generation, or deployment is included. Raw third-party browser bundles, private source snapshots, and detailed local investigation reports are not included. Supply owned/licensed example media before competition submission.
