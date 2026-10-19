# Flume

![Flume: black three-bar emblem on pale marble. Ex mente imago — From the mind, an image.](docs/brand/flume-github-banner.png)

**A local workspace for preparing image-to-video shots.**

Flume keeps the direction behind a shot in one editable place: the prompt, the model controls, and
the owned start and end frames that condition the result. Before anything is generated, it shows
the exact request and the provider blockers that stand in the way, so the decision to generate is
explicit rather than implied.

Flume's browser workspace, API, PostgreSQL store, and headless client run on your machine over
the same operations. It is built for work where the frame you start from
and the frame you end on are separate creative decisions, not generic image references.

> **Status: local-development checkpoint.** This is not a production release. The browser app, API,
> database, and core editing workflow run locally. Live generation is blocked, and no live video
> result has been verified for the documented checkpoint. Unreleased branch work is not included
> in the capabilities described below.

## Mood film

[![Flume — Alien Reel, preview](readme-promos/alien-reel/flume-alien-v002-preview.gif)](readme-promos/alien-reel/flume-alien-v002.mp4)

A 29.5-second original film joining three studies with two generated transitions: an iridescent crystal
flower assembling in a black void morphs into a river of liquid mirror, which pours through
volcanic glass and becomes luminous creatures grazing under a violet aurora — each world
transforming into the next. [Watch the full MP4](readme-promos/alien-reel/flume-alien-v002.mp4)
(29.5&nbsp;s, 1080p, silent by design). This is creative material assembled outside the app — not
a demonstration of in-app generation. Provenance and checksums live in
[readme-promos](readme-promos/README.md).

## At a glance

| Area | State |
| --- | --- |
| Project and shot workspace, owned-image import (PNG, JPEG, WebP) | Works locally |
| Separate start and end frame bindings, with per-role controls | Works locally |
| Prompt and control editing with persisted, reloadable state | Works locally |
| Generation review showing both frame roles and provider blockers | Works locally |
| Generation orchestration, attempts, takes, inspection and selection, MP4 export of a frozen take | Implemented and exercised with controlled sample providers only |
| Live generation | Blocked by a Hailuo 3 privacy hold |
| Recovery paths and launcher shutdown edge cases | Not yet fully verified |

## What works today

In the local browser you can:

- Create projects and shots, and import PNG, JPEG, or WebP images you own.
- Bind distinct start and end references, with separate controls for each role.
- Edit and save the prompt and controls, then reload the page to see the saved state.
- Prepare a generation review showing both frame roles and provider blockers.

These editing actions are verified against the real client and API, not a mock UI. Generation
orchestration, approval and submission, attempts, owned takes, explicit inspection and selection,
and MP4 export of a frozen selected take are implemented and exercised with controlled sample
providers. That coverage does not establish live generation or complete recovery behavior. The
default app has no sample-generation mode, and new takes are never selected automatically.

![Flume's saved Red Mug shot with separate start and end reference images and no generated takes.](docs/brand/flume-workspace.png)

*The current guarded local build, using synthetic, owned sample references — not generated video.
The visible warning reflects the unchanged app guard, not the account's current ZDR setting.*

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js 26.8.1 | Pinned in [`.node-version`](.node-version). The root engine allows `>=22.12.0` and `@flume/media` requires `>=22.18.0`; use the pinned version. |
| npm 11.19.0 | Declared as `packageManager` in [`package.json`](package.json). |
| PostgreSQL | The launcher starts its own local cluster and needs `initdb`, `postgres`, `psql`, and `pg_ctl`. Set `PG_BIN` if they are not found automatically. |
| FFmpeg and ffprobe | Required at startup for media inspection, previews, and export. |

**Platform support:** the runtime media bridge and parts of the test suite assume Homebrew's Apple
Silicon binary locations (`/opt/homebrew/bin`). Although launcher preflight accepts macOS and Linux,
only the macOS layout is currently exercised; other layouts need portability work. Windows is
rejected. The launcher does not install native runtimes.

## Run locally

From the root of your clone:

```sh
npm ci --ignore-scripts
npm run dev:check
npm run dev
```

`dev:check` verifies Node, the product workspaces, and PostgreSQL binary availability. It starts no
services and creates no store, but it does not check FFmpeg or the test prerequisites below.

`dev` builds the workspaces, starts a local PostgreSQL cluster, runs migrations before API startup,
and launches the API and web app. It installs npm dependencies automatically if `node_modules` is
missing. Worker phases run inside the API process; do not start a separate database server or
worker.

Then open <http://127.0.0.1:4310>. API health is at <http://127.0.0.1:4311/api/health>. Ports are
configurable with `FLUME_WEB_PORT` and `FLUME_API_PORT`; if a port is occupied, choose another
rather than stopping a service you do not own.

## Try the editing workflow

1. Create a project and a shot.
2. Import two images you own and assign them as the start and end frames.
3. Write the prompt, adjust the controls, and save.
4. Reload the page to confirm the state persisted.
5. Prepare a generation review to see the frozen request and any provider blockers.

The app still shows its Hailuo 3 privacy hold, so this is an editing and review walkthrough, not a
live-generation demo.

## Configuration

| Variable | Purpose |
| --- | --- |
| `FLUME_WEB_PORT`, `FLUME_API_PORT` | Override the default ports (4310 and 4311). |
| `PG_BIN` | Directory containing the PostgreSQL binaries, when they are not found automatically. |
| `FLUME_FFMPEG_PATH`, `FLUME_FFPROBE_PATH` | Absolute paths to the media executables, for installations outside the Homebrew layout. Plain `FFMPEG_PATH` and `FFPROBE_PATH` are not read. |

The default runtime is edit-only: it loads no generation credentials, and Hailuo 3 is reported as
blocked. Setting an API key in your shell does not by itself enable generation.

## Local data, security, and shutdown

The database, media, and logs live under `.flume/` and survive normal shutdown. The root launcher
owns this store; do not run the server package on its own. Ctrl+C requests shutdown, but launcher
cancellation and cleanup still need final integrated verification. Never delete `.flume/`, its
ownership markers, or its locks to fix startup while the owning process might still be running.

The app runs in local-operator mode on loopback interfaces and has no production authentication. Do
not expose it publicly. Do not commit local data, logs, credentials, or unlicensed media.

## Build, typecheck, and test

```sh
npm run build
npm run typecheck
```

These commands rebuild workspace exports in dependency order. `npm test` is the intended full suite
and also rebuilds first. `npm run test:tooling` runs tooling tests and is not a substitute for the
full suite.

Tests use controlled providers with real disposable PostgreSQL clusters and FFmpeg processes. They
need no provider keys and no production `DATABASE_URL`. Run suites sequentially in a clean
environment, never against a shared database or the persistent `.flume/` store.

Tooling tests look for PostgreSQL through `PG_BIN`, `pg_config --bindir`, the macOS
Homebrew location, then `PATH`. Tests using this discovery helper explicitly **skip** when
PostgreSQL is unavailable; a skipped test is not a pass. Check the skip count when reviewing results.

PostgreSQL tests require a short, canonical absolute scratch path that you own. Set `TMPDIR` to that
path, using only letters, numbers, underscores, dots, slashes, and hyphens; Unix socket length limits
also apply. Server and database tests additionally require `FLUME_TEST_SCRATCH_ALLOWED` to match the
canonical path exactly. The opt-in does not replace the ownership and isolation checks.

From the repository root, use a fresh scratch directory and an isolated home for the full suite:

```sh
test_scratch=$(mktemp -d "${TMPDIR:-/tmp}/ft-XXXXXX")
test_scratch=$(cd "$test_scratch" && pwd -P)
mkdir -m 700 "$test_scratch/home"
env -i PATH="$PATH" HOME="$test_scratch/home" TMPDIR="$test_scratch" \
  FLUME_TEST_SCRATCH_ALLOWED="$test_scratch" \
  PG_BIN="${PG_BIN:-$(pg_config --bindir)}" LC_ALL=C npm test
```

The runner forwards this explicit scratch approval without inheriting database connection targets
or provider credentials. Inspect the scratch directory after testing; do not recursively erase it
after a failure, which could hide a leaked process or cluster. Native media executable overrides are
not forwarded by the test runner, so the Homebrew layout limitation above still applies.

## Known limitations

- Earlier Hailuo 3 requests were rejected under OpenRouter's zero-data-retention (ZDR) policy. The
  account owner now reports ZDR disabled, but that change is not yet a verified live result.
- The app still holds an explicit Hailuo 3 privacy guard and loads no generation credentials by
  default. Connecting it to the changed account remains pending validation, and no fallback
  provider has been selected.
- Live output retrieval and CDN compatibility are unverified; redirected content fails closed.
- Confirmation after accepted writes, recovery from failed take previews, and launcher
  cancellation and cleanup corrections still need final integrated verification. There is no manual
  UI for reconciling uncertain provider acceptance, and a provider response alone does not prove
  recovery.

## Project structure

Flume is a TypeScript workspace on React, Vite, Fastify, PostgreSQL, Drizzle, pg-boss, and FFmpeg.

| Path | Contents |
| --- | --- |
| `apps/web` | Browser workspace for projects, shots, references, and review. |
| `apps/server` | API, local runtime, and media bridge. |
| `apps/worker` | Durable job phases, run inside the API process. |
| `apps/cli` | Headless JSON client over the same operations. It never retries or approves a generation. |
| `packages/` | Shared contracts, client, database, providers, media, and UI feature packages. |
| `tools/` | Launcher and workspace runner. |
| `spikes/` | Earlier bounded experiments; not the application entry point. |

## Documentation

- [Product spec](docs/SPEC.md) — product direction and architecture.
- [Foundation blueprint](docs/FOUNDATION-BLUEPRINT.md) — ownership and recovery contracts.
- [Verification plan](docs/VERIFICATION-PLAN.md) — proof obligations for each claim.
- [Architecture transfer](docs/ARCHITECTURE-TRANSFER.md) — control acceptance checklist.
- [Research provenance](docs/PROVENANCE.md) — source references and their limits.
- [Glossary](GLOSSARY.md) — vocabulary shared by the UI, API, and provider adapters.

These are design records. They can describe more than is implemented and are not feature-completion
claims.

## Brand and license

The [brand portfolio (PDF)](docs/brand/FLUME-Portfolio-v003.pdf) presents Flume's visual identity; it
is not evidence of application behavior. Its business-card contact details are illustrative, not
verified support contacts.

Original code and documentation are released under the [MIT License](LICENSE). Third-party
dependencies and reference snapshots retain their own terms. Import or commit only media you own or
are licensed to use.
