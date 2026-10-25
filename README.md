# Flume

Flume is a local filmmaking workspace for organizing projects, directing shots, managing image references, and reviewing AI-generated takes. The browser app, API, and command-line client share a PostgreSQL store and owned media files.

**Status:** active development, not a production release. The default configuration is edit-only. Generation requires explicit provider configuration, review, and operator approval; configuring a key does not automatically enable a model or submit a job.

## Features

- Create projects and shots, and save prompts and model controls.
- Import owned images and bind separate start and end frame references.
- Review generation requests, estimated costs, and provider blockers before approval.
- Inspect generated takes, explicitly select a take, and export it.
- Work through the browser, API, or headless client.

See the [development guide](DEVELOPMENT.md#at-a-glance) for the current implementation status, verification evidence, and known limitations. Unreleased branch work is not included in that status.

## Requirements

- **Node.js 26.8.1**, pinned in [`.node-version`](.node-version).
- **npm 11.19.0**, declared in [`package.json`](package.json).
- **PostgreSQL binaries:** `initdb`, `postgres`, `psql`, and `pg_ctl`.
- **FFmpeg and ffprobe** for media inspection, previews, and export.

The local workflow is currently exercised on macOS with the Homebrew layout. Other platforms and binary layouts need additional verification. See [requirements](DEVELOPMENT.md#requirements) for details.

## Quick start

```sh
git clone https://github.com/pkidwell22/Flume.git
cd Flume
npm ci --ignore-scripts
npm run dev:check
npm run dev
```

Open <http://127.0.0.1:4310>. The API health endpoint is <http://127.0.0.1:4311/api/health>.

The root launcher builds the workspaces, starts its own local PostgreSQL cluster, applies migrations, and starts the API and web app. Worker phases run inside the API process. Do not start a separate database or worker for this workflow.

`dev:check` checks the Node version, workspaces, and PostgreSQL binaries without starting services. It does not check every media or test prerequisite.

## Configuration and local data

- `FLUME_WEB_PORT` and `FLUME_API_PORT` override the default web and API ports.
- `PG_BIN` points to PostgreSQL binaries when they are not found automatically.
- `FLUME_FFMPEG_PATH` and `FLUME_FFPROBE_PATH` specify media executable paths.
- Local database files, media, and logs live under `.flume/` and survive normal shutdown.

Read [provider configuration](apps/server/PROVIDER-CONFIGURATION.md) before enabling generation. Keep credentials server-side and out of source control.

The local app runs on loopback interfaces in local-operator mode, without production authentication. **Do not expose it publicly.** Do not delete an active store, its ownership markers, or its locks to work around a startup problem.

## Development

```sh
npm run build
npm run typecheck
```

The full test suite is `npm test`. It uses disposable PostgreSQL clusters and FFmpeg processes, so follow the [test prerequisites and scratch-directory setup](DEVELOPMENT.md#build-typecheck-and-test) before running it. `npm run test:tooling` covers tooling only, not the full application.

### Repository layout

| Directory | Purpose |
| --- | --- |
| `apps/web` | Browser workspace |
| `apps/server` | API and runtime composition |
| `apps/worker` | Generation and export worker logic |
| `apps/cli` | Command-line client |
| `packages` | Shared domain, database, provider, media, client, and UI packages |
| `tools` | Local development, build, and verification tooling |
| `docs` | Architecture, workflow documentation, and verification records |

## Documentation

- [Development, setup, and verification](DEVELOPMENT.md)
- [Provider configuration](apps/server/PROVIDER-CONFIGURATION.md)
- [Glossary](GLOSSARY.md)

## License

[MIT](LICENSE).
