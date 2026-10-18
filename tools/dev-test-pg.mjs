import { execFile } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolvePgBin } from './dev-store.mjs';

const exec = promisify(execFile);
const binaries = ['initdb', 'postgres', 'psql'];
const homebrew = '/opt/homebrew/bin';

// pg_config is the authoritative description of whichever server is installed on this host.
// It is optional: minimal and client-only installs ship without it.
async function pgConfigBindir(env) {
  const { stdout } = await exec('pg_config', ['--bindir'], { env, timeout: 5000, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

// Priority stages, evaluated lazily so an explicit PG_BIN never waits on pg_config:
//   1. PG_BIN                — explicit operator intent, must always win
//   2. pg_config --bindir    — whoever installed PG knows where its binaries are
//   3. /opt/homebrew/bin     — macOS default, and ONLY probed on darwin
//   4. PATH entries          — last resort (distro layouts, Homebrew on Linux)
// The darwin-only guard is the point of this module: a Linux host must never resolve a Homebrew
// layout it cannot have, so "PostgreSQL is absent" stays a visible skip instead of a false pass.
async function* pgBinStages({ env = process.env, platform = process.platform, pgConfig = pgConfigBindir } = {}) {
  if (platform === 'win32') return; // The launcher rejects Windows outright; nothing to resolve.
  if (env.PG_BIN) yield [env.PG_BIN.trim()];
  try {
    const bindir = String(await pgConfig(env) ?? '').trim();
    if (bindir) yield [bindir];
  } catch { /* pg_config absent or failed: fall through to the remaining stages. */ }
  if (platform === 'darwin') yield [homebrew];
  yield (env.PATH ?? '').split(delimiter).filter(Boolean);
}

/** Full candidate list in priority order (diagnostics and tests); de-duplicated, absolute. */
export async function pgBinCandidates(options = {}) {
  const candidates = [];
  for await (const stage of pgBinStages(options)) candidates.push(...stage);
  return [...new Set(candidates.map(directory => resolve(directory)))];
}

/**
 * Resolve a PostgreSQL bin directory for tests, or `undefined` when this platform has none.
 * Acceptance delegates to resolvePgBin, so tests accept exactly what the launcher accepts
 * (initdb AND postgres AND psql executable). Callers must SKIP on `undefined`, never pass.
 */
export async function resolveTestPgBin(options = {}) {
  for await (const stage of pgBinStages(options)) {
    for (const directory of stage) {
      try { return await resolvePgBin(directory); } catch { /* Probe the next installation. */ }
    }
  }
  return undefined;
}

/** Skip reason for `test(name, { skip })`; names the missing dependency and the remedy. */
export function missingPostgresReason(platform = process.platform) {
  return `PostgreSQL ${binaries.join('/')} not found on ${platform}; skipping (not passing). Set PG_BIN to an existing bin directory or install PostgreSQL.`;
}
