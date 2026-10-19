// node test/native/popup-clipping.mjs EXISTING_ELECTRON NEW_EVIDENCE_DIR [case-name]
// An owned unpackaged Electron only; no server, install or debugging port.
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const [electron, output, filter = ''] = process.argv.slice(2);
assert.ok(electron && output, 'Pass an existing Electron and a new evidence directory');
const evidence = path.resolve(output), native = path.dirname(fileURLToPath(import.meta.url));
await mkdir(evidence); // Refuse to overwrite prior evidence.
const scratch = await mkdtemp(path.join(tmpdir(), 'popup-clipping-'));
const receipt = { scratch, evidence, filter, debuggingFlags: false };
try {
  await build({ entryPoints: [path.join(native, 'clipping-fixture.tsx')], outfile: path.join(scratch, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  await writeFile(path.join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated popup clipping fixture</title><link rel="stylesheet" href="fixture.css"><style>
body{margin:0}header{font-size:12px}#outside{position:fixed;top:35px;left:600px}#scroller{position:absolute;inset:110px 0 0;overflow:auto}#canvas{height:2400px}#stage{position:relative;left:50px;top:40px;width:800px}#outer{transform-origin:top left}#clip{position:relative;width:400px;height:400px;overflow:hidden;transform-origin:top left;box-sizing:content-box}#content{position:relative;width:800px;height:900px}#hook-trigger{position:absolute;left:30px;top:140px;width:150px;height:44px}#component{position:absolute;left:30px;top:100px;width:350px}#hook-panel{background:#23262a;color:white;padding:14px}#clip.gutters::-webkit-scrollbar{width:18px;height:14px}#clip.gutters::-webkit-scrollbar-track{background:#ddd}#clip.gutters::-webkit-scrollbar-thumb{background:#555}
</style><div id="root"></div><script src="fixture.js"></script>`);
  const child = spawn(electron, [path.join(native, 'clipping-electron.cjs'), scratch, evidence, filter], { env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  receipt.pid = child.pid;
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const timer = setTimeout(() => { receipt.timedOut = true; child.kill('SIGKILL'); }, 120000);
  try { receipt.exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
  finally { clearTimeout(timer); }
  receipt.childCloseObserved = true;
  await writeFile(path.join(evidence, 'electron.log'), log);
  const report = JSON.parse(await readFile(path.join(evidence, 'native-report.json'), 'utf8'));
  receipt.success = report.success && receipt.exit.code === 0 && !receipt.timedOut;
  console.log(JSON.stringify({ ...receipt, checks: report.checks.map(({ name, passed, error }) => ({ name, passed, error })), cleanup: report.cleanup }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
  receipt.profileRemoved = await access(scratch).then(() => false, e => { if (e.code !== 'ENOENT') throw e; return true; });
  await writeFile(path.join(evidence, 'launcher-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (!receipt.success) process.exitCode = 1;
