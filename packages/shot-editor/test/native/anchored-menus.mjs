// Usage: node test/native/anchored-menus.mjs EXISTING_ELECTRON EVIDENCE_DIR [case-name]
// No downloads, servers, personal browser profiles or remote-debugging flags.
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const [electron, output, filter = ''] = process.argv.slice(2);
assert.ok(electron && output, 'Pass an existing unpackaged Electron executable and an owned evidence directory');
const evidence = path.resolve(output);
await mkdir(evidence, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'anchored-menus-'));
const native = path.dirname(fileURLToPath(import.meta.url));
try {
  await build({ entryPoints: [path.join(native, 'anchored-fixture.tsx')], outfile: path.join(scratch, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file' } });
  await writeFile(path.join(scratch, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated creator popup fixture</title><link rel="stylesheet" href="fixture.css"><style>
  body {margin:0} #witness-label {position:fixed;top:0;left:0;z-index:1;font-size:11px;pointer-events:none;background:#202225;color:#f4f1ec} #outside,#nonfocus {position:fixed;left:50%;transform:translateX(-50%);top:25px;z-index:2} #nonfocus {top:70px;width:100px;height:30px} #scroller {position:absolute;inset:110px 0 0;overflow:auto} #canvas {height:2400px;position:relative} #stage {position:relative;left:40px;top:40px;width:840px;max-width:calc(100vw - 16px)}
  </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, LANG: 'en_US.UTF-8' };
  const child = spawn(electron, [path.join(native, 'anchored-electron.cjs'), scratch, evidence, filter], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  await writeFile(path.join(evidence, 'electron.log'), log);
  const report = JSON.parse(await readFile(path.join(evidence, 'native-report.json'), 'utf8'));
  console.log(JSON.stringify({ code, success: report.success, checks: report.checks.map(({ name, passed, error }) => ({ name, passed, error })), cleanup: report.cleanup }, null, 2));
  assert.equal(code, 0, 'Owned Electron must exit successfully');
  assert.equal(report.success, true, 'Native popup checks must pass');
} finally { await rm(scratch, { recursive: true, force: true }); }
