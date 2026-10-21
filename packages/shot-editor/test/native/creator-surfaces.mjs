// node test/native/creator-surfaces.mjs EXISTING_ELECTRON NEW_EVIDENCE_DIR
// No server, installs, remote debugging port, personal profile or provider calls.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const [electron, output] = process.argv.slice(2);
assert.ok(electron && isAbsolute(electron) && output && isAbsolute(output), 'Supply existing Electron and new owned evidence paths');
const native = dirname(fileURLToPath(import.meta.url));
const root = resolve(native, '../../../..');
const evidence = resolve(output);
await mkdir(evidence); // Refuse to overwrite historical evidence.
const scratch = await mkdtemp(join(tmpdir(), 'creator-surfaces-'));
const sha = data => createHash('sha256').update(data).digest('hex');
let child, timer, log = '', code, signal, report;
try {
  const main = await readFile(join(root, 'apps/web/src/main.tsx'), 'utf8');
  const imports = [...main.matchAll(/^import ['"]([^'"]+\.css)['"];$/gm)].map(match => match[1]);
  assert.deepEqual(imports, ['@flume/ui/theme.css', '@flume/shot-editor/styles.css', '../../../packages/shot-editor/src/creator-controls.css', '@flume/take-review/styles.css', '@flume/activity-review/styles.css', './workspace.css'], 'Do not test a stale or approximate CSS import order');
  const css = imports.map(specifier => specifier.startsWith('.') ? resolve(root, 'apps/web/src', specifier) : specifier);
  const fixturePath = join(native, 'creator-surfaces-fixture.tsx');
  const fixture = (await readFile(fixturePath, 'utf8')).replace('/* __ACTUAL_ENTRY_CSS__ */', css.map(p => `import ${JSON.stringify(p)};`).join('\n'));
  const result = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: native, sourcefile: fixturePath, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'fixture.js'), format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, metafile: true });
  await writeFile(join(scratch, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self';connect-src 'none'"><title>Owned creator surface regression fixture</title><link rel="stylesheet" href="fixture.css"><style>body{margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  const diagram = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#28343a"/><rect x="${w * .35}" y="${h * .2}" width="${w * .3}" height="${h * .6}" fill="#19272e"/><path d="M${w / 2} 0V${h}" stroke="#ee8b82" stroke-width="10"/><text x="${w / 2}" y="${h * .92}" text-anchor="middle" font-size="${w / 20}" fill="#f4f1ec">OWNED FIXTURE</text></svg>`;
  await writeFile(join(scratch, 'first.svg'), diagram(400, 1200));
  await writeFile(join(scratch, 'last.svg'), diagram(1600, 400));
  const inputs = {};
  for (const file of Object.keys(result.metafile.inputs)) if (!file.includes('<stdin>')) inputs[file] = sha(await readFile(resolve(root, file)));
  const artifacts = {};
  for (const file of ['fixture.js', 'fixture.css', 'index.html', 'first.svg', 'last.svg']) artifacts[file] = sha(await readFile(join(scratch, file)));
  await writeFile(join(evidence, 'build-identity.json'), JSON.stringify({ root, cssImportOrder: imports, resolvedImports: css, mainSha256: sha(main), fixtureSha256: sha(await readFile(fixturePath)), inputs, artifacts }, null, 2));
  await writeFile(join(evidence, 'build-metafile.json'), JSON.stringify(result.metafile, null, 2));
  // Keep exact built CSS for source-rule reconciliation without renderer bundles.
  await writeFile(join(evidence, 'computed-source.css'), await readFile(join(scratch, 'fixture.css')));
  child = spawn(electron, [join(native, 'creator-surfaces-electron.cjs'), scratch, evidence], { env: { HOME: scratch, TMPDIR: scratch, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
  [code, signal] = await new Promise((accept, reject) => { child.once('exit', (c, s) => accept([c, s])); child.once('error', reject); });
  report = JSON.parse(await readFile(join(evidence, 'native-report.json'), 'utf8'));
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)); }
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(evidence, 'process.log'), log);
  await writeFile(join(evidence, 'process.json'), JSON.stringify({ code, signal, childPid: child?.pid, scratchRemovedAfterChildExit: true }, null, 2));
}
console.log(JSON.stringify({ code, success: report.success, checks: report.checks, errors: report.errors, cleanup: report.cleanup }, null, 2));
assert.equal(code, 0, 'Owned Chromium surface checks must pass; see preserved report');
assert.equal(report.success, true);
