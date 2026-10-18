import { build } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.FLUME_ELECTRON_BIN;
if (!electron) throw new Error('Set FLUME_ELECTRON_BIN to an already-installed unpackaged Electron executable; no browser will be installed.');
mkdirSync(join(root, 'evidence'), { recursive: true });
const output = mkdtempSync(join(root, 'evidence', 'render-'));
await build({ entryPoints: [join(root, 'test/fixture.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: join(output, 'fixture.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
const result = spawnSync(electron, [join(root, 'test/browser-witness.cjs'), output], {
  cwd: root,
  encoding: 'utf8',
  timeout: 90000,
  env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LC_ALL: 'C' },
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
console.log(`Evidence: ${output}`);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
